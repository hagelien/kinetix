/**
 * Minimal Model Context Protocol server core (JSON-RPC 2.0 over HTTP).
 *
 * Transport-agnostic: `api/mcp.ts` owns the HTTP shell (auth, CORS, method
 * dispatch) and hands single JSON-RPC messages to `McpServer.handle`.
 *
 * The server is deliberately **stateless** — no session ids, no server-initiated
 * streams, no subscriptions — because Vercel serverless functions do not keep
 * per-connection state between invocations. Every request carries everything
 * needed to answer it, which is exactly the subset of the spec that the
 * Streamable HTTP transport allows a server to implement.
 */

import { z, type ZodType } from 'zod';

/**
 * Protocol revisions we can speak, newest first. `initialize` echoes the
 * client's version when we support it and otherwise falls back to our newest,
 * which the spec permits (the client then decides whether to continue).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface ToolOutput {
  /** Machine-readable payload, returned as `structuredContent`. */
  structured: Record<string, unknown>;
  /** Text rendering for clients that only read content blocks. */
  text?: string;
}

export interface McpTool<Args = unknown> {
  name: string;
  title: string;
  description: string;
  schema: ZodType<Args>;
  /**
   * Hints for the client's UI and permission model. All of our tools are
   * read-only fetches against public NCBI endpoints.
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (args: Args) => Promise<ToolOutput>;
}

/**
 * A tool with its argument type erased, so tools with different argument
 * shapes can live in one registry. Produced by `defineTool`, which is the only
 * place that knows the concrete type.
 */
export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  annotations?: McpTool['annotations'];
  jsonSchema: Record<string, unknown>;
  safeParse: (
    input: unknown,
  ) => { success: true; data: unknown } | { success: false; issues: string[] };
  run: (args: unknown) => Promise<ToolOutput>;
}

export function defineTool<Args>(tool: McpTool<Args>): RegisteredTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations,
    jsonSchema: z.toJSONSchema(tool.schema, { io: 'input' }) as Record<
      string,
      unknown
    >,
    safeParse: (input) => {
      const result = tool.schema.safeParse(input);
      if (result.success) return { success: true, data: result.data };
      return {
        success: false,
        issues: result.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      };
    },
    // Safe: `run` is only reached through `safeParse`, which validated the
    // argument against this tool's own schema.
    run: (args) => tool.execute(args as Args),
  };
}

export interface McpServerOptions {
  serverInfo: { name: string; title: string; version: string };
  /** Shown to the model as usage guidance for the whole server. */
  instructions: string;
  tools: RegisteredTool[];
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function describeTool(tool: RegisteredTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.jsonSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

export class McpServer {
  private readonly tools: Map<string, RegisteredTool>;

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /**
   * Handle one JSON-RPC message. Returns `null` for notifications and
   * responses, which the transport answers with `202 Accepted` and no body.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null) {
      return fail(null, JSON_RPC_ERRORS.invalidRequest, 'Invalid Request');
    }

    const msg = message as {
      jsonrpc?: unknown;
      id?: string | number | null;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };

    // A client-to-server response (has result/error, no method) needs no reply.
    if (typeof msg.method !== 'string') {
      if ('result' in msg || 'error' in msg) return null;
      return fail(
        msg.id ?? null,
        JSON_RPC_ERRORS.invalidRequest,
        'Invalid Request: missing method',
      );
    }

    if (msg.jsonrpc !== '2.0') {
      return fail(
        msg.id ?? null,
        JSON_RPC_ERRORS.invalidRequest,
        'Invalid Request: jsonrpc must be "2.0"',
      );
    }

    // JSON-RPC identifies a notification by the *absence* of `id`, so test
    // membership rather than nullishness: an explicit `"id": null` is a
    // permitted (if discouraged) request id, and treating it as a notification
    // would leave the client waiting for a response that never comes.
    if (!('id' in msg)) {
      // Notifications never get a response, even for unknown methods.
      return null;
    }

    // JSON-RPC restricts an id to a string, a number, or null. Echoing back an
    // object or array — which the static type does not stop an untrusted client
    // sending — would break correlation for a client that matches on it.
    if (
      msg.id !== null &&
      typeof msg.id !== 'string' &&
      typeof msg.id !== 'number'
    ) {
      return fail(
        null,
        JSON_RPC_ERRORS.invalidRequest,
        'Invalid Request: id must be a string, a number, or null',
      );
    }

    const id = msg.id ?? null;

    switch (msg.method) {
      case 'initialize':
        return ok(id, this.initializeResult(msg.params));
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: this.options.tools.map(describeTool),
        });
      case 'tools/call':
        return this.callTool(id, msg.params);
      // Advertised nowhere in our capabilities, but clients probe for them;
      // an empty list is friendlier than a method-not-found error.
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return fail(
          id,
          JSON_RPC_ERRORS.methodNotFound,
          `Method not found: ${msg.method}`,
        );
    }
  }

  private initializeResult(params: unknown): Record<string, unknown> {
    const requested = (params as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.options.serverInfo,
      instructions: this.options.instructions,
    };
  }

  private async callTool(
    id: string | number | null,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    const call = params as { name?: unknown; arguments?: unknown } | undefined;
    if (typeof call?.name !== 'string') {
      return fail(
        id,
        JSON_RPC_ERRORS.invalidParams,
        'Invalid params: "name" is required',
      );
    }

    const tool = this.tools.get(call.name);
    if (!tool) {
      return fail(
        id,
        JSON_RPC_ERRORS.invalidParams,
        `Unknown tool: ${call.name}`,
      );
    }

    const parsed = tool.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return fail(
        id,
        JSON_RPC_ERRORS.invalidParams,
        `Invalid arguments for ${tool.name}: ${parsed.issues.join('; ')}`,
      );
    }

    try {
      const output = await tool.run(parsed.data);
      return ok(id, {
        content: [
          {
            type: 'text',
            text: output.text ?? JSON.stringify(output.structured, null, 2),
          },
        ],
        structuredContent: output.structured,
        isError: false,
      });
    } catch (err) {
      // Execution failures are reported *inside* the result so the model can
      // read the message and adapt, per the MCP tool-error convention. Only
      // protocol-level problems become JSON-RPC errors.
      const message = err instanceof Error ? err.message : String(err);
      return ok(id, {
        content: [{ type: 'text', text: `${tool.name} failed: ${message}` }],
        isError: true,
      });
    }
  }
}
