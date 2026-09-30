/**
 * Refresh `data/components.ts` from the live database, or report the drift.
 *
 *   npm run catalog:export           # rewrite data/components.ts from the DB
 *   npm run catalog:check            # report drift, exit 1 if any (CI gate)
 *   npx tsx scripts/export-components.ts --check --max-drifts 10
 *
 * The reverse of `scripts/seed-drugs.ts`. That script has always been the only
 * link between the fixture and the database, and it runs one way: fixture →
 * DB, by hand. Everything that has written drug data since — the `/review`
 * pending-edit queue, `parameter_entries` aggregation, the deep-research
 * importer, the scheduled maintainer agents — writes only to the DB, so the
 * fixture ages silently. It still matters: `src/data/index.ts` serves it as the
 * offline fallback when `GET /api/drugs` fails, and
 * `scripts/generate-registry-provenance.ts` treats it as the reviewed catalog
 * the pinned kinetics-core registry is checked against. A stale fixture means a
 * degraded-mode user sees old pharmacology and the provenance gate is measuring
 * against a fossil.
 *
 * Requires `DATABASE_URL` (read from `.env` via dotenv, like the other db
 * scripts).
 *
 * ── After a refresh ──────────────────────────────────────────────────────────
 * Re-run `npm run kinetics:provenance:check`. The pinned registry is
 * cross-checked against this fixture, so a refreshed catalog can legitimately
 * turn a previously in-range parameter into declared drift — that is the gate
 * doing its job, and the decision (retune the registry, or record a
 * `reviewed-override` with a rationale) is a human one.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogRows } from '../api/_lib/catalogExportStore';
import {
  buildRawComponents,
  diffCatalogs,
  findDuplicateCids,
  isCatalogInSync,
  mergeForRender,
  renderComponentsSource,
  splitComponentsSource,
  type CatalogDiff,
} from '../src/lib/catalogExport';
import { embeddedComponents } from '../data/components';

const HERE = dirname(fileURLToPath(import.meta.url));
// The fixture is always the INPUT: its preamble is reused and its entries are
// the merge base (they are what `embeddedComponents` imports). `--out` only
// redirects where the result is written, so pointing it at a new path works.
const SOURCE_PATH = join(HERE, '..', 'data', 'components.ts');

interface Options {
  check: boolean;
  prune: boolean;
  target: string;
  maxDrifts: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    check: false,
    prune: false,
    target: SOURCE_PATH,
    maxDrifts: 25,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--prune') {
      options.prune = true;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a path');
      options.target = value;
    } else if (arg === '--max-drifts') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-drifts requires a non-negative integer');
      }
      options.maxDrifts = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: tsx scripts/export-components.ts [options]',
          '',
          '  --check              report drift and exit 1 if the fixture is stale',
          '  --prune              mirror the database exactly: DELETE fixture entries and',
          '                       field values it has none for. Off by default — the',
          '                       fixture is a seed source, so unseeded drugs and',
          '                       fields the seeder never round-tripped are kept',
          '  --out <path>         write the result elsewhere; data/components.ts is',
          '                       always the input (default: write back to it)',
          '  --max-drifts <n>     cap the per-drug drift rows printed (default 25)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function reportDiff(diff: CatalogDiff, maxDrifts: number): void {
  console.log('');
  console.log(
    `Catalog drift: ${diff.changed.length} changed, ${diff.onlyInDb.length} ` +
      `missing from the fixture, ${diff.onlyInFile.length} missing from the ` +
      `database, ${diff.unchanged} in sync.`,
  );

  if (diff.onlyInDb.length > 0) {
    console.log('');
    console.log('In the database, absent from data/components.ts:');
    for (const entry of diff.onlyInDb.slice(0, maxDrifts)) {
      console.log(`  + ${entry.name} (CID ${entry.pubchemCid})`);
    }
    if (diff.onlyInDb.length > maxDrifts) {
      console.log(`  … ${diff.onlyInDb.length - maxDrifts} more (raise --max-drifts to see them)`);
    }
  }

  if (diff.onlyInFile.length > 0) {
    console.log('');
    console.log(
      'In data/components.ts, absent from the database ' +
        '(never seeded, or deleted after seeding):',
    );
    for (const entry of diff.onlyInFile.slice(0, maxDrifts)) {
      console.log(`  - ${entry.name} (CID ${entry.pubchemCid})`);
    }
    if (diff.onlyInFile.length > maxDrifts) {
      console.log(`  … ${diff.onlyInFile.length - maxDrifts} more (raise --max-drifts to see them)`);
    }
  }

  if (diff.changed.length > 0) {
    console.log('');
    console.log('Field-level drift (fixture → database):');
    for (const drug of diff.changed.slice(0, maxDrifts)) {
      console.log(`  ${drug.name} (CID ${drug.pubchemCid})`);
      for (const field of drug.fields) {
        console.log(`      ${field.field}: ${field.file}  →  ${field.db}`);
      }
    }
    if (diff.changed.length > maxDrifts) {
      console.log(`  … ${diff.changed.length - maxDrifts} more (raise --max-drifts to see them)`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const rows = await loadCatalogRows();
  const { components, skipped } = buildRawComponents(rows);

  console.log(
    `Read ${rows.length} drugs from the database; projected ${components.length}.`,
  );
  if (skipped.length > 0) {
    // Never silent: a drug the fixture cannot represent is a real coverage hole
    // in the offline fallback, not a rounding error.
    const noCid = skipped.filter((s) => s.reason === 'no-pubchem-cid');
    const noName = skipped.filter((s) => s.reason === 'no-name');
    if (noCid.length > 0) {
      console.warn(
        `[warn] ${noCid.length} drug(s) skipped — no pubchem_cid, which the ` +
          `fixture requires as its identity: ${noCid.map((s) => s.name).join(', ')}`,
      );
    }
    if (noName.length > 0) {
      console.warn(
        `[warn] ${noName.length} drug(s) skipped — no usable name: ` +
          noName.map((s) => s.name).join(', '),
      );
    }
  }

  // Reported but never fatal: a duplicate is a fixture defect the database
  // cannot have (pubchem_cid is unique there), and a refresh collapses it onto
  // the single DB row. Failing the drift gate on it would block every future
  // check on a problem the check itself is about to fix.
  for (const duplicate of findDuplicateCids(embeddedComponents)) {
    console.warn(
      `[warn] data/components.ts has ${duplicate.names.length} entries sharing ` +
        `CID ${duplicate.pubchemCid} (${duplicate.names.join(', ')}). ` +
        'seed-drugs.ts upserts on pubchem_cid, so only the last one reaches the ' +
        'database; a refresh collapses them onto the database row.',
    );
  }

  // Both modes work off the SAME merge. `--check` asks exactly one question:
  // "would `catalog:export` change this file?" — so it must compare against the
  // merge result, not the raw projection. Comparing against the raw projection
  // reports every value the merge intentionally preserves (the 68 concentration
  // bands on a database seeded before the key fix, and every fixture-only drug)
  // as drift that a refresh cannot clear: the exporter would say "already up to
  // date" while the gate stayed red forever. Deriving both from one merge makes
  // the gate convergent by construction.
  const merge = mergeForRender(embeddedComponents, components, {
    prune: options.prune,
  });
  const diff = diffCatalogs(embeddedComponents, merge.components);

  if (options.check) {
    // A skipped row is a live drug the offline catalog cannot represent at all.
    // It never enters `diff`, so without this the check could report "in sync"
    // while the fallback is missing drugs — and the warning above would sit
    // unread in a green job's log. Fail on it: adding a PubChem CID is a real,
    // actionable fix.
    if (isCatalogInSync(diff) && skipped.length === 0) {
      console.log(
        `data/components.ts is in sync with the database (${diff.unchanged} drugs).`,
      );
      return;
    }
    if (!isCatalogInSync(diff)) reportDiff(diff, options.maxDrifts);
    // Retained/preserved data is NOT drift — a refresh would leave it exactly
    // as it is. Report it so the state is visible, but never fail on it.
    if (merge.retained.length > 0 || merge.preservedFields.length > 0) {
      console.log('');
      console.log(
        `(Not drift: ${merge.retained.length} fixture entr` +
          `${merge.retained.length === 1 ? 'y' : 'ies'} and ` +
          `${merge.preservedFields.length} drug(s) with fixture-only field values ` +
          'the database has none for. A refresh preserves these; --prune drops them.)',
      );
    }
    if (skipped.length > 0) {
      console.log('');
      console.log(
        `${skipped.length} live drug(s) cannot be represented in the fixture ` +
          'and are therefore missing from the offline catalog. Fix the data ' +
          '(a PubChem CID is required as the fixture identity), then re-run.',
      );
    }
    console.log('');
    console.log('Run `npm run catalog:export` to refresh the fixture.');
    process.exitCode = 1;
    return;
  }

  // Refuse to overwrite a populated fixture with nothing. An empty projection
  // means the connection landed on an unseeded or wrong database, and writing
  // it out would delete the whole catalog for a configuration mistake.
  if (components.length === 0 && embeddedComponents.length > 0) {
    console.error(
      'Refusing to write: the database projected 0 drugs but the fixture has ' +
        `${embeddedComponents.length}. Check DATABASE_URL points at a seeded database.`,
    );
    process.exit(1);
  }

  // Always read the fixture, never the destination: `--out` may name a file
  // that does not exist yet, and the merge base is `embeddedComponents` — which
  // is this file — so reading anything else would mismatch the two.
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const { preamble } = splitComponentsSource(source);
  const { components: merged, retained, dropped, preservedFields } = merge;
  const next = renderComponentsSource(preamble, merged);

  if (next === source && options.target === SOURCE_PATH) {
    console.log(`${relative(process.cwd(), options.target)} already up to date.`);
    return;
  }

  writeFileSync(options.target, next, 'utf8');
  reportDiff(diff, options.maxDrifts);
  if (preservedFields.length > 0) {
    const fieldCount = preservedFields.reduce(
      (n, e) => n + e.fields.length,
      0,
    );
    console.log('');
    console.log(
      `Kept ${fieldCount} fixture field value(s) across ${preservedFields.length} ` +
        'drug(s) that the database had no value for (pass --prune to mirror the ' +
        'database exactly):',
    );
    for (const entry of preservedFields.slice(0, options.maxDrifts)) {
      console.log(
        `  ${entry.name} (CID ${entry.pubchemCid}): ${entry.fields.join(', ')}`,
      );
    }
    if (preservedFields.length > options.maxDrifts) {
      console.log(`  … ${preservedFields.length - options.maxDrifts} more`);
    }
  }
  if (retained.length > 0) {
    console.log('');
    console.log(
      `Kept ${retained.length} fixture entr${retained.length === 1 ? 'y' : 'ies'} ` +
        'the database has no row for (pass --prune to remove them instead).',
    );
  }
  if (dropped.length > 0) {
    console.log('');
    console.log(`Pruned ${dropped.length} fixture entries absent from the database:`);
    for (const entry of dropped.slice(0, options.maxDrifts)) {
      console.log(`  - ${entry.name} (CID ${entry.pubchemCid})`);
    }
    if (dropped.length > options.maxDrifts) {
      console.log(`  … ${dropped.length - options.maxDrifts} more`);
    }
  }
  console.log('');
  console.log(
    `Wrote ${merged.length} drugs to ${relative(process.cwd(), options.target)}.`,
  );
  console.log(
    'Re-run `npm run kinetics:provenance:check` — the pinned kinetics-core ' +
      'registry is cross-checked against this catalog.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
