/**
 * Apply the catalog's metabolite links to an existing database.
 *
 * Dry-run by default; `--apply` writes.
 *
 * ## Why this exists
 *
 * `data/components.ts` is a seed source and an offline fallback, **not** a
 * mirror of the database (AGENTS.md). `scripts/seed-drugs.ts` pushes it in, and
 * a production deploy does not run the seeder — so a metabolite added to the
 * fixture reaches a fresh install and no existing one. That is invisible until
 * something reads the edge: the pattern profile's source walk does, and a
 * missing methadone→EDDP edge is the difference between an assessment that can
 * resolve its sources and one that reports the graph uncurated.
 *
 * ## What it will and will not do
 *
 * - **Inserts the pairs listed below**, and only those. An earlier version
 *   walked the whole fixture, which reads absence from the live table as
 *   evidence the edge belongs there — and it is not: a curator who *deleted* a
 *   wrong link would have it restored on every run, silently, by a script whose
 *   whole purpose is to be safe against a live database. The fixture is a seed
 *   source, not a mirror, so each rollout states the edges it is for.
 * - **Never deletes and never rewrites.** The seeder replaces a drug's links
 *   wholesale, which is right when it owns the row and wrong here: this runs
 *   against a database where curators, the research importer and the
 *   farmakologiportalen importer have all been writing, and a fixture that has
 *   not caught up would silently drop their work. An existing link is left
 *   exactly as it is, including its activity and its conversion fractions.
 * - **Reports** a pair it cannot act on: a substance the catalog has not
 *   entered, or a parent that already carries an unresolved free-text row under
 *   the metabolite's name. The insert would collide with the parent-and-name
 *   index there, and resolving that row in place would be the rewrite this
 *   script promises not to do.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, inArray } from 'drizzle-orm';

import { drugMetabolites, drugs } from '../db/schema.js';
import { normalizeMetabolismName } from '../src/lib/metabolism.js';

/**
 * The connection the CLI runs against.
 *
 * Built when the run starts rather than when the module loads. A missing
 * `DATABASE_URL` is a fatal condition for the *command* and no condition at all
 * for an importer — a test that hands this its own database was killed at
 * import by a guard about a variable it never needed, and the failure surfaced
 * as the test file exiting the process rather than as anything about the test.
 */
function cliDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  return drizzle(neon(url));
}

/**
 * The edges this rollout is for, by PubChem CID on both sides.
 *
 * By identity rather than by name, which removes the resolution question
 * entirely: a normalised name can match two substances across languages, and an
 * edge pointed at whichever row a database returned first is a coin toss
 * deciding what a forensic source assessment reads.
 *
 * Each entry is a deliberate statement that this edge should exist in every
 * database, not a diff against the fixture. Adding one is a review, and
 * removing it once it has rolled out costs nothing.
 */
const ROLLOUT: ReadonlyArray<{ parentCid: number; metaboliteCid: number; why: string }> = [
  {
    parentCid: 4095,
    metaboliteCid: 5352621,
    why: 'Methadone → EDDP, the N-demethylation product the methadone module walks (#1080)',
  },
];

const log = (line: string) => console.log(line);

/**
 * `database` is a parameter so the rollout can be run against a test database.
 * A script that builds its own connection cannot be exercised at all, and this
 * one writes to a live catalog — the place where an untested guard is worth
 * least.
 */
export async function run(
  database?: ReturnType<typeof cliDb>,
  apply = process.argv.includes('--apply'),
): Promise<void> {
  const APPLY = apply;
  const db = database ?? cliDb();
  const cids = [...new Set(ROLLOUT.flatMap((edge) => [edge.parentCid, edge.metaboliteCid]))];
  const rows = await db
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid, names: drugs.names })
    .from(drugs)
    .where(inArray(drugs.pubchemCid, cids));

  const byCid = new Map<number, { id: number; label: string; names: string[] }>();
  for (const row of rows) {
    if (!row.pubchemCid) continue;
    const names = Object.values(row.names ?? {}).filter(Boolean);
    byCid.set(row.pubchemCid, {
      id: row.id,
      // The substance's own name in the catalog's primary language, since the
      // label is what a monograph prints. The table keys on the substance
      // either way (0099).
      label: row.names?.nb ?? row.names?.en ?? names[0] ?? '',
      // Every language, for the collision check below.
      names,
    });
  }

  const inserted: string[] = [];
  const present: string[] = [];
  const missing: string[] = [];
  const blocked: string[] = [];

  for (const edge of ROLLOUT) {
    const parent = byCid.get(edge.parentCid);
    const target = byCid.get(edge.metaboliteCid);
    if (!parent || !target) {
      missing.push(
        `CID ${edge.parentCid} → ${edge.metaboliteCid}: ` +
          `${!parent ? 'parent' : 'metabolite'} not in this database — ${edge.why}`,
      );
      continue;
    }

    const [existing] = await db
      .select({ id: drugMetabolites.id })
      .from(drugMetabolites)
      .where(
        and(
          eq(drugMetabolites.parentDrugId, parent.id),
          eq(drugMetabolites.metaboliteDrugId, target.id),
        ),
      )
      .limit(1);
    if (existing) {
      present.push(`${parent.label} → ${target.label}`);
      continue;
    }

    // A row naming this metabolite in free text, pointing at no substance. The
    // insert below would carry the same label and collide with
    // `drug_metabolites_parent_name_idx` — and since each insert commits on its
    // own, the failure would abort the run partway through, having written some
    // links and not others, after a dry run that said all of them would
    // succeed.
    //
    // Reported rather than resolved in place. Pointing the row at the substance
    // is very likely what it wants, and it is still a rewrite of a row somebody
    // else wrote.
    //
    // Checked against every language the substance is named in, not just the
    // label about to be written: whoever entered the free-text row wrote it in
    // *their* language, so an English name sitting on a Norwegian catalog entry
    // is the ordinary case rather than the exotic one — and a link inserted
    // beside it prints the same metabolite twice in the monograph.
    const wanted = new Set(target.names.map(normalizeMetabolismName));
    const rowsOnParent = await db
      .select({ id: drugMetabolites.id, name: drugMetabolites.metaboliteName })
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, parent.id));
    const byLabel = rowsOnParent.find((row) => wanted.has(normalizeMetabolismName(row.name)));
    if (byLabel) {
      blocked.push(`${parent.label} → ${target.label}`);
      continue;
    }

    if (APPLY) {
      await db.insert(drugMetabolites).values({
        parentDrugId: parent.id,
        metaboliteDrugId: target.id,
        metaboliteName: target.label,
      });
    }
    inserted.push(`${parent.label} → ${target.label}`);
  }

  log(`── Catalog metabolite links ──`);
  log(`${APPLY ? 'Linked' : 'Would link'} ${inserted.length} of ${ROLLOUT.length} listed pair(s).`);
  for (const line of inserted) log(`  + ${line}`);
  log(`${present.length} pair(s) already linked, left untouched.`);

  if (blocked.length) {
    log(
      `\n${blocked.length} pair(s) already have a row under that name pointing at no` +
        ` substance — an unresolved free-text link somebody entered:`,
    );
    for (const line of blocked) log(`  - ${line}`);
    log(`  Link the existing row to the substance by hand, then re-run.`);
  }

  if (missing.length) {
    log(`\n${missing.length} listed pair(s) name a substance this database does not carry:`);
    for (const line of missing) log(`  - ${line}`);
  }

  if (!APPLY) log(`\nDry run. Re-run with --apply to write.`);
}

if (process.argv[1]?.endsWith('backfill-metabolite-links.ts')) {
  await run();
}
