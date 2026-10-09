/**
 * Seed a postmortem concentration distribution cohort into
 * `pm_concentration_sources` + `pm_concentration_distributions`.
 *
 * The first cohort is unpublished material: a few hundred analytes measured in
 * postmortem femoral venous blood, with the source's own therapeutic plasma
 * concentration alongside. Its dataset file is kept OUTSIDE this repository,
 * so the operator passes its path with `--file`; there is no default. The
 * material carries no link to cause of death — which is the whole reason this
 * data has its own tables: nothing in it may reach the interpretive
 * concentration pools, and this seeder cannot write to them even by mistake.
 * It touches no `parameter_entries` row and no `drug_parameters` row except a
 * molecular weight it creates alongside a brand-new substance.
 *
 * It is an ADMIN / OPERATOR tool, like scripts/seed-drugs.ts and
 * scripts/seed-pm-am-ratios.ts: it writes directly, bypassing the review queue.
 *
 * Safety defaults:
 *   - Idempotent by SOURCE OBSERVATION: at most one distribution per (cohort,
 *     drug), enforced by a unique index. A corrected transcription UPDATEs that
 *     row rather than inserting a second one, so a reader never sees two
 *     contradictory medians from one cohort.
 *   - Additive across cohorts: another source's distributions are untouched.
 *   - Missing substances are CREATED (a large share of the first cohort's
 *     analytes were not yet in the catalog), with the analyte's PubChem
 *     identity and molecular weight, an empty monograph, and a report at the
 *     end so a curator can add Norwegian names and a substance class.
 *     `--no-create-drugs` reverts to reporting and skipping.
 *   - Substance class is left at the column default for created rows rather
 *     than guessed from the analyte name. `data/substanceClasses.ts` sets a
 *     deliberately high bar ("nobody administers it in any form" — morphine and
 *     O-desmethyltramadol are metabolites AND products), and dozens of
 *     unreviewed judgements written in bulk is exactly what that file exists
 *     to prevent.
 *   - Rows the dataset no longer claims (a corrected `pubchemCid` leaves one
 *     behind under the old substance) are REPORTED; `--prune` deletes them.
 *   - `--dry-run` validates the dataset and prints the plan without writing
 *     (no DATABASE_URL needed).
 *
 * Usage (`--file` is REQUIRED — the dataset is not in the repository):
 *   npm run seed:pm-concentrations -- --file /path/to/dataset.json
 *   npm run seed:pm-concentrations -- --file /path/to/dataset.json --dry-run
 *   npm run seed:pm-concentrations -- --file /path/to/dataset.json --user-email me@example.com
 *   npm run seed:pm-concentrations -- --file /path/to/dataset.json --prune
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  drugs,
  pmConcentrationDistributions,
  pmConcentrationSources,
  users,
} from '../db/schema';
import { getDb, inTransaction, runInPoolTransaction } from '../api/_lib/db';
import { upsertDrugParameter } from '../api/_lib/drugParameterStore';
import { ensureDrugMonograph } from '../api/_lib/monograph-helpers';
import { generateSlug } from '../api/_lib/slug';
import { buildDrugSearchKey } from '../src/lib/drugNames';
import {
  loadPmConcentrationDataset,
  type PmConcentrationDataset,
  type PmConcentrationRow,
} from './pm-concentrations/dataset';
import {
  findAbsentAnalytes,
  storedRowMatches,
} from './pm-concentrations/compare';

const DEFAULT_USER_EMAIL =
  process.env.IMPORT_USER_EMAIL ?? 'agent@kinetix.internal';

interface Options {
  dryRun: boolean;
  userEmail: string;
  /** Path to the dataset JSON. Required; there is no in-repo default. */
  file: string | null;
  createDrugs: boolean;
  prune: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    userEmail: DEFAULT_USER_EMAIL,
    file: null,
    createDrugs: true,
    prune: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-create-drugs') opts.createDrugs = false;
    else if (a === '--prune') opts.prune = true;
    else if (a === '--user-email') opts.userEmail = argv[++i] ?? opts.userEmail;
    else if (a.startsWith('--user-email=')) {
      opts.userEmail = a.slice('--user-email='.length);
    } else if (a === '--file') opts.file = argv[++i] ?? opts.file;
    else if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * The dataset path, or a clear exit. The file is kept outside the repository
 * (the first cohort is unpublished), so there is nothing to fall back on.
 */
function requireDatasetPath(file: string | null): string {
  if (!file) {
    console.error(
      'Missing --file <path>. The PM concentration dataset is not in the\n' +
        'repository; pass the path to the dataset JSON explicitly, e.g.\n' +
        '  npm run seed:pm-concentrations -- --file /path/to/dataset.json --dry-run',
    );
    process.exit(1);
  }
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) {
    console.error(`Dataset file not found: ${path}`);
    process.exit(1);
  }
  return path;
}

async function resolveActorUserId(email: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) {
    throw new Error(
      `No user with email "${email}". Pass --user-email <address> for an existing account.`,
    );
  }
  return row.id;
}

/**
 * Upsert the cohort row and return its id.
 *
 * The metadata is owned by the dataset file: a corrected caveat or a reworded
 * heading is meant to reach every reader on the next run, and unlike the
 * numbers there is no independent editorial path that could be overwritten.
 */
async function upsertSource(dataset: PmConcentrationDataset): Promise<number> {
  const { source, study, caveats } = dataset;
  const [row] = await getDb()
    .insert(pmConcentrationSources)
    .values({
      key: source.key,
      citation: source.citation,
      shortLabel: source.shortLabel,
      heading: study.heading,
      matrix: study.matrix,
      unit: study.unit,
      description: study.design,
      caveats,
    })
    .onConflictDoUpdate({
      target: pmConcentrationSources.key,
      set: {
        citation: source.citation,
        shortLabel: source.shortLabel,
        heading: study.heading,
        matrix: study.matrix,
        unit: study.unit,
        description: study.design,
        caveats,
        updatedAt: new Date(),
      },
    })
    .returning({ id: pmConcentrationSources.id });
  return row!.id;
}

interface MatchedDrug {
  id: number;
  /** Display name, for the operator to eyeball the CID match against. */
  name: string;
}

/** Map every dataset CID to a drug in one query. */
async function loadDrugsByCid(
  rows: readonly PmConcentrationRow[],
): Promise<Map<number, MatchedDrug>> {
  const cids = rows.map((r) => r.pubchemCid);
  const found = await getDb()
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid, names: drugs.names })
    .from(drugs)
    .where(inArray(drugs.pubchemCid, cids));
  const byCid = new Map<number, MatchedDrug>();
  for (const d of found) {
    if (d.pubchemCid == null) continue;
    const names = d.names ?? {};
    byCid.set(d.pubchemCid, {
      id: d.id,
      name: names.nb ?? names.en ?? Object.values(names)[0] ?? `#${d.id}`,
    });
  }
  return byCid;
}

/**
 * Create the substance this cohort measured but the catalog does not hold.
 *
 * Named from PubChem's preferred title rather than the source table's printed
 * analyte name ("Diazepam, N-desmethyl-" is a column heading, not a substance
 * name); the printed name is kept as an alias so a search for it still lands
 * here. Only `en` is set — nobody should machine-translate a substance name —
 * and every creation is reported so a curator can add the Norwegian one.
 *
 * The molecular weight comes along because without it the whole overlay is
 * unusable for this substance: a Norwegian forensic reader works in µmol/L, and
 * a mass→molar conversion with no MW yields nothing to draw. It is written only
 * on creation, never onto an existing row.
 */
async function createDrug(
  row: PmConcentrationRow,
  actorUserId: number,
): Promise<number> {
  const displayName = row.displayName ?? row.pubchemName;
  const names = { en: displayName };
  const aliases = [row.analyte, row.pubchemName].filter(
    (name, index, all) =>
      name !== displayName && all.indexOf(name) === index,
  );
  const baseSlug = generateSlug(displayName);
  // `inTransaction`, not `runInPoolTransaction`: the whole seed now runs inside
  // one transaction, and nesting the pool helper would open a SECOND connection
  // whose unit commits independently of the outer rollback — and would block on
  // the advisory lock the outer connection holds while the outer awaits it.
  // That is a hang until timeout, not an error, and the integration harness
  // cannot see it (see api/_lib/db.ts).
  return inTransaction(async () => {
    const db = getDb();
    // A slug collision here means a substance with this name already exists
    // without the CID we matched on. Suffixing keeps the insert alive; the
    // creation report is what tells the curator to go look.
    let slug = baseSlug;
    for (let suffix = 2; suffix < 50; suffix++) {
      const [clash] = await db
        .select({ id: drugs.id })
        .from(drugs)
        .where(eq(drugs.slug, slug))
        .limit(1);
      if (!clash) break;
      slug = `${baseSlug}-${suffix}`;
    }
    const [inserted] = await db
      .insert(drugs)
      .values({
        slug,
        names,
        aliases,
        pubchemCid: row.pubchemCid,
        searchKey: buildDrugSearchKey({ names, aliases }),
      })
      .returning({ id: drugs.id });
    const drugId = inserted!.id;
    // Through the guarded store rather than a direct insert. Molecular weight
    // is identity metadata and could never be blocked for a substance this
    // seeder just created, so the check will always pass — but every bulk
    // writer that reasoned that way about its own parameter is now named in
    // tests/parameter-write-guards.ts, and the cheapest way not to become the
    // next entry is to call the guard.
    await upsertDrugParameter(
      db,
      drugId,
      'molecularWeight',
      row.molecularWeight,
      actorUserId,
    );
    await ensureDrugMonograph(
      db,
      { id: drugId, names, pubchemCid: row.pubchemCid },
      actorUserId,
    );
    return drugId;
  });
}

function numeric(value: number | null): string | null {
  return value == null ? null : String(value);
}

function printDataset(dataset: PmConcentrationDataset, dryRun: boolean): void {
  const { source, study } = dataset;
  console.log(
    `PM concentration seed${dryRun ? ' (dry run)' : ''}: ${source.citation}`,
  );
  console.log(`  cohort     : ${source.key}`);
  console.log(`  heading    : ${study.heading}`);
  console.log(`  matrix     : ${study.matrix} (${study.unit})`);
  console.log(`  rows       : ${dataset.entries.length} analytes`);
  if (!source.published) {
    console.log(
      '  note       : unpublished material — gated to admins and granted groups',
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const dataset = loadPmConcentrationDataset(requireDatasetPath(opts.file));
  printDataset(dataset, opts.dryRun);

  if (opts.dryRun) {
    for (const row of dataset.entries) {
      const flags = [
        row.anomaly ? 'ANOMALY' : null,
        row.reviewNote ? 'REVIEW' : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `  - ${row.analyte.padEnd(42)} CID ${String(row.pubchemCid).padEnd(10)}` +
          ` n=${String(row.n).padEnd(6)} median=${String(row.median).padEnd(9)}` +
          ` p90=${String(row.p90).padEnd(9)} ${flags}`,
      );
    }
    console.log('\nDry run: dataset is valid, nothing written.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (omit only with --dry-run).');
    process.exit(1);
  }

  const actorUserId = await resolveActorUserId(opts.userEmail);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const created: string[] = [];
  const missing: string[] = [];
  let orphans: { id: number; drugId: number; analyte: string }[] = [];
  let absent: string[] = [];

  // The whole cohort lands as ONE transaction: the source row, every
  // distribution, and the reconciliation below.
  //
  // Committing the source first is what makes a half-finished run dangerous
  // rather than merely incomplete. `unit` and `matrix` live on the source and
  // are what the client converts BY and qualifies the numbers WITH, so a run
  // that updated the metadata and then died would leave the API serving old
  // numeric rows interpreted under a new unit — a misconverted forensic value
  // with nothing to show it was wrong. This feature treats a distribution and
  // its source context as one unit of meaning; the write has to agree.
  //
  // The cost is one long transaction (one upsert per analyte, plus every
  // substance creation on the first run). Acceptable for an operator-run seeder, and the
  // alternative is a cohort that can be observed inconsistent.
  // Carried out of the transaction for the completeness check below, which has
  // to run after the commit to mean anything.
  let sourceId = 0;
  let drugByCid = new Map<number, MatchedDrug>();

  await runInPoolTransaction(async () => {
    sourceId = await upsertSource(dataset);
    drugByCid = await loadDrugsByCid(dataset.entries);

    for (const row of dataset.entries) {
      let drug = drugByCid.get(row.pubchemCid);
      if (!drug) {
        if (!opts.createDrugs) {
          missing.push(`${row.analyte} (CID ${row.pubchemCid})`);
          continue;
        }
        const displayName = row.displayName ?? row.pubchemName;
        const drugId = await createDrug(row, actorUserId);
        drug = { id: drugId, name: displayName };
        drugByCid.set(row.pubchemCid, drug);
        created.push(`${row.analyte} → ${displayName} (CID ${row.pubchemCid})`);
      }

      const values = {
        sourceId,
        drugId: drug.id,
        analyte: row.analyte,
        n: row.n,
        loq: numeric(row.loq),
        mean: numeric(row.mean),
        median: numeric(row.median),
        p90: numeric(row.p90),
        p95: numeric(row.p95),
        p975: numeric(row.p975),
        tcPlasma: numeric(row.tcPlasma),
        medianOverTc: numeric(row.medianOverTc),
        anomaly: row.anomaly ?? null,
        undrawable: row.undrawable ?? [],
        reviewNote: row.reviewNote ?? null,
        printed: row.printed ?? {},
      };

      const [existing] = await getDb()
        .select({
          id: pmConcentrationDistributions.id,
          analyte: pmConcentrationDistributions.analyte,
          n: pmConcentrationDistributions.n,
          loq: pmConcentrationDistributions.loq,
          mean: pmConcentrationDistributions.mean,
          median: pmConcentrationDistributions.median,
          p90: pmConcentrationDistributions.p90,
          p95: pmConcentrationDistributions.p95,
          p975: pmConcentrationDistributions.p975,
          tcPlasma: pmConcentrationDistributions.tcPlasma,
          medianOverTc: pmConcentrationDistributions.medianOverTc,
          anomaly: pmConcentrationDistributions.anomaly,
          undrawable: pmConcentrationDistributions.undrawable,
          reviewNote: pmConcentrationDistributions.reviewNote,
          printed: pmConcentrationDistributions.printed,
        })
        .from(pmConcentrationDistributions)
        .where(
          and(
            eq(pmConcentrationDistributions.sourceId, sourceId),
            eq(pmConcentrationDistributions.drugId, drug.id),
          ),
        )
        .limit(1);

      if (existing && storedRowMatches(existing, row)) {
        unchanged += 1;
        continue;
      }

      // The unique index on (source_id, drug_id) is what makes this safe under a
      // concurrent second run: the loser of the race updates instead of adding a
      // second distribution for the same cohort and drug.
      await getDb()
        .insert(pmConcentrationDistributions)
        .values(values)
        .onConflictDoUpdate({
          target: [
            pmConcentrationDistributions.sourceId,
            pmConcentrationDistributions.drugId,
          ],
          set: { ...values, updatedAt: new Date() },
        });

      if (existing) {
        updated += 1;
        console.log(`  ~ ${row.analyte} → ${drug.name}: updated`);
      } else {
        inserted += 1;
      }
    }

    // ── Reconcile: rows this cohort holds that the dataset no longer claims ──
    //
    // Identity here is (source, DRUG), not (source, analyte). Correcting an
    // analyte mapping — which the three `reviewNote` rows invite — means changing
    // a `pubchemCid`, and the re-run then upserts a row against the NEW drug
    // while the row under the old one survives untouched. Nothing in the write
    // path can notice: it only ever looks at the drugs the dataset names. So the
    // API would serve the same distribution for both the corrected substance and
    // the wrong one, and the curator who fixed the mapping would have no way to
    // tell from this seeder's output.
    //
    // Reported by default and deleted only with `--prune`, matching
    // `catalog:export`: a partial run (`--no-create-drugs`, a hand-trimmed
    // dataset file) legitimately names fewer drugs than the cohort holds, and
    // silently deleting the rest on the strength of that would be worse than
    // leaving a stale row for a human to look at.
    const seededDrugIds = new Set(
      dataset.entries
        .map((row) => drugByCid.get(row.pubchemCid)?.id)
        .filter((id): id is number => id != null),
    );
    const storedRows = await getDb()
      .select({
        id: pmConcentrationDistributions.id,
        drugId: pmConcentrationDistributions.drugId,
        analyte: pmConcentrationDistributions.analyte,
      })
      .from(pmConcentrationDistributions)
      .where(eq(pmConcentrationDistributions.sourceId, sourceId));
    orphans = storedRows.filter((r) => !seededDrugIds.has(r.drugId));

    if (orphans.length > 0 && opts.prune) {
      await getDb()
        .delete(pmConcentrationDistributions)
        .where(
          inArray(
            pmConcentrationDistributions.id,
            orphans.map((o) => o.id),
          ),
        );
    }
  });

  // ── Completeness: analytes the dataset claims but the cohort does NOT hold ──
  //
  // Deliberately AFTER the commit, and re-read rather than derived from what
  // the loop above believes it wrote.
  //
  // `drug_id` is ON DELETE CASCADE, so deleting a substance deletes its
  // distribution — and merging a duplicate away is ordinary catalog curation,
  // done from a different screen by someone who has never heard of this cohort.
  // A delete that starts while this seed is running does not fail and does not
  // wait forever: it blocks on the foreign key until this transaction commits,
  // and then proceeds. Inside the transaction the row is therefore always
  // present and the check always passes, moments before the row is removed.
  // That is the exact incident this check exists for — Ephedrine, first
  // production seed — so an in-transaction count would have missed the one case
  // it was written to catch.
  //
  // Reading after the commit does not make this airtight; nothing short of
  // holding a lock on `drugs` would, and a seeder has no business doing that.
  // It makes the window small and, more to the point, on the right side of the
  // event: a delete that has already happened is now visible.
  //
  // The reconciliation above looks the other way round — stored rows the
  // dataset no longer claims — and that is not the direction that fails
  // quietly. Entries with no drug at all are reported as `missing`
  // (--no-create-drugs) and left out here, so the two lists never describe the
  // same gap twice.
  const committedDrugIds = new Set(
    (
      await getDb()
        .select({ drugId: pmConcentrationDistributions.drugId })
        .from(pmConcentrationDistributions)
        .where(eq(pmConcentrationDistributions.sourceId, sourceId))
    ).map((r) => r.drugId),
  );
  absent = findAbsentAnalytes(
    dataset.entries,
    new Map([...drugByCid].map(([cid, drug]) => [cid, drug.id])),
    committedDrugIds,
  );

  console.log('');
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated:  ${updated}`);
  console.log(`Same:     ${unchanged}`);
  if (orphans.length > 0) {
    const verb = opts.prune ? 'Deleted' : 'Stale';
    console.warn(
      `\n${verb} rows this dataset no longer claims (${orphans.length}):`,
    );
    for (const orphan of orphans) {
      console.warn(`  ${opts.prune ? '-' : '!'} ${orphan.analyte} (drug #${orphan.drugId})`);
    }
    if (!opts.prune) {
      console.warn(
        'Most likely a corrected analyte mapping: the distribution now also\n' +
          'exists under the new substance, so the API serves both. Re-run with\n' +
          '--prune to delete these, once you have checked they are not simply\n' +
          'analytes this run skipped.',
      );
    }
  }
  if (created.length > 0) {
    console.warn(`\nSubstances created (${created.length}):`);
    for (const line of created) console.warn(`  + ${line}`);
    console.warn(
      'Each has an English name from PubChem and no substance class. Add the\n' +
        'Norwegian name, and classify the ones nobody administers in\n' +
        'data/substanceClasses.ts, then run backfill:substance-classes.',
    );
  }
  if (missing.length > 0) {
    console.warn(
      `\nSubstance not in database (${missing.length}, skipped because --no-create-drugs): ${missing.join(', ')}`,
    );
  }
  const flagged = dataset.entries.filter((e) => e.reviewNote);
  if (flagged.length > 0) {
    console.warn(`\nAnalyte mapping needs a human (${flagged.length}):`);
    for (const row of flagged) {
      console.warn(`  ! ${row.analyte} → CID ${row.pubchemCid}: ${row.reviewNote}`);
    }
  }
  // Last, loudest, and the only line here that changes the exit status: a
  // cohort that is short a row still renders perfectly. The drug just looks
  // like one the source never measured, which is a thing 100+ real substances
  // in this catalog genuinely are, so there is no visible difference to notice.
  if (absent.length > 0) {
    console.error(
      `\nCOHORT INCOMPLETE — ${absent.length} of ${dataset.entries.length} analytes have no row after this run:`,
    );
    for (const line of absent) console.error(`  × ${line}`);
    console.error(
      'The write reported success, so this is not a failed insert: the row was\n' +
        'committed and then removed. drug_id is ON DELETE CASCADE, so deleting\n' +
        'or merging away the substance takes its distribution with it, and a\n' +
        'delete that overlapped this run was queued behind it on the foreign\n' +
        'key. Point the dataset at the surviving CID and re-run.',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
