import type { IncomingMessage } from "node:http";
import { type ZodType } from "zod";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class CrossOriginRequestError extends Error {
  constructor() {
    super("Cross-origin API request rejected");
    this.name = "CrossOriginRequestError";
  }
}

interface ReadBodyOptions {
  maxBytes?: number;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  return host.split(":")[0] ?? host;
}

function isLocalHost(host: string): boolean {
  const normalized = hostWithoutPort(host).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function forwardedProtocol(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  if (first === "http" || first === "https") return `${first}:`;
  return null;
}

export function assertSameOrigin(req: IncomingMessage): void {
  const origin = headerValue(req.headers.origin);
  if (!origin) return;

  const host = headerValue(req.headers.host);
  if (!host) throw new CrossOriginRequestError();

  try {
    const parsedOrigin = new URL(origin);
    const normalizedHost = host.toLowerCase();
    if (parsedOrigin.host.toLowerCase() !== normalizedHost) {
      throw new CrossOriginRequestError();
    }

    const protocol =
      forwardedProtocol(headerValue(req.headers["x-forwarded-proto"])) ??
      (isLocalHost(host) ? null : "https:");
    if (!protocol || parsedOrigin.protocol === protocol) return;
  } catch {
    // Treat malformed or opaque origins (for example "null") as untrusted.
  }

  throw new CrossOriginRequestError();
}

/**
 * Read a request body with the size cap but WITHOUT the same-origin guard.
 *
 * Only for endpoints that authenticate every request with a bearer credential
 * a browser will not attach automatically (see `api/mcp.ts`): there is no
 * ambient authority to abuse, so the CSRF guard has nothing to protect and
 * would instead reject legitimate cross-origin MCP clients. Everything that
 * relies on the auth cookie must keep using `readBody`.
 */
export function readBodyStream(
  req: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    return Promise.reject(new RequestBodyTooLargeError(maxBytes));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejectOnce(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString());
    };

    const onError = (err: Error) => rejectOnce(err);
    const onAborted = () => rejectOnce(new Error("Request aborted"));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

export function readBody(
  req: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<string> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    return Promise.reject(err);
  }

  return readBodyStream(req, options);
}

export async function parseAndValidate<T>(
  req: IncomingMessage,
  schema: ZodType<T>,
): Promise<{ data: T } | { error: string }> {
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      );
      return { error: issues.join(", ") };
    }
    return { data: result.data };
  } catch (err) {
    if (
      err instanceof RequestBodyTooLargeError ||
      err instanceof CrossOriginRequestError
    ) {
      throw err;
    }
    return { error: "Invalid JSON body" };
  }
}
