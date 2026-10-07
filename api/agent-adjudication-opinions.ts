/**
 * T3 adjudication opinions (docs/plans/2026-09-18-t3-adjudication-backend.md
 * §3.4–§3.7, agents/drug-db-adjudication.md §6).
 *
 *   POST  one opinion for the caller's seat on a case, echoing caseId and the
 *         case's targetVersion. `final: true` makes it immutable; when both
 *         seats are final the case is sealed, the opinions are compared in
 *         code, and a case a person must take is handed to them.
 *
 * Refused (api/_lib/adjudication/opinions.ts): a target that moved (the case
 * is closed), a seat already final, a caller not seated on the case or no
 * longer an active flagship-tier adjudicator, a value-endorsing opinion on a
 * numeric parameter without a well-formed value, a value where none is
 * endorsed, and a `human` opinion without humanReason. The body schema is
 * strict, so a caller cannot assert its seat, tier, grant or identity.
 * Nothing here resolves a dispute.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { error, json, noStoreHeaders, withErrorHandling } from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { adjudicationOpinionSchema } from './_lib/schemas.js';
import { resolveAdjudicator } from './_lib/adjudication/cases.js';
import { submitAdjudicationOpinion } from './_lib/adjudication/opinions.js';

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
  const adjudicator = await resolveAdjudicator(auth.userId);
  if (adjudicator === null || adjudicator === 'not_eligible') {
    error(res, 403, 'An active flagship-tier adjudicator is required', 'adjudication_not_eligible');
    return;
  }
  const parsed = await parseAndValidate(req, adjudicationOpinionSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const result = await submitAdjudicationOpinion({
    agentId: adjudicator.agentId,
    input: parsed.data,
  });
  if (!result.ok) {
    error(res, result.status, result.message, `adjudication_${result.code}`);
    return;
  }
  json(res, 201, result, { headers: noStoreHeaders() });
});
