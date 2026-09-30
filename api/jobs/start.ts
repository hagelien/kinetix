import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getUserFromRequest } from "../_lib/auth.js";
import {
  isFullComputeEnabled,
  jobStatusSchema,
  proxyFullCompute,
  respondFullComputeDisabled,
  respondProxyError,
} from "../_lib/full-compute.js";
import {
  error,
  json,
  noStoreHeaders,
  withErrorHandling,
} from "../_lib/response.js";
import {
  inferenceInputSchema,
  reportInputSchema,
  scenarioComparisonInputSchema,
  simulationInputSchema,
} from "../../src/lib/compute/types.js";
import { assertSameOrigin, parseAndValidate } from "../_lib/validate.js";

const schemas = {
  simulate: simulationInputSchema,
  infer: inferenceInputSchema,
  compareScenarios: scenarioComparisonInputSchema,
  generateReport: reportInputSchema,
} as const;
const requestSchema = z
  .object({
    operation: z.enum([
      "simulate",
      "infer",
      "compareScenarios",
      "generateReport",
    ]),
    payload: z.unknown(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const result = schemas[v.operation].safeParse(v.payload);
    if (!result.success)
      result.error.issues.forEach((i) =>
        ctx.addIssue({ ...i, path: ["payload", ...i.path] }),
      );
  });
export default withErrorHandling(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return error(res, 405, "Method not allowed");
    assertSameOrigin(req);
    const auth = await getUserFromRequest(req);
    if (!auth) return error(res, 401, "Authentication required");
    if (!isFullComputeEnabled()) return respondFullComputeDisabled(res);
    const parsed = await parseAndValidate(req, requestSchema);
    if ("error" in parsed) return error(res, 400, parsed.error);
    try {
      const upstream = await proxyFullCompute("/jobs", auth.userId, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      const valid = jobStatusSchema
        .pick({ jobId: true, status: true })
        .safeParse(upstream.body);
      if (!valid.success)
        return json(
          res,
          502,
          {
            error: "FULL_COMPUTE_INVALID_RESPONSE",
            message: "Full compute backend returned an invalid job receipt.",
          },
          { headers: noStoreHeaders() },
        );
      json(res, 202, valid.data, { headers: noStoreHeaders() });
    } catch (err) {
      if (!respondProxyError(res, err)) throw err;
    }
  },
);
