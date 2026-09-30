import type { ServerResponse } from "node:http";
import { z } from "zod";
import { json, noStoreHeaders } from "./response.js";
import { remoteRunManifestSchema } from "../../src/lib/compute/types.js";

export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const FULL_COMPUTE_PROTOCOL_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export const runManifestSchema = remoteRunManifestSchema;

export const jobStatusSchema = z
  .object({
    jobId: z.string().regex(JOB_ID_PATTERN),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .strict();

export function isFullComputeEnabled(): boolean {
  return (
    process.env.KINELAB_FULL_COMPUTE_ENABLED === "true" &&
    process.env.KINELAB_FULL_COMPUTE_SECURITY_REVIEWED === "true" &&
    process.env.KINELAB_FULL_COMPUTE_BENCHMARK_PARITY === "true" &&
    Boolean(process.env.KINELAB_FULL_COMPUTE_OPERATIONAL_OWNER?.trim())
  );
}
export function fullComputeApiUrl(): string | null {
  const value = process.env.KINELAB_FULL_COMPUTE_API_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && url.protocol === "http:")
      ? url.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}
export function respondFullComputeDisabled(res: ServerResponse): void {
  json(
    res,
    501,
    {
      error: "FULL_COMPUTE_DISABLED",
      message: "Full compute backend is not configured in this deployment.",
    },
    { headers: noStoreHeaders() },
  );
}

export class FullComputeProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function proxyFullCompute(
  path: string,
  userId: number,
  init: RequestInit = {},
): Promise<{ body: unknown; status: number }> {
  const base = fullComputeApiUrl();
  if (!base)
    throw new FullComputeProxyError(
      503,
      "FULL_COMPUTE_CONFIGURATION_ERROR",
      "Full compute backend configuration is invalid.",
    );
  const token = process.env.KINELAB_FULL_COMPUTE_API_TOKEN;
  if (!token)
    throw new FullComputeProxyError(
      503,
      "FULL_COMPUTE_CONFIGURATION_ERROR",
      "Full compute backend credentials are unavailable.",
    );
  const version =
    process.env.KINELAB_FULL_COMPUTE_API_VERSION ??
    FULL_COMPUTE_PROTOCOL_VERSION;
  const timeout =
    Number(process.env.KINELAB_FULL_COMPUTE_REQUEST_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "KineLab-API-Version": version,
        "X-Kinetix-User-ID": String(userId),
        ...init.headers,
      },
    });
  } catch (cause) {
    const timedOut =
      cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw new FullComputeProxyError(
      timedOut ? 504 : 502,
      timedOut
        ? "FULL_COMPUTE_UPSTREAM_TIMEOUT"
        : "FULL_COMPUTE_UPSTREAM_UNAVAILABLE",
      timedOut
        ? "Full compute backend timed out."
        : "Full compute backend is unavailable.",
    );
  }
  const declaredVersion = response.headers.get("kinelab-api-version");
  if (declaredVersion !== version)
    throw new FullComputeProxyError(
      502,
      "FULL_COMPUTE_VERSION_MISMATCH",
      "Full compute backend protocol version is incompatible.",
    );
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES)
    throw new FullComputeProxyError(
      502,
      "FULL_COMPUTE_INVALID_RESPONSE",
      "Full compute backend response is too large.",
    );
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new FullComputeProxyError(
      502,
      "FULL_COMPUTE_INVALID_RESPONSE",
      "Full compute backend returned invalid JSON.",
    );
  }
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .safeParse(body);
    const upstreamCode = parsed.success
      ? (parsed.data.code ?? parsed.data.error)
      : undefined;
    const stable =
      response.status === 404
        ? "FULL_COMPUTE_JOB_NOT_FOUND"
        : response.status === 409
          ? "FULL_COMPUTE_JOB_CONFLICT"
          : response.status === 429
            ? "FULL_COMPUTE_RATE_LIMITED"
            : response.status >= 500
              ? "FULL_COMPUTE_UPSTREAM_ERROR"
              : "FULL_COMPUTE_REQUEST_REJECTED";
    throw new FullComputeProxyError(
      response.status === 429
        ? 429
        : response.status >= 500
          ? 502
          : response.status,
      stable,
      parsed.success
        ? (parsed.data.message ??
            upstreamCode ??
            "Full compute request failed.")
        : "Full compute request failed.",
    );
  }
  return { body, status: response.status };
}

export function respondProxyError(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof FullComputeProxyError)) return false;
  json(
    res,
    err.status,
    { error: err.code, message: err.message },
    { headers: noStoreHeaders() },
  );
  return true;
}
