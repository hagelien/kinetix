#!/usr/bin/env node
/**
 * PubMed MCP server over stdio — the same seven tools `api/mcp.ts` serves over
 * HTTP, run as a local process.
 *
 *   npm run mcp:stdio
 *   npx tsx scripts/pubmed-mcp-stdio.ts
 *
 * Point a client's MCP config at that command (see `docs/pubmed-mcp.md`).
 * Prefer this wherever the client can launch a command: it skips the network
 * hop and the serverless cold start, and it spends the caller's own NCBI rate
 * budget rather than contending for the deployment's shared one.
 *
 * No bearer token: the client owns the process and nothing is listening on a
 * port. `MCP_BEARER_TOKEN` guards the HTTP route precisely because that one is
 * reachable by anyone.
 */

import { serveStdio } from '../api/_lib/mcp-stdio.js';
import { createPubMedMcpServer } from '../api/_lib/mcp-pubmed-server.js';

// stderr only — stdout is the JSON-RPC stream (see api/_lib/mcp-stdio.ts).
const warn = (message: string): void => {
  process.stderr.write(`[kinetix-pubmed] ${message}\n`);
};

if (!process.env.NCBI_API_KEY) {
  warn(
    'NCBI_API_KEY is not set; throttling to ~3 requests/second. A free key ' +
      'raises the ceiling to 10/s (https://account.ncbi.nlm.nih.gov/settings/).',
  );
}
if (!process.env.NCBI_TOOL_EMAIL) {
  warn(
    'NCBI_TOOL_EMAIL is not set; NCBI asks that clients identify themselves ' +
      'so they can make contact before blocking a misbehaving one.',
  );
}

await serveStdio({
  server: createPubMedMcpServer(),
  input: process.stdin,
  output: process.stdout,
  onDiagnostic: warn,
});
