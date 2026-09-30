/**
 * Backfill molecular weight for drugs that have no `molecularWeight`
 * value yet (#302 P2 stores MW in `drug_parameters`, kind `number`,
 * unit g/mol). Pulls the canonical value from PubChem PUG-REST in
 * batched CID lookups — the same upstream the create-form autocomplete
 * (api/pubchem-search.ts) already uses, so the data source is consistent
 * with how MW is filled when a drug is created by hand.
 *
 * A drug is only resolvable here if it carries a `pubchem_cid`; rows
 * without one (genes, biologics, bespoke metabolite codes such as PEth)
 * are reported and skipped — they have no small-molecule MW to fetch and
 * should be curated by hand.
 *
 * Usage:
 *   tsx scripts/backfill-molecular-weights.ts            # dry run (default)
 *   tsx scripts/backfill-molecular-weights.ts --apply    # write to DB
 *
 * Writes are attributed to the claude-agent service user and upsert into
 * `drug_parameters` (the row is created only when absent, so existing MW
 * values are never overwritten — the query already filters them out).
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { sql as drizzleSql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import { withDrugApplicabilityLock } from '../api/_lib/parameterApplicabilityStore.js';
import { writeBlockedSql } from '../api/_lib/parameterGapsSql.js';

// Lazily constructed: this module is imported by
// tests/integration/parameter-applicability-write-paths.test.ts for
// `writeMolecularWeight`, and `neon()` throws at construction when
// DATABASE_URL is unset — which is exactly the CI shape (no database, PGlite
// in-process). Building the client at module scope made importing the script
// fail there.
let sqlClient: ReturnType<typeof neon> | null = null;
/**
 * The accessor returns the client itself rather than wrapping its call
 * signature: the neon client is a tagged-template function that ALSO carries
 * `.query()`, and a wrapper forwarding only the call drops that half of the
 * surface — `writeBlocked` uses `.query` and would fail at runtime on the
 * first drug whose weight was fetched. Nothing typechecks this file
 * (tsconfig.migrations.json is deliberately narrow), so returning the real
 * client is what keeps the two halves together.
 */
function sql(): ReturnType<typeof neon> {
  sqlClient ??= neon(process.env.DATABASE_URL!);
  return sqlClient;
}

const APPLY = process.argv.includes('--apply');

/** How this script's statements name the three values the guard needs. */
const MW_COLUMNS = {
  drugId: 'd.id',
  parameter: `'molecularWeight'`,
  substanceClass: 'd.substance_class',
} as const;

/** drizzle's execute() returns `{ rows }` on some drivers and a bare array on others. */
function rowsOf(result: unknown): unknown[] {
  const r = result as { rows?: unknown[] };
  return r.rows ?? (result as unknown[]);
}

/** The shared predicate, rendered once; each caller binds its own drug id. */
const WRITE_BLOCKED_FRAGMENT = writeBlockedSql(MW_COLUMNS);

/**
 * Would a molecularWeight write for this drug be refused, as of right now?
 *
 * On the plain client, so the answer can go stale the moment it returns. Used
 * only to decide what to *report* before attempting a write.
 */
async function writeBlocked(drugId: number): Promise<boolean> {
  const rows = (await sql().query(
    `SELECT 1 FROM drugs d WHERE d.id = $1 AND ${WRITE_BLOCKED_FRAGMENT}`,
    [drugId],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * The same question asked on the transactional client, so it must be called
 * inside `withDrugApplicabilityLock` — where the answer cannot change under
 * it. The plain-client version above would read on a *different* connection
 * and so would not be covered by the lock at all, which is the whole failure
 * this file already made once.
 */
async function writeBlockedUnderLock(drugId: number): Promise<boolean> {
  const rows = rowsOf(
    await getDb().execute(
      drizzleSql`SELECT 1 FROM drugs d WHERE d.id = ${drugId} AND ${drizzleSql.raw(WRITE_BLOCKED_FRAGMENT)}`,
    ),
  );
  return rows.length > 0;
}

export type MwWriteOutcome = 'written' | 'blocked' | 'already-present';

/**
 * Write one molecularWeight, and say what actually happened.
 *
 * Under the per-drug advisory lock, on the transactional client, like every
 * other guarded writer. Folding the marker lookup into the INSERT is NOT
 * enough on its own: the two sides write different tables, so nothing
 * conflicts at row level, and under READ COMMITTED a marker transaction can
 * commit between this statement's snapshot and its write. A statement is
 * atomic; it is not serializable against a writer touching a different table.
 *
 * The WHERE clause stays as the check — it just needs the lock around it to
 * mean anything. And the statement's **own outcome** is what the caller gets:
 * the run's pre-check happens unlocked, so a marker landing in between makes
 * it stale, and counting a refused INSERT as a write would hand the operator a
 * tally saying the gap is filled when it is not. A backfill that silently
 * skips is indistinguishable from one that worked — the failure this whole
 * feature exists to prevent, in miniature.
 *
 * Exported so the integration tests exercise this rather than a paraphrase.
 */
export async function writeMolecularWeight(
  drugId: number,
  mw: number,
  updatedBy: number,
): Promise<MwWriteOutcome> {
  return withDrugApplicabilityLock(drugId, async (): Promise<MwWriteOutcome> => {
    const inserted = rowsOf(
      await getDb().execute(
        drizzleSql`
          INSERT INTO drug_parameters (drug_id, parameter, value, updated_by, updated_at)
          SELECT d.id, 'molecularWeight', ${JSON.stringify(mw)}::jsonb, ${updatedBy}, now()
          FROM drugs d
          WHERE d.id = ${drugId}
            AND NOT ${drizzleSql.raw(WRITE_BLOCKED_FRAGMENT)}
          ON CONFLICT (drug_id, parameter) DO NOTHING
          RETURNING drug_id`,
      ),
    );
    if (inserted.length > 0) return 'written';
    // Zero rows has two causes and they are not the same news: the guard
    // refused, or someone filled the value while we were fetching.
    return (await writeBlockedUnderLock(drugId)) ? 'blocked' : 'already-present';
  });
}

// MW bounds mirror the parameter spec (src/lib/drugParameters.ts →
// molecularWeight: positive, max 100_000 g/mol). Anything outside this
// range is treated as a bad upstream value and skipped rather than
// written.
const MW_MIN = 0.0001;
const MW_MAX = 100_000;

// claude-agent@kinetix.internal — the service user backfill writes are
// attributed to (drug_parameters.updated_by).
const AGENT_EMAIL = 'claude-agent@kinetix.internal';

// PubChem accepts comma-separated CIDs on the property endpoint. Keep the
// batch well under the URL-length / request-size ceiling and pace the
// requests to respect PUG-REST's ~5 req/s guidance.
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 250;
const PUG_REST =
  'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid';

interface MissingDrug {
  id: number;
  slug: string;
  names: Record<string, string>;
  pubchem_cid: number | null;
}

function drugLabel(d: MissingDrug): string {
  return d.names?.en ?? d.names?.nb ?? Object.values(d.names ?? {})[0] ?? d.slug;
}

/**
 * Biologics (monoclonal antibodies `-mab`, fusion proteins `-cept`) and
 * gene/enzyme symbols (e.g. UGT1A4, CYP2D6) sometimes carry a
 * `pubchem_cid` that resolves to a small-molecule MW which is NOT the
 * macromolecule's true mass. Backfilling those would store a misleading
 * value, so they are excluded here and left for hand curation — matching
 * the no-CID skip list rather than the small-molecule fill path.
 */
function isBiologicOrGene(label: string): boolean {
  const n = label.toLowerCase();
  // `-mab` INN stem, including modified forms like "certolizumab pegol"
  // where the stem is not the final token (match "mab" not followed by
  // another letter).
  if (/mab(?![a-z])/.test(n)) return true; // monoclonal antibody
  if (/cept(?![a-z])/.test(n)) return true; // fusion protein (etanercept, abatacept…)
  // Gene/enzyme symbol: an all-caps token containing a digit (UGT1A4,
  // CYP2D6, SLCO1B1, NUDT15). Lowercase drug names never match this.
  if (/^[A-Z0-9]{2,}$/.test(label) && /[0-9]/.test(label)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch MW for a batch of CIDs. Returns cid → MW (numbers only). */
async function fetchBatch(cids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const url = `${PUG_REST}/${cids.join(',')}/property/MolecularWeight/JSON`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`PubChem ${res.status} for ${cids.length} CIDs`);
  }
  const data = (await res.json()) as {
    PropertyTable?: { Properties?: Array<{ CID?: number; MolecularWeight?: unknown }> };
  };
  for (const p of data.PropertyTable?.Properties ?? []) {
    if (typeof p.CID !== 'number') continue;
    const raw = p.MolecularWeight;
    const mw = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
    if (Number.isFinite(mw)) out.set(p.CID, mw);
  }
  return out;
}

async function run(): Promise<void> {
  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console

  // The neon client's return type is a union over its several result shapes,
  // so the row array is named explicitly rather than destructured off it.
  const agents = (await sql()`
    SELECT id FROM users WHERE email = ${AGENT_EMAIL} LIMIT 1
  `) as Array<{ id: number }>;
  const agent = agents[0];
  if (!agent) {
    throw new Error(`Service user ${AGENT_EMAIL} not found — cannot attribute writes.`);
  }
  const agentId = agent.id;

  const missing = (await sql()`
    SELECT d.id, d.slug, d.names, d.pubchem_cid
    FROM drugs d
    WHERE NOT EXISTS (
      SELECT 1 FROM drug_parameters dp
      WHERE dp.drug_id = d.id AND dp.parameter = 'molecularWeight'
    )
    ORDER BY d.popularity_score DESC, d.id ASC
  `) as MissingDrug[];

  const noCid = missing.filter((d) => d.pubchem_cid == null);
  const withCid = missing.filter((d) => d.pubchem_cid != null);
  const biologicOrGene = withCid.filter((d) => isBiologicOrGene(drugLabel(d)));
  const resolvable = withCid.filter((d) => !isBiologicOrGene(drugLabel(d)));

  log(`Drugs missing molecularWeight: ${missing.length}`);
  log(`  resolvable via pubchem_cid:  ${resolvable.length}`);
  log(`  biologic/gene (skipped):     ${biologicOrGene.length}`);
  log(`  no pubchem_cid (skipped):    ${noCid.length}`);
  log(`Mode: ${APPLY ? 'APPLY (writing to DB)' : 'DRY RUN (no writes)'}\n`);

  // Map CID → list of drugs (a CID is unique per drug in this table, but
  // guard against surprises so a shared CID still updates every owner).
  const byCid = new Map<number, MissingDrug[]>();
  for (const d of resolvable) {
    const list = byCid.get(d.pubchem_cid!) ?? [];
    list.push(d);
    byCid.set(d.pubchem_cid!, list);
  }
  const cids = [...byCid.keys()];

  const fetched = new Map<number, number>();
  for (let i = 0; i < cids.length; i += BATCH_SIZE) {
    const batch = cids.slice(i, i + BATCH_SIZE);
    try {
      const result = await fetchBatch(batch);
      for (const [cid, mw] of result) fetched.set(cid, mw);
      log(`  fetched ${result.size}/${batch.length} (batch ${i / BATCH_SIZE + 1})`);
    } catch (err) {
      log(`  batch ${i / BATCH_SIZE + 1} failed: ${(err as Error).message}`);
    }
    if (i + BATCH_SIZE < cids.length) await sleep(BATCH_DELAY_MS);
  }

  let written = 0;
  const blocked: string[] = [];
  const alreadyPresent: string[] = [];
  const outOfBounds: string[] = [];
  const noMw: string[] = [];

  for (const [cid, drugsForCid] of byCid) {
    const mw = fetched.get(cid);
    for (const d of drugsForCid) {
      const label = `${drugLabel(d)} (#${d.id}, cid=${cid})`;
      if (mw == null) {
        noMw.push(label);
        continue;
      }
      if (mw < MW_MIN || mw > MW_MAX) {
        outOfBounds.push(`${label} → ${mw}`);
        continue;
      }
      // An editor can mark (drug, molecularWeight) not applicable, and this
      // raw-SQL path never went through upsertDrugParameter, so nothing here
      // used to stop it publishing a value beside that marker. Reported
      // separately rather than silently dropped — a backfill that quietly
      // skips rows is indistinguishable from one that worked.
      if (await writeBlocked(d.id)) {
        blocked.push(label);
        continue;
      }
      if (!APPLY) {
        written += 1;
        log(`  would write ${label} → ${mw} g/mol`);
        continue;
      }

      const outcome = await writeMolecularWeight(d.id, mw, agentId);

      if (outcome === 'blocked') {
        blocked.push(`${label} (marked while this run was in progress)`);
        continue;
      }
      if (outcome === 'already-present') {
        alreadyPresent.push(label);
        continue;
      }
      written += 1;
      log(`  wrote ${label} → ${mw} g/mol`);
    }
  }

  log(`\n── Summary ──`);
  log(`${APPLY ? 'Wrote' : 'Would write'} molecularWeight for ${written} drug(s).`);
  if (noMw.length) {
    log(`\nPubChem returned no MW for ${noMw.length} CID(s):`);
    for (const l of noMw) log(`  - ${l}`);
  }
  if (alreadyPresent.length) {
    log(
      `\nSkipped ${alreadyPresent.length} drug(s) whose molecularWeight was filled while this run was fetching:`,
    );
    for (const l of alreadyPresent) log(`  - ${l}`);
  }
  if (blocked.length) {
    log(
      `\nSkipped ${blocked.length} drug(s) whose molecularWeight is marked not applicable:`,
    );
    for (const l of blocked) log(`  - ${l}`);
  }
  if (outOfBounds.length) {
    log(`\nSkipped ${outOfBounds.length} out-of-bounds value(s):`);
    for (const l of outOfBounds) log(`  - ${l}`);
  }
  if (biologicOrGene.length) {
    log(`\nSkipped ${biologicOrGene.length} biologic/gene row(s) (CID MW is misleading; curate by hand):`);
    for (const d of biologicOrGene) log(`  - ${drugLabel(d)} (#${d.id}, cid=${d.pubchem_cid})`);
  }
  if (noCid.length) {
    log(`\nSkipped ${noCid.length} drug(s) with no pubchem_cid (curate by hand):`);
    for (const d of noCid) log(`  - ${drugLabel(d)} (#${d.id})`);
  }
  if (!APPLY) log(`\nRe-run with --apply to write these values.`);
}

// Only when invoked as a CLI. Importing this module (the integration suite
// pulls in `writeMolecularWeight`) must not run the script — it would query the
// real database named by DATABASE_URL, and its failure path calls
// `process.exit`, which would take the test worker with it.
if (process.argv[1]?.endsWith('backfill-molecular-weights.ts')) {
  run().catch((err) => {
    console.error(err); // eslint-disable-line no-console
    process.exit(1);
  });
}
