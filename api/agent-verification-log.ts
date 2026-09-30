/**
 * Agent-only verification log endpoint.
 *
 * Scheduled routines use this route instead of carrying a direct DATABASE_URL
 * into the LLM runtime. Authentication is the revocable `kxat_…` agent token
 * resolved by getUserFromRequest(); human JWT sessions are rejected even when
 * they have contributor/editor/admin roles.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { error, json, withErrorHandling } from './_lib/response.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { createVerificationLogSchema } from './_lib/schemas.js';
import { drugs, verificationLog } from '../db/schema.js';
import { resolveActiveAgent } from './_lib/agent-verifications.js';
import { lockDrugForEntryApplicability } from './_lib/parameterApplicabilityStore.js';

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

  const parsed = await parseAndValidate(req, createVerificationLogSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const data = parsed.data;
  // For `targetType='parameter'` the `targetId` is a `drugs.id`. Without
  // the per-drug merge lock a verification a scheduled agent posts right
  // after a merge deleted the loser drug would commit with `targetId`
  // pointing at a nonexistent row, orphaning the audit trail and
  // leaving an `absent` verdict unable to suppress the corresponding
  // winner gap. Take the same advisory lock the merge holds and
  // re-verify the drug under it: the merge either committed before we
  // took the lock (drug is gone → 404) or waits behind us (its later
  // repoint sweep would move any orphaned targetId onto the winner
  // anyway).
  const drugId =
    data.targetType === 'parameter' &&
    typeof data.targetId === 'number' &&
    data.targetId > 0
      ? data.targetId
      : null;

  type Outcome =
    | { kind: 'ok'; id: number }
    | { kind: 'gone' }
    | { kind: 'failed' };
  const insertRow = async () => {
    const [row] = await getDb()
      .insert(verificationLog)
      .values({
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        parameter: data.parameter ?? null,
        agentNotes: data.agentNotes ?? null,
        sourcesConsultedCount: data.sourcesConsultedCount ?? 0,
        concordance: data.concordance ?? null,
        outcome: data.outcome,
        createdBy: auth.userId,
      })
      .returning({ id: verificationLog.id });
    return row?.id ?? null;
  };

  let outcome: Outcome;
  if (drugId != null) {
    outcome = await runInPoolTransaction<Outcome>(async () => {
      await lockDrugForEntryApplicability(drugId);
      const [stillHere] = await getDb()
        .select({ id: drugs.id })
        .from(drugs)
        .where(eq(drugs.id, drugId))
        .limit(1);
      if (!stillHere) return { kind: 'gone' };
      const id = await insertRow();
      return id != null ? { kind: 'ok', id } : { kind: 'failed' };
    });
  } else {
    const id = await insertRow();
    outcome = id != null ? { kind: 'ok', id } : { kind: 'failed' };
  }
  if (outcome.kind === 'gone') {
    error(res, 404, 'Target drug not found', 'drug_not_found');
    return;
  }
  if (outcome.kind === 'failed') {
    error(res, 500, 'Verification log insert failed');
    return;
  }

  json(res, 201, { id: outcome.id });
});
