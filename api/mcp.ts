/**
 * Model Context Protocol endpoint — PubMed tools over Streamable HTTP.
 *
 * Point any MCP client at `https://<deployment>/api/mcp` with a bearer token:
 *   Codex CLI / ChatGPT desktop / Claude / IDE extensions all speak this.
 * Setup walkthrough: `docs/pubmed-mcp.md`.
 *
 * Stateless by design (see `_lib/mcp.ts`): no session ids are issued and no
 * server-initiated SSE stream is offered, so `GET` is refused and every `POST`
 * is answered with a single JSON response. That is a conforming subset of the
 * Streamable HTTP transport and the only shape that survives serverless
 * invocation boundaries.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { json, noStoreHeaders, withErrorHandling } from './_lib/response.js';
import { readBodyStream, RequestBodyTooLargeError } from './_lib/validate.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';
import { JSON_RPC_ERRORS } from './_lib/mcp.js';
import { createPubMedMcpServer } from './_lib/mcp-pubmed-server.js';
import { PUBMED_TOOLS } from './_lib/mcp-pubmed-tools.js';

/** JSON-RPC envelopes are small; anything larger is not a real MCP call. */
const MAX_BODY_BYTES = 256 * 1024;

/** Per-caller ceiling. NCBI politeness is enforced separately, per request. */
const RATE_LIMIT = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Messages accepted in one legacy JSON-RPC batch. Each message can dispatch a
 * tool call, so an uncapped batch would run hundreds of NCBI requests
 * sequentially inside a single serverless invocation. The cap bounds that, and
 * every message past the first is charged to the rate limiter besides.
 */
const MAX_BATCH_MESSAGES = 20;

// Shared with the stdio transport (scripts/pubmed-mcp-stdio.ts) so the two
// cannot advertise different tools or instructions.
const server = createPubMedMcpServer();

function corsHeaders(): Record<string, string> {
  return {
    // Every request must carry the bearer token, which a browser never
    // attaches on its own, so a wildcard origin grants no ambient authority.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; the length itself is not the
  // secret, so compare it first and only then in constant time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AuthOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string; code: string };

function authenticate(req: IncomingMessage): AuthOutcome {
  const expected = process.env.MCP_BEARER_TOKEN?.trim();
  if (!expected) {
    // Fail closed: an unconfigured deployment must not expose an open relay
    // against NCBI under this project's identity.
    return {
      ok: false,
      status: 503,
      message: 'MCP endpoint is not configured',
      code: 'mcp_not_configured',
    };
  }

  const provided = bearerToken(req);
  if (!provided || !tokensMatch(provided, expected)) {
    return {
      ok: false,
      status: 401,
      message: 'Missing or invalid bearer token',
      code: 'mcp_unauthorized',
    };
  }

  return { ok: true };
}

function rateLimitKey(req: IncomingMessage): string {
  const token = bearerToken(req);
  return token ? `token:${token}` : getClientAddressKey(req);
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const cors = corsHeaders();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');

  // Unauthenticated liveness probe, so a deployment can be verified without
  // handing the token to whoever is checking. Exposes no PubMed access.
  if (req.method === 'GET' && url.searchParams.has('health')) {
    json(
      res,
      200,
      {
        status: 'ok',
        transport: 'streamable-http',
        configured: Boolean(process.env.MCP_BEARER_TOKEN?.trim()),
        tools: PUBMED_TOOLS.length,
      },
      { headers: { ...cors, ...noStoreHeaders() } },
    );
    return;
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    const headers: Record<string, string> = { ...cors };
    if (auth.status === 401) {
      headers['WWW-Authenticate'] = 'Bearer realm="kinetix-mcp"';
    }
    json(
      res,
      auth.status,
      { error: auth.message, code: auth.code },
      { headers },
    );
    return;
  }

  // No session state to tear down; acknowledge and move on.
  if (req.method === 'DELETE') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(
      res,
      405,
      {
        error:
          'This MCP endpoint is stateless and does not offer a server-initiated ' +
          'stream. Send JSON-RPC messages with POST.',
        code: 'method_not_allowed',
      },
      { headers: { ...cors, Allow: 'POST, DELETE, OPTIONS' } },
    );
    return;
  }

  const limiterKey = rateLimitKey(req);
  const tooManyRequests = (retryAfterSeconds: number): void => {
    json(
      res,
      429,
      { error: 'Too many requests', code: 'rate_limited' },
      { headers: { ...cors, 'Retry-After': String(retryAfterSeconds) } },
    );
  };

  const limit = consumeRateLimit(
    'mcp',
    limiterKey,
    RATE_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limit.limited) {
    tooManyRequests(limit.retryAfterSeconds);
    return;
  }

  let raw: string;
  try {
    raw = await readBodyStream(req, { maxBytes: MAX_BODY_BYTES });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      json(
        res,
        413,
        { error: 'Request body too large', code: 'body_too_large' },
        { headers: cors },
      );
      return;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.parseError, message: 'Parse error' },
      },
      { headers: { ...cors, ...noStoreHeaders() } },
    );
    return;
  }

  // Batching was removed in protocol 2025-06-18 but older clients still send
  // arrays; handling both costs one branch.
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    json(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERRORS.invalidRequest,
          message: 'Invalid Request: empty batch',
        },
      },
      { headers: { ...cors, ...noStoreHeaders() } },
    );
    return;
  }

  if (messages.length > MAX_BATCH_MESSAGES) {
    json(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERRORS.invalidRequest,
          message:
            `Invalid Request: batch of ${messages.length} exceeds the ` +
            `${MAX_BATCH_MESSAGES}-message limit`,
        },
      },
      { headers: { ...cors, ...noStoreHeaders() } },
    );
    return;
  }

  // The request itself was already charged above; charge the rest of the batch
  // so a batch cannot dispatch N tool calls for the price of one.
  for (let i = 1; i < messages.length; i += 1) {
    const extra = consumeRateLimit(
      'mcp',
      limiterKey,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS,
    );
    if (extra.limited) {
      tooManyRequests(extra.retryAfterSeconds);
      return;
    }
  }

  const responses = [];
  for (const message of messages) {
    const response = await server.handle(message);
    if (response) responses.push(response);
  }

  // A payload of nothing but notifications gets an acknowledgement, no body.
  if (responses.length === 0) {
    res.writeHead(202, { ...cors, ...noStoreHeaders() });
    res.end();
    return;
  }

  json(
    res,
    200,
    Array.isArray(parsed) ? responses : responses[0],
    { headers: { ...cors, ...noStoreHeaders() } },
  );
});
