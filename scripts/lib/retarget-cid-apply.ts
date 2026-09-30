/**
 * The write step of `retarget:cid`, kept apart from the script's `main()` so
 * a test can import it (the script exits on import without `DATABASE_URL`).
 *
 * The per-drug advisory lock is taken first, before any row lock. It is the
 * lock `saveCaseWithMergeLock` and the drug merge take, so a simulator case
 * saved while the CID moves either lands before the rewrite (and is repointed
 * by it) or waits for the commit. Without it a save could store the old key
 * after the only rewrite had run (#1076 item 4). Same order as the merge:
 * advisory lock, then row locks.
 */
import { eq, sql } from 'drizzle-orm';
import { drugs } from '../../db/schema';
import type { getDb } from '../../api/_lib/db';
import { lockDrugForEntryApplicability } from '../../api/_lib/parameterApplicabilityStore';

type Db = ReturnType<typeof getDb>;

/** Take the per-drug lock; must run inside `runInPoolTransaction`. */
export async function lockDrugForRetarget(drugId: number): Promise<void> {
  await lockDrugForEntryApplicability(drugId);
}

/** Repoint saved cases from `fromKeys` to the new CID, then move the drug. */
export async function rewriteCaseKeysAndCid(
  tx: Db,
  drugId: number,
  fromKeys: string[],
  to: number,
): Promise<void> {
  const fromList = fromKeys.map((k) => `'${k}'`).join(', ');
  const fromContainment = fromKeys
    .map((k) => `case_data->'drugs' @> '[{"drugId":${JSON.stringify(k)}}]'::jsonb`)
    .join(' OR ');
  await tx.execute(
    sql.raw(`
      UPDATE simulator_cases SET case_data = jsonb_set(
        case_data, '{drugs}',
        (SELECT jsonb_agg(
           CASE WHEN d->>'drugId' IN (${fromList})
                THEN jsonb_set(d, '{drugId}', to_jsonb('${String(to)}'::text))
                ELSE d END)
         FROM jsonb_array_elements(case_data->'drugs') d)
      )
      WHERE ${fromContainment}`),
  );
  await tx
    .update(drugs)
    .set({ pubchemCid: to, updatedAt: new Date() })
    .where(eq(drugs.id, drugId));
}
