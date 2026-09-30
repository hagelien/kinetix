import type { IncomingMessage, ServerResponse } from "node:http";
import { getUserFromRequest } from "../_lib/auth.js";
import {
  isFullComputeEnabled,
  JOB_ID_PATTERN,
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
export default withErrorHandling(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "DELETE")
      return error(res, 405, "Method not allowed");
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
        `/jobs/${encodeURIComponent(jobId)}`,
        auth.userId,
        { method: req.method },
      );
      const valid = jobStatusSchema.safeParse(upstream.body);
      if (!valid.success || valid.data.jobId !== jobId)
        return json(
          res,
          502,
          {
            error: "FULL_COMPUTE_INVALID_RESPONSE",
            message: "Full compute backend returned invalid job status.",
          },
          { headers: noStoreHeaders() },
        );
      json(res, req.method === "DELETE" ? 202 : 200, valid.data, {
        headers: noStoreHeaders(),
      });
    } catch (err) {
      if (!respondProxyError(res, err)) throw err;
    }
  },
);
