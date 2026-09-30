/**
 * The PubMed MCP server itself, independent of how it is reached.
 *
 * Both transports build from here — `api/mcp.ts` over HTTP and
 * `scripts/pubmed-mcp-stdio.ts` over stdio — so the tool set, the evidence
 * instructions and the advertised identity cannot drift apart between them. A
 * client should not be able to tell which transport it is talking to except by
 * the URL or command it used.
 */

import { McpServer } from './mcp.js';
import {
  PUBMED_SERVER_INSTRUCTIONS,
  PUBMED_TOOLS,
} from './mcp-pubmed-tools.js';

export const PUBMED_SERVER_INFO = {
  name: 'kinetix-pubmed',
  title: 'Kinetix PubMed',
  version: '1.0.0',
} as const;

export function createPubMedMcpServer(): McpServer {
  return new McpServer({
    serverInfo: { ...PUBMED_SERVER_INFO },
    instructions: PUBMED_SERVER_INSTRUCTIONS,
    tools: PUBMED_TOOLS,
  });
}
