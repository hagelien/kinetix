/**
 * Bulk-seed a single drug's knowledge base from a deep-research JSON document
 * (#drug-database-bulk-seed).
 *
 * Consumes a `kinetix-deep-research-output-v1` file produced by the research
 * agent (see agents/deep-research-drug-seeding.md) and writes it straight to
 * the database — the drug row, its PK/PD/chemistry/dose/concentration
 * parameters, the citations backing them, pharmacodynamic target
 * relationships, and the metabolism box — in one pass. This is the "kick
 * start": instead of the maintenance agent seeding a drug parameter-by-
 * parameter over weeks, a single reviewed research run populates the whole
 * substance at once.
 *
 * It is an ADMIN / OPERATOR tool. Like scripts/seed-drugs.ts and
 * scripts/import-farmakologiportalen.ts it talks to the DB directly with a raw
 * neon client, bypassing the API's pending-edit review queue and the
 * agent-only reference gate. Every seeded parameter still records a revision
 * with its citations, so the provenance is auditable and the paper-review
 * agents can review the cited sources afterwards. Seeded rows are stamped
 * `drugs.source = 'deep-research'`.
 *
 * Safety defaults:
 *   - Idempotent: re-running never duplicates rows.
 *   - Non-destructive: existing curated parameter values are NOT overwritten
 *     unless `--overwrite` is passed.
 *   - `--dry-run` validates + prints the plan without writing (no DB needed).
 *
 * Usage:
 *   npm run import:research -- --file cocaine.json
 *   npm run import:research -- --file cocaine.json --dry-run
 *   npm run import:research -- --file cocaine.json --overwrite
 *   npm run import:research -- --file cocaine.json --user-email me@example.com
 *   cat cocaine.json | npm run import:research -- --stdin
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import {
  MIN_SOURCES_PER_PARAMETER,
  parseResearchOutput,
  recountSourceValueCoverage,
  thinlySourcedParameters,
  type NormalizedResearchImport,
} from '../src/lib/deepResearchImport';
import { runImport } from '../api/_lib/researchImportStore';
import { resolveImportCrosswalk } from '../api/_lib/citation-crosswalk';

const DEFAULT_USER_EMAIL = process.env.IMPORT_USER_EMAIL ?? 'agent@kinetix.internal';

interface Options {
  file: string | null;
  stdin: boolean;
  dryRun: boolean;
  overwrite: boolean;
  userEmail: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: null, stdin: false, dryRun: false, overwrite: false, userEmail: DEFAULT_USER_EMAIL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--file') opts.file = argv[++i] ?? null;
    else if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else if (a === '--user-email') opts.userEmail = argv[++i] ?? opts.userEmail;
    else if (a.startsWith('--user-email=')) opts.userEmail = a.slice('--user-email='.length);
  }
  return opts;
}

function readInput(opts: Options): string {
  if (opts.stdin || !opts.file) return readFileSync(0, 'utf8');
  return readFileSync(opts.file, 'utf8');
}

function printPlan(data: NormalizedResearchImport, opts: Options): void {
  const nm = data.drug.nameNb || data.drug.nameEn;
  console.log(
    `Deep-research import${opts.dryRun ? ' (dry run)' : ''}: ${nm}` +
      (data.drug.pubchemCid ? `  CID ${data.drug.pubchemCid}` : ''),
  );
  console.log(`  parameters : ${data.parameters.length}`);
  // Source-value coverage is per parameter, so print it per parameter: the
  // readings that will become `parameter_entries` rows, and a marker on the
  // ones pooled from fewer sources than the prompt asks for.
  const thin = new Map(
    thinlySourcedParameters(data.parameters, data.sources).map((t) => [t.parameter, t.sources]),
  );
  for (const p of data.parameters) {
    const readings = p.sourceValues.length
      ? `  ${p.sourceValues.length} source value(s)`
      : '';
    const marker = thin.has(p.parameter)
      ? `  ! ${thin.get(p.parameter)}/${MIN_SOURCES_PER_PARAMETER} papers`
      : '';
    console.log(
      `     - ${p.parameter}${p.sourceIds.length ? `  [${p.sourceIds.join(', ')}]` : '  (no source)'}` +
        `${readings}${marker}`,
    );
  }
  if (data.ionizationConstants.length) {
    console.log(`  ionization : ${data.ionizationConstants.length} constant(s)`);
    for (const c of data.ionizationConstants) {
      console.log(
        `     - pKa ${c.pKa}  ${c.protonatedCharge} → ${c.deprotonatedCharge}  ` +
          `${c.evidenceType}${c.type === 'microscopic' ? ' (microscopic)' : ''}` +
          `${c.sourceIds.length ? `  [${c.sourceIds.join(', ')}]` : '  (no source)'}`,
      );
    }
  }
  console.log(`  sources    : ${data.sources.length}`);
  console.log(`  PD targets : ${data.pharmacodynamicTargets.length}`);
  console.log(
    `  routes     : ${data.metabolism.eliminationRoutes.length}, metabolites: ${data.metabolism.metabolites.length}, enzyme interactions: ${data.metabolism.enzymeInteractions.length}`,
  );
  if (data.warnings.length) {
    console.log(`  warnings   : ${data.warnings.length}`);
    for (const w of data.warnings) console.log(`     ! ${w}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL && !opts.dryRun) {
    console.error('DATABASE_URL is required (omit only with --dry-run).');
    process.exit(1);
  }

  let rawText: string;
  try {
    rawText = readInput(opts);
  } catch (err) {
    console.error(`Could not read input: ${(err as Error).message}`);
    process.exit(1);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    console.error(`Input is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = parseResearchOutput(json);
  if (!result.ok) {
    console.error('Document failed validation:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const data = result.data;
  printPlan(data, opts);

  if (opts.dryRun) {
    console.log('\nDry run — no database writes performed.');
    return;
  }

  const client = neon(DATABASE_URL!);
  const db = drizzle(client);

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, opts.userEmail))
    .limit(1);
  if (!user) {
    console.error(
      `No user found for --user-email "${opts.userEmail}". Run \`npm run seed:agent-user\` ` +
        'or pass an existing admin/editor email.',
    );
    process.exit(1);
  }

  // Same crosswalk the admin route resolves: one paper, one citation row
  // (#1018), even when this document declares a DOI for a paper already filed
  // under its PMID.
  const crosswalk = await resolveImportCrosswalk(data.sources);
  // With the crosswalk in hand, two sources NCBI placed on one article are
  // known to be one paper — so the coverage count printed at the end is the one
  // that matches the citation rows this run wrote, not the one the plan above
  // could establish from the document alone.
  const warnings = recountSourceValueCoverage(data, crosswalk);

  const stats = await runImport(db, data, {
    userId: user.id,
    overwrite: opts.overwrite,
    crosswalk,
  });

  console.log('\nImport summary:');
  console.log(`  drug id              : ${stats.drugId}${stats.drugCreated ? ' (created)' : ' (matched)'}`);
  console.log(`  citations upserted   : ${stats.citations}`);
  console.log(
    `  parameters written   : ${stats.parameters}` +
      (stats.parametersSkipped ? ` (${stats.parametersSkipped} kept existing — pass --overwrite to replace)` : ''),
  );
  if (
    stats.ionizationConstants ||
    stats.ionizationConstantsUpdated ||
    stats.ionizationConstantsSkipped ||
    stats.ionizationConstantsKept
  ) {
    console.log(
      `  ionization constants : ${stats.ionizationConstants} written` +
        (stats.ionizationConstantsUpdated ? `, ${stats.ionizationConstantsUpdated} updated` : '') +
        (stats.ionizationConstantsSkipped ? `, ${stats.ionizationConstantsSkipped} already present` : '') +
        (stats.ionizationConstantsKept
          ? `, ${stats.ionizationConstantsKept} kept (curated or needs --overwrite)`
          : ''),
    );
  }
  console.log(`  PD targets linked    : ${stats.pdTargets}`);
  console.log(`  elimination routes   : ${stats.routes}`);
  console.log(`  metabolite links     : ${stats.metabolites}`);
  console.log(`  enzyme interactions  : ${stats.enzymeInteractions}`);
  if (
    stats.entries ||
    stats.entriesUpdated ||
    stats.entriesSkipped ||
    stats.entrySourcesUnresolved
  ) {
    console.log(
      `  source values        : ${stats.entries} written` +
        (stats.entriesUpdated ? `, ${stats.entriesUpdated} updated` : '') +
        (stats.entriesSkipped ? `, ${stats.entriesSkipped} already present` : '') +
        (stats.entrySourcesUnresolved
          ? `, ${stats.entrySourcesUnresolved} dropped (source never resolved)`
          : ''),
    );
  }
  if (stats.entriesKept.length) {
    const total = stats.entriesKept.reduce((n, k) => n + k.entries, 0);
    console.log(
      `\n${total} source value(s) read differently from rows a previous run wrote and were\n` +
        'left as they are. Re-run with --overwrite to apply the corrected readings:',
    );
    for (const k of stats.entriesKept) {
      console.log(`  ! ${k.parameter} (${k.entries} value(s))`);
    }
  }
  if (stats.entriesInvalid.length) {
    console.log(
      `\n${stats.entriesInvalid.length} source value(s) were rejected by the parameter registry:`,
    );
    for (const k of stats.entriesInvalid) {
      console.log(`  ! ${k.parameter}: ${k.message}`);
    }
  }
  if (stats.sourcesAttachedToUnchanged) {
    console.log(
      `  sources attached     : ${stats.sourcesAttachedToUnchanged} parameter(s) already held the researched value and gained its citations`,
    );
  }
  if (stats.keptWithUnattachedSources.length) {
    const total = stats.keptWithUnattachedSources.reduce(
      (n, k) => n + k.sources,
      0,
    );
    console.log(
      `\n${total} cited source(s) were NOT attached: these parameters kept their existing value,\n` +
        'so no revision was written to carry the citations. Re-run with --overwrite to seed the\n' +
        'researched values (and their sources), or reconcile the parameters by hand:',
    );
    for (const k of stats.keptWithUnattachedSources) {
      console.log(`  ! ${k.parameter} (${k.sources} source(s))`);
    }
  }
  if (stats.metabolitesKept.length) {
    console.log(
      `\n${stats.metabolitesKept.length} metabolite(s) were NOT imported: the drug already links that\n` +
        'substance under another spelling, so the document\'s conversion range, note and citations\n' +
        'went nowhere. Reconcile by hand against the existing link:',
    );
    for (const k of stats.metabolitesKept) {
      console.log(`  ! ${k.name} — already linked as "${k.linkedAs}"`);
    }
  }
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s) — review these:`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
