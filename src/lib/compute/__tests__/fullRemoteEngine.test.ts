import { describe, it, expect, vi } from "vitest";
import { FullRemoteEngine } from "../fullRemoteEngine";
import {
  ComputeError,
  FULL_COMPUTE_DISABLED_ERROR,
  type SimulationInput,
} from "../types";

const SIM_INPUT: SimulationInput = {
  modelId: "ethanol-zero-order-v0",
  analyte: "ethanol",
  matrix: "whole_blood",
  route: "oral",
  parameters: {
    halfLife: { type: "fixed", value: 4 },
    vd: { type: "fixed", value: 0.6 },
    f: { type: "fixed", value: 1 },
  },
  dose: { value: 200, unit: "mg" },
  timeRangeHours: { start: 0, end: 6, steps: 12 },
  drawCount: 100,
  seed: 7,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FullRemoteEngine", () => {
  it("surfaces FULL_COMPUTE_DISABLED when the server returns 501 with the matching code", async () => {
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(501, {
          error: FULL_COMPUTE_DISABLED_ERROR,
          message: "Full compute backend is not configured in this deployment.",
        }),
      ),
    );
    const engine = new FullRemoteEngine({
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await expect(engine.simulate(SIM_INPUT)).rejects.toThrow(ComputeError);
    try {
      await engine.simulate(SIM_INPUT);
    } catch (err) {
      expect((err as ComputeError).code).toBe(FULL_COMPUTE_DISABLED_ERROR);
    }
    expect(fakeFetch).toHaveBeenCalled();
  });

  it("parses a successful simulate response through the shared schema", async () => {
    const sample = {
      engine: "full-remote",
      modelId: "ethanol-zero-order-v0",
      timeSeries: [{ t: 0, p05: 0, p25: 0, median: 0, p75: 0, p95: 0 }],
      unit: "mg/L",
      diagnostics: {
        engine: "full-remote",
        method: "ode-solver",
        sampleCount: 4000,
        warnings: [],
      },
      assumptions: [],
      limitations: [],
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const manifest = {
      engine: { name: "kinelab", version: "1.2.3" },
      model: { id: SIM_INPUT.modelId, version: "2026.08" },
      parameters: { version: "4", hash: "parameters-sha256" },
      registry: { version: "8", hash: "registry-sha256" },
      solver: { name: "scipy", version: "1.14", settings: {} },
      seed: SIM_INPUT.seed,
      environment: {
        runtime: "python-3.13",
        architecture: "x86_64",
        image: "kinelab@sha256:abc",
      },
      startedAt: "2030-01-01T00:00:00.000Z",
      completedAt: "2030-01-01T00:00:01.000Z",
    };
    const fakeFetch = vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/start"))
        return Promise.resolve(
          jsonResponse(202, { jobId: "job-1", status: "queued" }),
        );
      if (path.includes("/status"))
        return Promise.resolve(
          jsonResponse(200, { jobId: "job-1", status: "succeeded" }),
        );
      return Promise.resolve(
        jsonResponse(200, { operation: "simulate", result: sample, manifest }),
      );
    });
    const engine = new FullRemoteEngine({
      fetch: fakeFetch as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    const result = await engine.simulate(SIM_INPUT);
    expect(result.engine).toBe("full-remote");
    expect(result.diagnostics.method).toBe("ode-solver");
    expect(result.runManifest?.registry.hash).toBe("registry-sha256");
  });

  it("passes a non-disabled 501 error code through verbatim", async () => {
    // /api/jobs/start returns FULL_COMPUTE_NOT_IMPLEMENTED when full mode is
    // configured but the proxy is not yet wired up (phase 3 of the integration).
    // The engine must not collapse that into a generic "unavailable" code or
    // callers can no longer distinguish deployment states.
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(501, {
          error: "FULL_COMPUTE_NOT_IMPLEMENTED",
          message: "Backend configured but proxy implementation pending.",
        }),
      ),
    );
    const engine = new FullRemoteEngine({
      fetch: fakeFetch as unknown as typeof fetch,
    });
    try {
      await engine.simulate(SIM_INPUT);
      throw new Error("expected ComputeError");
    } catch (err) {
      expect(err).toBeInstanceOf(ComputeError);
      expect((err as ComputeError).code).toBe("FULL_COMPUTE_NOT_IMPLEMENTED");
    }
  });

  it("rejects malformed full-mode responses (schema guard)", async () => {
    const malformed = { engine: "full-remote", modelId: "bad" };
    const fakeFetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, malformed)),
    );
    const engine = new FullRemoteEngine({
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(engine.simulate(SIM_INPUT)).rejects.toThrow();
  });
});
