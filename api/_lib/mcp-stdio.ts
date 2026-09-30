/**
 * MCP stdio transport — the local counterpart to the HTTP shell in
 * `api/mcp.ts`.
 *
 * Framing is newline-delimited JSON, one JSON-RPC message per line (this is
 * MCP's stdio transport, not LSP's `Content-Length` framing). Two rules matter
 * and both are load-bearing:
 *
 *  1. **stdout carries JSON-RPC and nothing else.** A stray `console.log` puts
 *     a non-message line on the stream and the client's parser desynchronises.
 *     Diagnostics go to stderr, which the transport ignores by design.
 *  2. **Responses are serialised.** A single 30 KB full-text response written
 *     concurrently with another can interleave on a pipe and corrupt both. NCBI
 *     throttling already serialises the real work, so ordering them costs
 *     nothing.
 *
 * Kept separate from the entry-point script so it can be tested against
 * in-memory streams rather than a spawned process.
 */

import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { JSON_RPC_ERRORS, type McpServer } from './mcp.js';

export interface ServeStdioOptions {
  server: McpServer;
  input: Readable;
  output: Writable;
  /** Diagnostics sink. Never stdout — see rule 1 above. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Serve until `input` ends. Resolves when the stream closes, which is how an
 * MCP client shuts a stdio server down.
 */
export async function serveStdio(options: ServeStdioOptions): Promise<void> {
  const { server, input, output, onDiagnostic } = options;

  const write = (payload: unknown): void => {
    output.write(`${JSON.stringify(payload)}\n`);
  };

  // Every line's work is appended to this chain, so responses leave in the
  // order their requests arrived and never interleave mid-write.
  let queue: Promise<void> = Promise.resolve();

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.parseError, message: 'Parse error' },
      });
      return;
    }

    // Batches were removed in protocol 2025-06-18; older clients still send
    // them, and the HTTP shell accepts them too.
    if (Array.isArray(parsed)) {
      // `[]` is an invalid request, not an all-notification batch. Staying
      // silent here would hang the client, and the HTTP transport already
      // answers this payload with the same error.
      if (parsed.length === 0) {
        write({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JSON_RPC_ERRORS.invalidRequest,
            message: 'Invalid Request: empty batch',
          },
        });
        return;
      }

      const responses = [];
      for (const message of parsed) {
        const response = await server.handle(message);
        if (response) responses.push(response);
      }
      // An all-notification batch gets no reply at all, matching the 202 the
      // HTTP transport returns for the same payload.
      if (responses.length > 0) write(responses);
      return;
    }

    const response = await server.handle(parsed);
    if (response) write(response);
  };

  const readline = createInterface({ input, crlfDelay: Infinity });

  readline.on('line', (line) => {
    queue = queue.then(() =>
      handleLine(line).catch((err: unknown) => {
        // A throw here is a transport-level bug, not a tool failure — tool
        // errors are already returned as results. Report it and keep serving
        // rather than tearing down the client's session.
        onDiagnostic?.(
          `stdio handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    );
  });

  await new Promise<void>((resolve) => {
    readline.on('close', () => resolve());
  });

  // Let in-flight work finish writing before the caller exits the process.
  await queue;
}
