import { z } from "zod";
import { FULL_CAPABILITIES } from "./capabilities";
import {
  type ComputeCapability,
  type ComputeEngine,
  type EngineId,
  type SimulationInput,
  type SimulationResult,
  type InferenceInput,
  type InferenceResult,
  type ScenarioComparisonInput,
  type ScenarioComparisonResult,
  type ReportInput,
  type ReportResult,
  ComputeError,
  FULL_COMPUTE_DISABLED_ERROR,
  simulationResultSchema,
  inferenceResultSchema,
  scenarioComparisonResultSchema,
  reportResultSchema,
  remoteRunManifestSchema,
} from "./types";

const manifestSchema = remoteRunManifestSchema;
const receiptSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(["queued", "running"]),
});
const statusSchema = z.object({
  jobId: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const envelopeSchema = z.object({
  operation: z.string(),
  result: z.unknown(),
  manifest: manifestSchema,
});
type Operation = "simulate" | "infer" | "compareScenarios" | "generateReport";

export interface FullRemoteEngineOptions {
  apiBase?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}
export class FullRemoteEngine implements ComputeEngine {
  readonly id: EngineId = "full-remote";
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  constructor(opts: FullRemoteEngineOptions = {}) {
    this.apiBase = opts.apiBase ?? "/api/jobs";
    this.doFetch =
      opts.fetch ??
      (typeof fetch !== "undefined"
        ? fetch.bind(globalThis)
        : notConfiguredFetch);
    this.pollIntervalMs = opts.pollIntervalMs ?? 750;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }
  getCapabilities(): ComputeCapability[] {
    return [...FULL_CAPABILITIES];
  }
  async simulate(input: SimulationInput): Promise<SimulationResult> {
    return simulationResultSchema.parse(await this.runJob("simulate", input));
  }
  async infer(input: InferenceInput): Promise<InferenceResult> {
    return inferenceResultSchema.parse(await this.runJob("infer", input));
  }
  async compareScenarios(
    input: ScenarioComparisonInput,
  ): Promise<ScenarioComparisonResult> {
    return scenarioComparisonResultSchema.parse(
      await this.runJob("compareScenarios", input),
    );
  }
  async generateReport(input: ReportInput): Promise<ReportResult> {
    return reportResultSchema.parse(await this.runJob("generateReport", input));
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.apiBase}${path}`, {
        credentials: "same-origin",
        ...init,
      });
    } catch (cause) {
      if (cause instanceof ComputeError) throw cause;
      throw new ComputeError(
        "FULL_COMPUTE_NETWORK_ERROR",
        cause instanceof Error ? cause.message : "Full compute request failed.",
      );
    }
    const body = await safeJson(response);
    if (!response.ok)
      throw new ComputeError(
        body?.error ?? body?.code ?? "FULL_COMPUTE_REQUEST_FAILED",
        body?.message ?? `Full compute request failed: ${response.status}`,
      );
    return body;
  }
  private async runJob(
    operation: Operation,
    payload: unknown,
  ): Promise<unknown> {
    const receipt = receiptSchema.safeParse(
      await this.request("/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, payload }),
      }),
    );
    if (!receipt.success)
      throw new ComputeError(
        "FULL_COMPUTE_INVALID_RESPONSE",
        "Full compute service returned an invalid job receipt.",
      );
    const { jobId } = receipt.data;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const status = statusSchema.safeParse(
        await this.request(`/status?jobId=${encodeURIComponent(jobId)}`),
      );
      if (!status.success || status.data.jobId !== jobId)
        throw new ComputeError(
          "FULL_COMPUTE_INVALID_RESPONSE",
          "Full compute service returned invalid job status.",
        );
      if (status.data.status === "succeeded") {
        const envelope = envelopeSchema.safeParse(
          await this.request(`/result?jobId=${encodeURIComponent(jobId)}`),
        );
        if (!envelope.success || envelope.data.operation !== operation)
          throw new ComputeError(
            "FULL_COMPUTE_INVALID_RESPONSE",
            "Full compute result or provenance is invalid.",
          );
        const modelId = (payload as { modelId?: unknown }).modelId;
        const seed = (payload as { seed?: unknown }).seed;
        if (
          typeof modelId === "string" &&
          envelope.data.manifest.model.id !== modelId
        )
          throw new ComputeError(
            "FULL_COMPUTE_PROVENANCE_MISMATCH",
            "Result model provenance does not match the request.",
          );
        if (typeof seed === "number" && envelope.data.manifest.seed !== seed)
          throw new ComputeError(
            "FULL_COMPUTE_PROVENANCE_MISMATCH",
            "Result seed provenance does not match the request.",
          );
        return {
          ...(envelope.data.result as object),
          runManifest: envelope.data.manifest,
        };
      }
      if (status.data.status === "failed")
        throw new ComputeError(
          status.data.error?.code ?? "FULL_COMPUTE_JOB_FAILED",
          status.data.error?.message ?? "Full compute job failed.",
        );
      if (status.data.status === "cancelled")
        throw new ComputeError(
          "FULL_COMPUTE_JOB_CANCELLED",
          "Full compute job was cancelled.",
        );
      await delay(
        Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())),
      );
    }
    try {
      await this.request(`/status?jobId=${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      });
    } catch {
      /* timeout remains the stable caller-visible outcome */
    }
    throw new ComputeError(
      "FULL_COMPUTE_JOB_TIMEOUT",
      "Full compute job exceeded its client timeout and was cancelled.",
    );
  }
}
async function safeJson(
  response: Response,
): Promise<Record<string, any> | null> {
  try {
    return (await response.json()) as Record<string, any>;
  } catch {
    return null;
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const notConfiguredFetch: typeof fetch = () => {
  throw new ComputeError(
    FULL_COMPUTE_DISABLED_ERROR,
    "Full compute backend cannot be reached: no fetch implementation available in this environment.",
  );
};
