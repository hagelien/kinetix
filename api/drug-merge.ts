/**
 * Merge two catalog entries for one substance (#admin-drug-merge).
 *
 *   POST /api/drug-merge   { action: 'preview', drugIdA, drugIdB, winnerId? }
 *     → the merge plan: which entry survives (monograph rule, overridable via
 *       winnerId), the conflicts an admin must resolve, and a count of what
 *       moves. Read-only.
 *
 *   POST /api/drug-merge   { action: 'apply', winnerId, loserId, resolutions }
 *     → performs the merge inside one transaction and returns the stats.
 *
 * Admin-gated (`drug.merge`, floors at editor) and same-origin, like the other
 * destructive registry writes. The heavy lifting is in
 * `api/_lib/drug-merge.ts`; this file is the HTTP shell and the guard that the
 * plan the admin approved is the plan that runs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  drugMergeApplySchema,
  drugMergeBodySchema,
  drugMergePreviewSchema,
} from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { and, eq, inArray } from 'drizzle-orm';
import { wikiPages } from '../db/schema.js';
import { isActiveAgentUser } from './_lib/agent-verifications.js';
import { resolveMonographDrugCids } from './_lib/monograph-helpers.js';
import { wikiContentFocusRefusal } from './agent-focus.js';
import {
  DrugMergeBlockedError,
  DrugMergeClassMismatchError,
  DrugMergeDataConflictError,
  DrugMergeStalePlanError,
  UnresolvedDrugMergeConflictError,
  buildDrugMergePlan,
  detectApplicabilityBlockers,
  detectDataConflicts,
  detectSingleValueConflicts,
  loadDrugSideInfo,
  mergeDrugs,
  suggestWinner,
} from './_lib/drug-merge.js';

export default withErrorHandling(
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      error(res, 405, 'Method not allowed');
      return;
    }
    assertSameOrigin(req);

    const auth = await getUserFromRequest(req);
    if (!auth || !(await callerCan(auth.role, CAP['drug.merge']))) {
      error(res, 403, 'Admin role required');
      return;
    }

    const parsed = await parseAndValidate(req, drugMergeBodySchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    const body = parsed.data;

    if (body.action === 'preview') {
      return handlePreview(res, body);
    }
    return handleApply(res, body, auth.userId);
  },
);

async function handlePreview(
  res: ServerResponse,
  body: z.infer<typeof drugMergePreviewSchema>,
): Promise<void> {
  const { drugIdA, drugIdB, winnerId } = body;
  if (drugIdA === drugIdB) {
    error(res, 400, 'Pick two different drugs to merge.');
    return;
  }
  const db = getDb();
  const [a, b] = await Promise.all([
    loadDrugSideInfo(db, drugIdA),
    loadDrugSideInfo(db, drugIdB),
  ]);
  if (!a) {
    error(res, 404, `Drug ${drugIdA} not found`);
    return;
  }
  if (!b) {
    error(res, 404, `Drug ${drugIdB} not found`);
    return;
  }

  const suggestion = suggestWinner(a, b);
  // An explicit winner override flips the direction while keeping the monograph
  // reasoning visible.
  let winner = suggestion.winner;
  let loser = suggestion.loser;
  let byMonograph = suggestion.byMonograph;
  let reason = suggestion.reason;
  if (winnerId != null) {
    if (winnerId !== drugIdA && winnerId !== drugIdB) {
      error(res, 400, 'winnerId must be one of the two drugs being merged.');
      return;
    }
    winner = winnerId === a.id ? a : b;
    loser = winnerId === a.id ? b : a;
    byMonograph = false;
    reason = {
      code: 'winnerReason.manualOverride',
      params: { winnerName: winner.name, winnerId: winner.id },
      fallback: `Survivor chosen manually: "${winner.name}" (id ${winner.id}).`,
    };
  }

  const plan = await buildDrugMergePlan(db, winner, loser, { byMonograph, reason });
  json(res, 200, { plan });
}

/**
 * The drug-monograph page ids belonging to these drugs.
 *
 * `wiki_pages.drug_cid` is mixed-vintage — modern rows hold `drugs.id`, legacy
 * rows a PubChem CID — so the candidates go through the same
 * `resolveMonographDrugCids` the merge and the delete teardown use. Reading
 * `drug_cid` directly would miss a legacy-keyed monograph, and a gate that
 * misses the page is a gate that lets the fold through.
 */
async function monographPagesForDrugs(
  db: ReturnType<typeof getDb>,
  sides: Array<{ id: number; pubchemCid: number | null }>,
): Promise<number[]> {
  const candidates = (
    await Promise.all(sides.map((side) => resolveMonographDrugCids(db, side)))
  ).flat();
  if (candidates.length === 0) return [];
  const rows = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        inArray(wikiPages.drugCid, candidates),
      ),
    );
  return rows.map((r) => r.id);
}

async function handleApply(
  res: ServerResponse,
  body: z.infer<typeof drugMergeApplySchema>,
  actorUserId: number,
): Promise<void> {
  const { winnerId, loserId, resolutions, planFingerprint } = body;
  if (winnerId === loserId) {
    error(res, 400, 'winner and loser must be different drugs.');
    return;
  }

  const db = getDb();
  const [winner, loser] = await Promise.all([
    loadDrugSideInfo(db, winnerId),
    loadDrugSideInfo(db, loserId),
  ]);
  if (!winner) {
    error(res, 404, `Drug ${winnerId} not found`);
    return;
  }
  if (!loser) {
    error(res, 404, `Drug ${loserId} not found`);
    return;
  }

  // ─── Admin agent-focus gate on agent-authored wiki content ──────────────
  // A merge rewrites and destroys wiki content: it relinks the loser's
  // monograph to the winner, deletes one of the two monographs, and rewrites
  // page content and revisions to repoint the fold. `drug.merge` carries
  // `floorTier: 'editor'` like the other destructive registry actions, so the
  // same delegation that lets an editor-tier agent identity edit a monograph
  // lets it fold one away from here.
  //
  // BOTH monographs are judged, because the merge touches both: the loser's is
  // relinked or deleted, and the winner's is rewritten. A narrowing that
  // admits one but not the other admits half a merge, which is not a thing
  // this route can do. Humans are unaffected, as on every other door.
  if (await isActiveAgentUser(actorUserId)) {
    const monographPages = await monographPagesForDrugs(db, [winner, loser]);
    for (const pageId of monographPages) {
      const refusal = await wikiContentFocusRefusal(pageId);
      if (refusal) {
        error(res, 403, refusal, 'agent_focus_out_of_scope');
        return;
      }
    }
  }

  // Early, friendly 409s before opening a transaction. These are re-checked
  // authoritatively inside mergeDrugs under the per-drug lock (a write can land
  // between here and the fold), so the pre-checks are for a clean message, not
  // for correctness.
  if (winner.substanceClass !== loser.substanceClass) {
    json(res, 409, {
      error:
        'The two entries disagree about what this substance IS — winner is ' +
        `'${winner.substanceClass}', loser is '${loser.substanceClass}'. ` +
        'Reconcile the classification on the drugs first; it decides which parameters are defined at all.',
      code: 'substance_class_mismatch',
      winnerClass: winner.substanceClass,
      loserClass: loser.substanceClass,
    });
    return;
  }
  const blockers = await detectApplicabilityBlockers(db, winnerId, loserId);
  if (blockers.length > 0) {
    json(res, 409, {
      error:
        'This merge would leave the surviving drug with a value the applicability system declares undefined (a not-applicable marker beside a value, or data a non-administered substance class forbids). Resolve it on the drugs first, then merge.',
      code: 'applicability_conflict',
      blockers,
    });
    return;
  }
  const dataConflicts = await detectDataConflicts(db, winner, loser);
  if (dataConflicts.length > 0) {
    json(res, 409, {
      error:
        'This merge would drop divergent validated data — two independently-curated rows disagree on identity-key columns. Reconcile them on the drugs first, then merge.',
      code: 'data_conflict',
      dataConflicts,
    });
    return;
  }
  const conflicts = await detectSingleValueConflicts(db, winnerId, loserId);
  const missing = conflicts
    .filter((c) => resolutions[c.id] !== 'winner' && resolutions[c.id] !== 'loser')
    .map((c) => c.id);
  if (missing.length > 0) {
    json(res, 409, {
      error:
        'Some conflicts are unresolved. Re-run the preview and choose which value to keep for each.',
      code: 'unresolved_conflicts',
      conflicts: missing,
    });
    return;
  }

  try {
    const stats = await runInPoolTransaction(async () => {
      const tx = getDb();
      return mergeDrugs(tx, {
        winnerId,
        loserId,
        resolutions,
        actorUserId,
        approvedPlanFingerprint: planFingerprint,
      });
    });
    json(res, 200, { ok: true, stats });
  } catch (err) {
    // The authoritative in-transaction checks: a conflict or applicability
    // contradiction that appeared after the preflight above (or that this
    // request raced) rolls the whole fold back and returns a 409, never a
    // half-applied merge.
    if (err instanceof UnresolvedDrugMergeConflictError) {
      json(res, 409, {
        error:
          'A conflicting value changed while the merge was starting. Re-run the preview and choose again.',
        code: 'unresolved_conflicts',
        conflicts: err.conflicts,
      });
      return;
    }
    if (err instanceof DrugMergeBlockedError) {
      json(res, 409, {
        error:
          'This merge would violate the parameter-applicability invariant on the surviving drug. Resolve it on the drugs first, then merge.',
        code: 'applicability_conflict',
        blockers: err.blockers,
      });
      return;
    }
    if (err instanceof DrugMergeDataConflictError) {
      json(res, 409, {
        error:
          'A divergence in validated data appeared while the merge was starting. Reconcile the flagged rows on the drugs, then merge.',
        code: 'data_conflict',
        dataConflicts: err.conflicts,
      });
      return;
    }
    if (err instanceof DrugMergeStalePlanError) {
      json(res, 409, {
        error:
          'The merge plan changed while it was being reviewed — a conflict value shifted, the loser monograph gained prose, or a new refusal appeared. Re-run the preview so the current picture is the one being approved.',
        code: 'stale_plan',
      });
      return;
    }
    if (err instanceof DrugMergeClassMismatchError) {
      json(res, 409, {
        error:
          `The two entries disagree about what this substance IS — winner is '${err.winnerClass}', loser is '${err.loserClass}'. ` +
          'Reconcile the classification on the drugs first; it decides which parameters are defined at all.',
        code: 'substance_class_mismatch',
        winnerClass: err.winnerClass,
        loserClass: err.loserClass,
      });
      return;
    }
    console.error('Failed to merge drugs:', {
      winnerId,
      loserId,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
    });
    error(res, 500, 'Failed to merge drugs');
  }
}
