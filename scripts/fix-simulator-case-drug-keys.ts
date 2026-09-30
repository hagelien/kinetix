/**
 * One-time fix script: normalize `simulator_cases.case_data.drugs[].drugId`
 * keys that still use the pre-#1259 ambiguous spelling for a drug that was
 * CID-less when the case was saved.
 *
 * `buildDrugComponentId` (src/lib/drugComponentId.ts) now keys a CID-less
 * drug by `drug:<id>`, but only for cases saved AFTER that change landed. A
 * case saved before it still carries the old bare-numeric spelling
 * (`String(id)`), and `hydrateComponentByRouteId` resolves a bare number as a
 * PubChem CID first — so whenever some OTHER drug's `pubchem_cid` equals this
 * drug's internal id, every one of that drug's saved cases has been silently
 * loading the other substance instead (#1256 item 6).
 *
 * The target drug's CURRENT PubChem CID is not the test for whether an old
 * key is still live: a drug can pick up a CID well after the case was saved
 * (a data-enrichment backfill, not necessarily `retarget-pubchem-cid.ts`,
 * which only rewrites saved cases when it is CHANGING an existing CID — a
 * drug's first CID never goes through it). So a case can still carry the old
 * bare-numeric id for a drug that has since gained an unrelated CID of its
 * own, and the collision that matters is whether some OTHER drug holds the
 * OLD number as ITS CID today — independent of what the target drug's own
 * CID now is. `buildDrugComponentId` naturally produces the right spelling
 * either way (the drug's current CID if it has one, `drug:<id>` if not), so
 * the rewrite always targets the drug's up-to-date canonical key.
 *
 * No CURRENT collision on that number does not make the key safe to rewrite
 * on its own, either: the number can just as easily be a FORMER CID that
 * used to belong to some other, now-unrelated drug. `PUT /api/drugs` can
 * change a drug's `pubchem_cid` directly and never touches
 * `simulator_cases` — only `retarget-pubchem-cid.ts`'s own dedicated flow
 * rewrites saved cases when a CID moves. So a case saved for drug B while
 * B's CID was `n`, followed by an ordinary admin edit that moves B off `n`
 * with nothing else ever claiming `n`, leaves a case that still reads bare
 * `"n"` with no collision left to detect it by.
 *
 * The bare number alone therefore never says which drug a given saved case
 * means — that ambiguity is exactly the bug, present or not. The stored
 * `drugName` (case_data.drugs[].drugName) is the only other thing the case
 * carries about its own identity, so it is always checked: a case whose name
 * unambiguously matches the drug that currently owns the number as its
 * internal id is rewritten to that drug's up-to-date canonical key (its
 * current CID if it now has one, `drug:<id>` if not — the same reasoning
 * `drizzle/0104_pubchem_identity_repoints.sql` applies to a repoint's NEW
 * number shadowing a CID-less drug's id); one that unambiguously matches a
 * drug currently colliding on the number is left alone (it was already
 * resolving correctly); anything else — including no current collision AND
 * no name match — is reported as a conflict for a human, the same
 * escalate-rather-than-guess rule `scripts/fix-monograph-drug-links.ts` uses
 * for its own drug_cid collisions.
 *
 * Each write is optimistic-concurrency guarded: the UPDATE's WHERE also pins
 * the exact `case_data` this run read, so a case a user edits mid-run is left
 * alone (reported as a conflict) instead of having its edit silently
 * overwritten by this run's stale in-memory copy. Re-running the script picks
 * up whatever the user's edit left behind.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/fix-simulator-case-drug-keys.ts
 *
 * Dry-run (no writes):
 *   DATABASE_URL=... npx tsx scripts/fix-simulator-case-drug-keys.ts --dry-run
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq } from 'drizzle-orm';
import { drugs, simulatorCases } from '../db/schema';
import { buildDrugComponentId } from '../src/lib/drugComponentId';
import { catalogForms, matchesAny, type NamedRow } from './pubchem/names';

const dryRun = process.argv.includes('--dry-run');

type Db = ReturnType<typeof drizzle>;

interface CaseDrugEntry {
  drugId?: unknown;
  drugName?: unknown;
  [key: string]: unknown;
}

interface CaseData {
  drugs?: CaseDrugEntry[];
  [key: string]: unknown;
}

export type CaseDrugKeyDecision = 'rewrite' | 'skip' | 'conflict';

/**
 * Decide what to do with one saved `case_data.drugs[]` entry whose `drugId`
 * is the bare numeric string that currently names `targetDrug`'s own
 * internal id.
 *
 * `collidingDrug` is whichever OTHER drug currently holds that same number as
 * its PubChem CID, or null when none does. A null `collidingDrug` does NOT
 * make the key safe to rewrite unconditionally: the number can equally be a
 * FORMER CID that used to belong to some other, now-unrelated drug. Admin
 * edits to `drugs.pubchemCid` (`PUT /api/drugs`) change a drug's CID directly
 * and never touch `simulator_cases` — only `retarget-pubchem-cid.ts`'s own
 * dedicated flow rewrites saved cases when a CID moves. So a case saved for
 * drug B while B's CID was `n`, followed by an unrelated admin edit that
 * moves B off `n` with no other drug ever picking `n` up, leaves a case
 * that still reads bare `"n"` with nothing in `drugs.pubchem_cid` to flag it
 * as a collision — yet rewriting it to `targetDrug` (whichever CID-less drug
 * happens to have internal id `n` today) would silently reassign that case
 * to a different substance than the one it was ever saved for.
 *
 * The stored `drugName` is therefore always checked against `targetDrug`,
 * with or without a current collision — it is the only way to tell "this
 * really is targetDrug's own case" from "this number used to mean something
 * else."
 */
export function classifyCaseDrugKey(
  drugName: string | undefined,
  targetDrug: NamedRow,
  collidingDrug: NamedRow | null,
): CaseDrugKeyDecision {
  if (!drugName) return 'conflict';
  const matchesTarget = matchesAny(catalogForms(targetDrug), drugName);
  const matchesColliding = Boolean(
    collidingDrug && matchesAny(catalogForms(collidingDrug), drugName),
  );
  if (matchesTarget && !matchesColliding) return 'rewrite';
  if (matchesColliding && !matchesTarget) return 'skip';
  return 'conflict';
}

/**
 * The drug (if any) that collides with `targetDrug` by currently holding the
 * same number as its own PubChem CID that `targetDrug` holds as its internal
 * id. Excludes the degenerate case where `targetDrug`'s own CID happens to
 * equal its own internal id — that is not a collision with anything else.
 *
 * Deliberately independent of whether `targetDrug` itself currently has a
 * CID: a drug can gain one long after a case was saved under its old bare
 * internal id (a data-enrichment backfill, not necessarily
 * `retarget-pubchem-cid.ts`), and the collision that matters is whether some
 * OTHER drug holds the OLD number today, not what `targetDrug`'s own CID is
 * now.
 */
export function resolveCollidingDrug<T extends { id: number }>(
  targetDrug: T,
  byCidHit: T | null,
): T | null {
  return byCidHit && byCidHit.id !== targetDrug.id ? byCidHit : null;
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = neon(DATABASE_URL);
  const db: Db = drizzle(client);

  if (dryRun) {
    console.log('=== DRY RUN — no changes will be written ===\n');
  }

  const allDrugs = await db
    .select({
      id: drugs.id,
      names: drugs.names,
      aliases: drugs.aliases,
      nameShort: drugs.nameShort,
      pubchemCid: drugs.pubchemCid,
    })
    .from(drugs);

  const byId = new Map(allDrugs.map((d) => [d.id, d]));
  const byCid = new Map(
    allDrugs.filter((d) => d.pubchemCid != null).map((d) => [d.pubchemCid!, d]),
  );

  const allCases = await db
    .select({ id: simulatorCases.id, caseData: simulatorCases.caseData })
    .from(simulatorCases);

  let rewritten = 0;
  let skipped = 0;
  let conflicts = 0;
  let casesChanged = 0;
  let raceConflicts = 0;

  for (const row of allCases) {
    // Independent deep copy: `data` below is mutated in place, and `entries`
    // shares its object graph with `row.caseData` — without cloning first,
    // `originalCaseData` would silently pick up the same mutations and the
    // optimistic-concurrency check below would compare the mutated value
    // against itself instead of against what this run actually read.
    const originalCaseData = structuredClone(row.caseData);
    const data = row.caseData as CaseData;
    const entries = Array.isArray(data?.drugs) ? data.drugs : null;
    if (!entries) continue;

    let changed = false;
    for (const entry of entries) {
      // `case_data` is validated only as `z.record(string, unknown())` (see
      // api/simulator/cases.ts), and that route's own reference extractor
      // already tolerates a non-object array member — a malformed or
      // legacy entry (e.g. `drugs: [null]`) can genuinely be in the table.
      // One such entry must not abort every later case in this run.
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.drugId !== 'string' || !/^\d+$/.test(entry.drugId)) continue;
      const n = Number(entry.drugId);
      const targetDrug = byId.get(n);
      // No drug has this internal id at all — not our concern.
      if (!targetDrug) continue;

      const colliding = resolveCollidingDrug(targetDrug, byCid.get(n) ?? null);

      const drugName =
        typeof entry.drugName === 'string' ? entry.drugName : undefined;
      const decision = classifyCaseDrugKey(drugName, targetDrug, colliding);

      if (decision === 'rewrite') {
        const next = buildDrugComponentId(targetDrug);
        if (next !== entry.drugId) {
          entry.drugId = next;
          changed = true;
        }
        rewritten++;
      } else if (decision === 'skip') {
        skipped++;
      } else {
        conflicts++;
        const alternative = colliding
          ? `drug ${colliding.id} (current CID ${n})`
          : `some other, no-longer-identifiable drug that may once have held CID ${n}`;
        console.log(
          `  [CONFLICT] case ${row.id} — drugId "${n}" (drugName "${drugName ?? ''}") ` +
            `could mean drug ${targetDrug.id} or ${alternative}; the saved name ` +
            `doesn't unambiguously pick one. Needs a human.`,
        );
      }
    }

    if (changed) {
      casesChanged++;
      if (!dryRun) {
        // Optimistic concurrency: only write if `case_data` still matches
        // what this run read. A user's edit landing mid-run makes the WHERE
        // match nothing rather than being silently overwritten by this run's
        // stale in-memory copy.
        //
        // `updated_at` is deliberately left alone — nobody edited this case,
        // and moving the timestamp would misreport that in every case list
        // (same reasoning as the simulator_cases rewrite in migration 0104).
        const [updated] = await db
          .update(simulatorCases)
          .set({ caseData: data })
          .where(
            and(
              eq(simulatorCases.id, row.id),
              eq(simulatorCases.caseData, originalCaseData),
            ),
          )
          .returning({ id: simulatorCases.id });
        if (!updated) {
          raceConflicts++;
          console.log(
            `  [CONFLICT] case ${row.id} — case_data changed since it was read; ` +
              `skipped to avoid overwriting a concurrent edit. Re-run to retry.`,
          );
        }
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Cases with a key rewritten: ${casesChanged}`);
  console.log(`  Entries rewritten:                       ${rewritten}`);
  console.log(`  Entries left alone (already correct):    ${skipped}`);
  console.log(`  Conflicts needing a human:                ${conflicts}`);
  console.log(`  Skipped due to a concurrent edit:         ${raceConflicts}`);
  if (dryRun) {
    console.log(`\n(Dry run — no changes were written. Remove --dry-run to apply.)`);
  }
}

// Run only as a CLI; importing this module for its pure helpers (tests) must
// not hit the database or read DATABASE_URL.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    // A rejected read or write leaves some cases unexamined — an operator
    // or automation must not read a clean process exit as "backfill done"
    // (#1446).
    process.exitCode = 1;
  });
}
