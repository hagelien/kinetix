import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getUserFromRequest } from "../_lib/auth.js";
import {
  isFullComputeEnabled,
  JOB_ID_PATTERN,
  proxyFullCompute,
  respondFullComputeDisabled,
  respondProxyError,
  runManifestSchema,
} from "../_lib/full-compute.js";
import {
  error,
  json,
  noStoreHeaders,
  withErrorHandling,
} from "../_lib/response.js";
import {
  inferenceResultSchema,
  reportResultSchema,
  scenarioComparisonResultSchema,
  simulationResultSchema,
} from "../../src/lib/compute/types.js";
const resultSchemas = {
  simulate: simulationResultSchema,
  infer: inferenceResultSchema,
  compareScenarios: scenarioComparisonResultSchema,
  generateReport: reportResultSchema,
} as const;
const envelopeSchema = z
  .object({
    operation: z.enum([
      "simulate",
      "infer",
      "compareScenarios",
      "generateReport",
    ]),
    result: z.unknown(),
    manifest: runManifestSchema,
  })
  .strict();
export default withErrorHandling(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") return error(res, 405, "Method not allowed");
    const auth = await getUserFromRequest(req);
    if (!auth) return error(res, 401, "Authentication required");
    if (!isFullComputeEnabled()) return respondFullComputeDisabled(res);
    const jobId = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    ).searchParams.get("jobId");
    if (!jobId || !JOB_ID_PATTERN.test(jobId))
      return error(res, 400, "Invalid jobId query parameter");
    try {
      const upstream = await proxyFullCompute(
        `/jobs/${encodeURIComponent(jobId)}/result`,
        auth.userId,
      );
      const envelope = envelopeSchema.safeParse(upstream.body);
      if (!envelope.success)
        return json(
          res,
          502,
          {
            error: "FULL_COMPUTE_INVALID_RESPONSE",
            message: "Full compute backend returned invalid result provenance.",
          },
          { headers: noStoreHeaders() },
        );
      const result = resultSchemas[envelope.data.operation].safeParse(
        envelope.data.result,
      );
      if (!result.success || result.data.engine !== "full-remote")
        return json(
          res,
          502,
          {
            error: "FULL_COMPUTE_INVALID_RESPONSE",
            message: "Full compute backend returned an invalid result.",
          },
          { headers: noStoreHeaders() },
        );
      json(
        res,
        200,
        { ...envelope.data, result: result.data },
        { headers: noStoreHeaders() },
      );
    } catch (err) {
      if (!respondProxyError(res, err)) throw err;
    }
  },
);
