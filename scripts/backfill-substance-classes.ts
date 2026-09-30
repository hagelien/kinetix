/**
 * Apply `data/substanceClasses.ts` to an existing database.
 *
 * Dry-run by default; `--apply` writes.
 *
 * ## Why this is a script and not part of migration 0097
 *
 * **It has to run after the deploy, not before it.** A migration runs while
 * the *previous* application version is still accepting writes. Classifying a
 * substance declares bioavailability and the dose ranges undefined for
 * it — but the old build carries no applicability guard, so it can store one
 * of those values moments after the migration's snapshot. The new API would
 * then serve a number for a pair its own gap queue calls impossible. No
 * conditional UPDATE closes that window; running once the guarded writers are
 * live does.
 *
 * **And it has to be re-runnable.** The classification is a list of scientific
 * judgements, and four entries have already been withdrawn after review —
 * beta-hydroxybutyrate, hydroxybupropion, cotinine and 3-hydroxyphenazepam are
 * all administered in some form. A judgement baked into a migration stays
 * wrong in every database that already ran it. This can be run again whenever
 * the list changes.
 *
 * ## What it will and will not do
 *
 * - **Classifies** a substance the list names, if its stored class is still
 *   the `drug` default and no live value or source entry contradicts the
 *   change. Under the per-drug applicability lock, so a concurrent parameter
 *   write cannot slip between the check and the update.
 * - **Skips and reports** a substance whose live data conflicts, leaving it
 *   `drug` for a human — the same refuse-rather-than-clear policy
 *   `PATCH /api/drugs` applies. A skipped substance stays visible: its
 *   parameters simply remain in the gap queue.
 * - **Reports but never changes** a substance already classified as something
 *   other than `drug`. That covers both an editor's deliberate correction and
 *   a withdrawn list entry, and the two are indistinguishable from here. Both
 *   are for a human to resolve; silently reverting an editor is the failure
 *   the seeder's insert-only rule exists to prevent.
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { drugs } from '../db/schema.js';
import { getDb } from '../api/_lib/db.js';
import { withDrugApplicabilityLock } from '../api/_lib/parameterApplicabilityStore.js';
import { conflictingAdministrationData } from '../api/drugs.js';
import { SUBSTANCE_CLASS_BY_PUBCHEM_CID } from '../data/substanceClasses.js';
import { DEFAULT_SUBSTANCE_CLASS } from '../src/lib/parameterApplicability.js';

const APPLY = process.argv.includes('--apply');

export interface CatalogedDrug {
  id: number;
  slug: string;
  pubchemCid: number | null;
  substanceClass: string;
}

export type ClassPlanAction =
  | { kind: 'classify'; to: string }
  | { kind: 'already'; current: string }
  | { kind: 'unlisted'; current: string };

export interface ClassPlanItem {
  drug: CatalogedDrug;
  action: ClassPlanAction;
}

/**
 * Decide what each drug needs, with no database access, so the policy is
 * testable on its own. Conflict checking is deliberately NOT here: it needs a
 * query, and doing it under the lock is the whole point.
 */
export function planSubstanceClassChanges(
  rows: readonly CatalogedDrug[],
): ClassPlanItem[] {
  const out: ClassPlanItem[] = [];
  for (const drug of rows) {
    const wanted =
      drug.pubchemCid === null
        ? undefined
        : SUBSTANCE_CLASS_BY_PUBCHEM_CID[drug.pubchemCid]?.substanceClass;

    if (drug.substanceClass !== DEFAULT_SUBSTANCE_CLASS) {
      // Already carries a non-default class. Either an editor set it, or the
      // list once claimed it and no longer does. Report; never revert.
      out.push({
        drug,
        action: wanted
          ? { kind: 'already', current: drug.substanceClass }
          : { kind: 'unlisted', current: drug.substanceClass },
      });
      continue;
    }
    if (wanted) out.push({ drug, action: { kind: 'classify', to: wanted } });
  }
  return out;
}

export type ClassifyOutcome =
  | { kind: 'classified' }
  | { kind: 'conflict'; parameters: string[] }
  | { kind: 'reclassified-meanwhile'; current: string }
  | { kind: 'missing' };

/**
 * Classify one drug, or say what stopped it.
 *
 * Everything that decides the outcome is read **inside** the lock, including
 * the class itself. `run()` plans from a snapshot of the whole catalog, and an
 * editor can commit a reclassification between that snapshot and this drug's
 * turn — the lock serializes the two, but serializing an update that never
 * re-reads only guarantees the stale write lands last. The first cut here did
 * exactly that, under a docblock promising never to overwrite an editor.
 *
 * Reading the class under the lock is also what makes the conflict check mean
 * anything: without it a parameter write could pass its own applicability
 * check against the old class and commit between the read and the update.
 *
 * Exported so the integration tests exercise this function rather than a
 * paraphrase of it.
 */
export async function classifySubstance(
  drugId: number,
  to: string,
  apply: boolean,
): Promise<ClassifyOutcome> {
  return withDrugApplicabilityLock(drugId, async (): Promise<ClassifyOutcome> => {
    const db = getDb();
    const [live] = await db
      .select({ substanceClass: drugs.substanceClass })
      .from(drugs)
      .where(eq(drugs.id, drugId))
      .limit(1);
    if (!live) return { kind: 'missing' };
    if (live.substanceClass !== DEFAULT_SUBSTANCE_CLASS) {
      return { kind: 'reclassified-meanwhile', current: live.substanceClass };
    }

    const conflicts = await conflictingAdministrationData(drugId, to);
    if (conflicts.length) return { kind: 'conflict', parameters: conflicts };

    if (apply) {
      // Conditional on the class as well, so even a write that slipped past
      // the read cannot be clobbered. Belt and braces: the read above is the
      // one that reports, this is the one that is correct.
      await db
        .update(drugs)
        .set({ substanceClass: to })
        .where(
          and(
            eq(drugs.id, drugId),
            eq(drugs.substanceClass, DEFAULT_SUBSTANCE_CLASS),
          ),
        );
    }
    return { kind: 'classified' };
  });
}

async function run(): Promise<void> {
  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console
  const db = getDb();

  const rows = (await db
    .select({
      id: drugs.id,
      slug: drugs.slug,
      pubchemCid: drugs.pubchemCid,
      substanceClass: drugs.substanceClass,
    })
    .from(drugs)) as CatalogedDrug[];

  const plan = planSubstanceClassChanges(rows);
  const classified: string[] = [];
  const conflicted: string[] = [];
  const unlisted: string[] = [];

  for (const { drug, action } of plan) {
    if (action.kind === 'unlisted') {
      unlisted.push(`${drug.slug} (#${drug.id}) is '${action.current}'`);
      continue;
    }
    if (action.kind === 'already') continue;

    const outcome = await classifySubstance(drug.id, action.to, APPLY);

    if (outcome.kind === 'conflict') {
      conflicted.push(
        `${drug.slug} (#${drug.id}) holds ${outcome.parameters.join(', ')}`,
      );
    } else if (outcome.kind === 'reclassified-meanwhile') {
      unlisted.push(
        `${drug.slug} (#${drug.id}) was set to '${outcome.current}' while this run was in progress`,
      );
    } else if (outcome.kind === 'classified') {
      classified.push(`${drug.slug} (#${drug.id}) → ${action.to}`);
    }
  }

  log(`── Substance classification ──`);
  log(`${APPLY ? 'Classified' : 'Would classify'} ${classified.length} drug(s).`);
  for (const l of classified) log(`  - ${l}`);

  if (conflicted.length) {
    log(
      `\nSkipped ${conflicted.length} drug(s) whose live data contradicts the class:`,
    );
    for (const l of conflicted) log(`  - ${l}`);
    log(`  Clear the values or correct the classification, then re-run.`);
  }

  if (unlisted.length) {
    log(
      `\n${unlisted.length} drug(s) carry a class the list no longer claims — an editor's` +
        ` correction, or an entry withdrawn from data/substanceClasses.ts:`,
    );
    for (const l of unlisted) log(`  - ${l}`);
    log(`  Left untouched. Reclassify to 'drug' by hand if the list is right.`);
  }

  if (!APPLY) log(`\nDry run. Re-run with --apply to write.`);
}

if (process.argv[1]?.endsWith('backfill-substance-classes.ts')) {
  await run();
}
