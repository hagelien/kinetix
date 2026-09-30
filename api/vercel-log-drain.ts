/**
 * Vercel Log Drain receiver (runtime errors).
 *
 * Vercel streams every log line for the project here (a firehose). We keep
 * only error-level entries, dedupe them, and file a GitHub `auto-fix` issue
 * via reportError(). This catches platform-level failures the app cannot —
 * timeouts, OOM, cold-start/import crashes — alongside the structured
 * `KINETIX_ERROR` lines emitted by withErrorHandling (api/_lib/response.ts).
 *
 * NOT wrapped in withErrorHandling: that helper emits the KINETIX_ERROR
 * marker, which would loop straight back through this drain. We also drop
 * any entry originating from the drain/webhook routes themselves
 * (loop-guard) and always answer fast so Vercel doesn't retry-storm.
 *
 * Configure via the Add-Drain screen → Custom Endpoint pointing at
 * `/api/vercel-log-drain`; copy its signature secret into
 * `VERCEL_LOG_DRAIN_SECRET`. See agents/autofix-setup.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './_lib/validate.js';
import { json } from './_lib/response.js';
import {
  verifyVercelSignature,
  fingerprint,
  reportError,
  ERROR_LOG_MARKER,
} from './_lib/autofix-issues.js';

const SELF_PATHS = ['/api/vercel-log-drain', '/api/vercel-deploy-hook'];
const MAX_DRAIN_BYTES = 5 * 1024 * 1024;

interface DrainEntry {
  message?: string;
  level?: string;
  source?: string;
  path?: string;
  timestamp?: number | string;
  statusCode?: number;
  proxy?: { statusCode?: number; path?: string };
  deploymentId?: string;
  requestId?: string;
}

interface StructuredError {
  route?: unknown;
  message?: string;
  stack?: string;
  cause?: unknown;
  category?: unknown;
}

/**
 * Signatures of an infrastructure / credential outage (database unreachable,
 * bad DATABASE_URL credentials, connection exhaustion) as they appear in raw
 * log text. Used as a fallback for platform-level log lines that never passed
 * through the withErrorHandling choke point and so carry no `category` field.
 */
const INFRA_ERROR_PATTERN =
  /password authentication failed|Error connecting to database|Error getting auth token|remaining connection slots|too many (?:clients|connections)|Server error \(HTTP status 5\d\d\)/i;

/**
 * Whether a drain entry represents an infrastructure / credential outage rather
 * than an application bug. These are not code-fixable — a fix agent cannot
 * rotate a Neon password — and a credential outage would otherwise storm the
 * tracker with one issue per affected route, so we skip filing the auto-fix
 * issue entirely.
 *
 * The structured KINETIX_ERROR payload carries `category:'infrastructure'` (set
 * in api/_lib/response.ts when the DB is unavailable); the message pattern is a
 * fallback for platform-level log lines emitted outside that choke point.
 */
export function isInfrastructureEntry(e: DrainEntry): boolean {
  const message = e.message ?? '';
  const markerAt = message.indexOf(ERROR_LOG_MARKER);
  if (markerAt >= 0) {
    try {
      const parsed = JSON.parse(
        message.slice(markerAt + ERROR_LOG_MARKER.length).trim(),
      ) as StructuredError;
      if (parsed.category === 'infrastructure') return true;
      const causeText =
        typeof parsed.cause === 'string'
          ? parsed.cause
          : JSON.stringify(parsed.cause ?? '');
      return INFRA_ERROR_PATTERN.test(
        `${parsed.message ?? ''}\n${causeText}\n${parsed.stack ?? ''}`,
      );
    } catch {
      // Marker present but payload wasn't JSON — fall through to the raw line.
    }
  }
  return INFRA_ERROR_PATTERN.test(message);
}

function parseEntries(raw: string): DrainEntry[] {
  const data = JSON.parse(raw) as unknown;
  if (Array.isArray(data)) return data as DrainEntry[];
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { logs?: unknown }).logs)
  ) {
    return (data as { logs: DrainEntry[] }).logs;
  }
  return [data as DrainEntry];
}

function entryPath(e: DrainEntry): string {
  return String(e.path ?? e.proxy?.path ?? '');
}

function isError(e: DrainEntry): boolean {
  if (typeof e.message === 'string' && e.message.includes(ERROR_LOG_MARKER))
    return true;
  if (e.level === 'error' || e.level === 'fatal') return true;
  const status = e.statusCode ?? e.proxy?.statusCode;
  return typeof status === 'number' && status >= 500;
}

function entryTimestamp(e: DrainEntry): string {
  if (typeof e.timestamp === 'number' && Number.isFinite(e.timestamp))
    return String(e.timestamp);
  if (typeof e.timestamp === 'string' && e.timestamp.trim())
    return e.timestamp.trim();
  return '';
}

/**
 * Prevent triple-backtick sequences from breaking out of Markdown code fences
 * in GitHub issue bodies. Replace any run of 3+ backticks with two backticks
 * so the text stays inside the fence without altering its readability.
 */
function escapeCodeFence(text: string): string {
  return text.replace(/`{3,}/g, '``');
}

function coerceRoute(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined;
  const trimmed = route.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Strip the query string from a URL path so that attacker-controlled query
 * parameters don't appear in GitHub issue titles or bodies. The path alone
 * (e.g. `/api/drugs`) is sufficient for routing the auto-fix agent to the
 * right handler; query values add no debugging value and widen the injection
 * surface for both prompt-injection and Markdown-injection attacks.
 */
function stripQueryString(route: string): string {
  const q = route.indexOf('?');
  return q === -1 ? route : route.slice(0, q);
}

const ROUTE_SELECTOR_ALLOWLIST: Record<
  string,
  Partial<Record<'action' | 'resource', ReadonlySet<string>>>
> = {
  '/api/auth': {
    action: new Set(['me', 'logout']),
  },
  '/api/admin': {
    action: new Set(['issue-token', 'revoke-token', 'set-role', 'transition']),
    resource: new Set([
      'users',
      'categories',
      'allowed-domains',
      'allowed-emails',
      'groups',
      'agents',
      'agent-hook-runs',
    ]),
  },
};

function safeQueryValue(
  base: string,
  key: 'action' | 'resource',
  value: string | null,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const allowedValues = ROUTE_SELECTOR_ALLOWLIST[base]?.[key];
  return allowedValues?.has(trimmed) ? trimmed : undefined;
}

function routeWithSafeContext(route: string): string {
  const base = stripQueryString(route);
  const q = route.indexOf('?');
  if (q === -1) return base;

  const query = route.slice(q + 1).split('#', 1)[0];
  const params = new URLSearchParams(query);
  const safePairs = [
    ['action', safeQueryValue(base, 'action', params.get('action'))],
    ['resource', safeQueryValue(base, 'resource', params.get('resource'))],
  ].filter((pair): pair is [string, string] => pair[1] !== undefined);

  return safePairs.length
    ? `${base}?${safePairs.map(([key, value]) => `${key}=${value}`).join('&')}`
    : base;
}

export function toReport(e: DrainEntry) {
  const message = e.message ?? '';
  let route = entryPath(e) || 'unknown';
  let detail = message;

  const markerAt = message.indexOf(ERROR_LOG_MARKER);
  if (markerAt >= 0) {
    try {
      const parsed = JSON.parse(
        message.slice(markerAt + ERROR_LOG_MARKER.length).trim(),
      ) as StructuredError;
      route = coerceRoute(parsed.route) ?? route;
      detail = [
        parsed.message ?? '',
        parsed.stack ?? '',
        parsed.cause !== undefined
          ? `cause: ${JSON.stringify(parsed.cause)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    } catch {
      // Marker present but payload wasn't JSON — fall back to the raw line.
    }
  }

  // Query values are attacker-controlled. Keep only known route selectors that
  // help triage shared endpoints, and drop everything else.
  const routeForDisplay = routeWithSafeContext(route);

  const firstLine = (detail.split('\n')[0] ?? '').slice(0, 120);
  const title =
    `[auto-fix] Runtime error in ${routeForDisplay}: ${firstLine}`.slice(
      0,
      200,
    );
  const body = [
    '**Source:** runtime (Vercel log drain)',
    `**Route:** \`${routeForDisplay}\``,
    e.deploymentId ? `**Deployment:** \`${e.deploymentId}\`` : '',
    e.requestId ? `**Request:** \`${e.requestId}\`` : '',
    entryTimestamp(e) ? `**Timestamp:** \`${entryTimestamp(e)}\`` : '',
    '',
    '```',
    escapeCodeFence(detail.slice(0, 6000)),
    '```',
    '',
    '_Pull fuller logs via the Vercel MCP `get_runtime_logs` tool using the deployment id + timestamp above._',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    source: 'runtime' as const,
    title,
    // Fingerprint on the sanitized route context so shared endpoints can keep
    // action/resource-specific issues without indexing arbitrary query input.
    fingerprint: fingerprint(['runtime', routeForDisplay, firstLine]),
    body,
  };
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    const secret = process.env.VERCEL_LOG_DRAIN_SECRET;
    if (!secret) {
      json(res, 503, { error: 'Log drain not configured' });
      return;
    }

    const raw = await readBody(req, { maxBytes: MAX_DRAIN_BYTES });
    const sig = req.headers['x-vercel-signature'];
    if (
      !verifyVercelSignature(raw, Array.isArray(sig) ? sig[0] : sig, secret)
    ) {
      json(res, 401, { error: 'Invalid signature' });
      return;
    }

    for (const entry of parseEntries(raw)) {
      if (!isError(entry)) continue;
      if (SELF_PATHS.some((p) => entryPath(entry).startsWith(p))) continue; // loop-guard
      // Infrastructure / credential outages aren't code-fixable and would
      // storm the tracker during an incident — log-only, don't file an issue.
      if (isInfrastructureEntry(entry)) continue;
      await reportError(toReport(entry));
    }

    json(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autofix] log-drain handler error: ${message}`);
    // Answer 200 so Vercel doesn't retry-storm — we've logged locally.
    if (!res.headersSent) json(res, 200, { ok: false });
  }
}
