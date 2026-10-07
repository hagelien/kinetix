/**
 * Retry sweep for agent consensus (issue #1357).
 *
 *   POST  — return unquoted calculation-driving agent proposals to their
 *           authors (`returnedForQuote`), then re-run consensus over the
 *           oldest pending edits that have at least one explicit agent
 *           approval and no dispute verdict.
 *
 * Consensus is otherwise evaluated only at the instant an `approve` verdict
 * lands. An edit held at that moment (an agent's tier not yet set, a transient
 * apply refusal) then sat in the human queue indefinitely even after the hold
 * cleared — four approvals, no objection, still waiting for a moderator. The
 * scheduled maintainer routine calls this once per cycle
 * (agents/drug-db-maintainer.md), which makes it the periodic second attempt.
 *
 * Idempotent and safe to call often: every gate `applyOnAgentConsensus`
 * enforces still applies, and an edit short of quorum is a read and a no-op.
 * The response lists the reason each edit is still held so an operator can act.
 *
 * Auth: an active agent, or a caller who may decide edits in /review.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { error, json, noStoreHeaders, withErrorHandling } from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin } from './_lib/validate.js';
import { callerCan } from './_lib/permissions-store.js';
import { CAP } from '../src/lib/permissions.js';
import { resolveActiveAgent } from './_lib/agent-verifications.js';
import { sweepAgentConsensus, sweepUnquotedAgentEdits } from './agent-verifications.js';
import { sweepAdjudicationCases } from './_lib/adjudication/cases.js';

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
  const allowed =
    (await resolveActiveAgent(auth.userId)) !== null ||
    (await callerCan(auth.role, CAP['review.edit.decide']));
  if (!allowed) {
    error(res, 403, 'Active agent or reviewer required', 'consensus_sweep_forbidden');
    return;
  }

  // Unquoted calculation-driving proposals go back to their authors first,
  // whatever their tally: the consensus retry below only reaches edits that
  // already clear the quorum floor.
  const returnedForQuote = await sweepUnquotedAgentEdits();
  const results = await sweepAgentConsensus();
  const applied = results
    .filter((r) => r.outcome === 'applied')
    .map((r) => r.pendingEditId);
  const held = results.flatMap((r) =>
    r.outcome === 'held'
      ? [{ pendingEditId: r.pendingEditId, reason: r.reason, detail: r.detail }]
      : [],
  );
  // The T3 detector's backstop: opens a case the verdict-time check missed
  // and invalidates a live case whose target has moved.
  const adjudication = await sweepAdjudicationCases();
  json(
    res,
    200,
    { checked: results.length, applied, held, returnedForQuote, adjudication },
    { headers: noStoreHeaders() },
  );
});
