/**
 * Agent-only run-usage endpoint.
 *
 * A scheduled run appends one row at its end with the token counts summed
 * from its own transcript (scripts/kinetix-log-run-usage.ts), so the tiered
 * rollout's cost can be read per capability tier and per workflow next to its
 * accuracy (scripts/benchmark-agent-tiers.ts). Authentication is the revocable
 * `kxat_…` agent token; human sessions are rejected even with elevated roles
 * (mirrors /api/agent-verification-log).
 *
 * The capability tier is never taken from the body, and re-logging the same
 * (agent, session) updates only its counts — see api/_lib/agent-run-usage.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getUserFromRequest } from './_lib/auth.js';
import { error, json, withErrorHandling } from './_lib/response.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { createAgentRunUsageSchema } from './_lib/schemas.js';
import { resolveActiveAgent } from './_lib/agent-verifications.js';
import { recordAgentRunUsage } from './_lib/agent-run-usage.js';

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }
  assertSameOrigin(req);

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const agent = await resolveActiveAgent(auth.userId);
  if (!agent) {
    error(res, 403, 'Agent token required');
    return;
  }

  const parsed = await parseAndValidate(req, createAgentRunUsageSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const row = await recordAgentRunUsage({
    agentId: agent.id,
    userId: auth.userId,
    data: parsed.data,
  });
  if (!row) {
    error(res, 500, 'Run usage insert failed');
    return;
  }
  json(res, 201, row);
});
