/**
 * Every writer to `drug_parameters` and `parameter_entries` must respect the
 * applicability rules — and this test exists because finding them by hand
 * failed repeatedly.
 *
 * The guard lives in `upsertDrugParameter`, so the obvious check is "who calls
 * it". That question cannot find a writer that *doesn't*, which is exactly how
 * the research importer, the drug seeder, the reference-concentration seeder
 * and the Farmakologiportalen importer were each missed in turn — every one of
 * them builds its own `insert(drugParameters)` and never touches the store.
 *
 * So this asserts on the shape of the source instead: any module writing
 * either table directly must be named here, and naming it is a commitment that
 * it carries its own applicability check. A new unguarded writer fails CI with
 * a pointer to what it has to do, instead of surviving until someone reads the
 * diff closely.
 *
 * This is a structural gate, not proof the guard is correct — the linked tests
 * do that per writer. What it guarantees is that no writer is *forgotten*.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['api', 'scripts', 'src', 'db'];

/**
 * Modules allowed to write these tables directly, each with the reason its own
 * check is adequate. Adding a line here is a claim you must be able to defend.
 */
const ALLOWED: Record<string, string> = {
  'api/_lib/drugParameterStore.ts':
    'the guard itself — upsertDrugParameter checks and locks before writing',
  'api/_lib/parameter-entries-store.ts':
    'the entry guard itself — insertParameterEntry checks and locks before writing, and the recompute skips excluded pairs',
  'api/_lib/researchImportStore.ts':
    'preflights with blockedParametersFor under the per-drug lock; skips and reports blocked pairs',
  'api/_lib/drug-merge.ts':
    'runs its own applicability check and REFUSES rather than picking: detectApplicabilityBlockers ' +
    'flags a marker-beside-value union and a class-forbidden value across the two drugs, and throws ' +
    'DrugMergeBlockedError. It runs after lockDrugForEntryApplicability on both drugs (the same lock ' +
    'the ordinary write path takes, so a concurrent writer cannot slip a row in between) and before ' +
    'any repointing write. The entry writes it then makes are a drug_id move, an origin promotion ' +
    'that changes no parameter or value, and a delete of rows already duplicated on the winner',
  'api/_lib/citation-merge.ts':
    'repoints citationId on existing entries; creates no entry and changes no parameter, so applicability cannot change',
  'scripts/seed-drugs.ts':
    'preflights each drug with blockedParametersFor and skips blocked parameters',
  'scripts/seed-reference-concentrations.ts':
    'preflights with blockedParametersFor and skips blocked parameters',
  'scripts/import-farmakologiportalen.ts':
    'preflights with blockedParametersFor and skips blocked parameters',
  'api/_lib/reference-concentrations-helpers.ts':
    'writes parameter_entries through the referenceConcentrations alias; insert and update check parameterWriteBlockedBy under withDrugApplicabilityLock, delete is always allowed',
  'scripts/backfill-molecular-weights.ts':
    'raw-SQL INSERT run inside withDrugApplicabilityLock on the transactional client, with writeBlockedSql as the in-statement check; reports the rows it skipped',
  'scripts/merge-drugs.ts':
    'preflights the moving parameters with blockedParametersFor and re-checks under withDrugApplicabilityLock inside the transaction, deleting the blocked ones from the loser rather than moving them; every other write is an UPDATE of drug_id on rows that already exist',
  'scripts/audit-norwegian-orthography.ts':
    'rewrites prose only: its UPDATE sets one free-text column (parameter_entries.comments) ' +
    'on a row that already exists, restoring æ/ø/å in text the detector proved was ' +
    'transliterated. It never inserts or deletes, never touches value, parameter, drug_id, ' +
    'unit or qualifier, and reaches drug_parameters read-only (the JSON note is reported, ' +
    'never written), so no write it makes can change what a pair means or whether it applies',
  'scripts/retire-loq-lod-rows.ts':
    'deletes only, for two parameter ids the registry no longer declares; removing a value cannot contradict an applicability marker, which is why upsertDrugParameter allows a clear unconditionally too',
  'api/drugs.ts':
    'deletes only, scoped to the drug being deleted inside its own teardown transaction: ' +
    'removing every parameter_entries row a drug owns as that drug ceases to exist cannot ' +
    'publish a value for a blocked pair, the same reasoning retire-loq-lod-rows.ts and ' +
    'repair-hallucinated-citations.ts rely on for their own unconditional deletes',
  'scripts/repair-hallucinated-citations.ts':
    'deletes only, for entries whose citation was proved not to name a real paper: one ' +
    'DELETE FROM parameter_entries keyed on citation_id, which removes evidence and can ' +
    'therefore never publish a value for a blocked pair. It republishes the affected ' +
    'aggregates afterwards, but through recomputeAndCacheParameterSummary in ' +
    'parameter-entries-store.ts — the guarded store, whose recompute already skips excluded ' +
    'pairs — rather than writing drug_parameters itself. Its interpolated-identifier writes ' +
    'target FACT_TABLES (drug_receptor_targets, drug_metabolism_profiles, ' +
    'drug_elimination_routes, drug_enzyme_interactions, drug_ionization_constants, ' +
    'drug_metabolites); neither guarded table is among them',
};

/**
 * The two base tables, plus every schema alias that resolves to one.
 *
 * `db/schema.ts` re-exports `parameterEntries` as `referenceConcentrations`
 * for the legacy compatibility endpoint, and that endpoint wrote through the
 * alias for three statements this gate could not see — because the pattern
 * below named the two identifiers rather than asking the schema which
 * identifiers mean those tables. Derived, so a future alias is covered the day
 * it is written.
 */
function tableIdentifiers(): string[] {
  const schema = fs.readFileSync(path.join(ROOT, 'db/schema.ts'), 'utf8');
  const names = new Set(['drugParameters', 'parameterEntries']);
  // Fixpoint: an alias of an alias still resolves to the same table.
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of schema.matchAll(
      /^export const (\w+) = (\w+);$/gm,
    )) {
      if (names.has(m[2]!) && !names.has(m[1]!)) {
        names.add(m[1]!);
        changed = true;
      }
    }
  }
  return [...names];
}

/** Direct writes to the two tables, however the query is spelled. */
function writePattern(): RegExp {
  return new RegExp(
    `\\.(insert|update|delete)\\(\\s*(${tableIdentifiers().join('|')})\\s*\\)`,
  );
}

/**
 * Raw SQL reaching the same tables under their database names. Drizzle is not
 * the only way to write a row: `scripts/backfill-molecular-weights.ts` sent an
 * `INSERT INTO drug_parameters` through the neon client and was invisible here
 * for the same reason the alias was — the gate recognised a spelling, not an
 * act.
 */
const RAW_SQL_WRITE =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(drug_parameters|parameter_entries)"?/i;

/**
 * Raw SQL whose TABLE NAME arrives by interpolation rather than as a literal.
 *
 * The third spelling of the same evasion. `RAW_SQL_WRITE` above matches the table
 * name in the statement, so a module that builds the name first —
 * `const tbl = sql.raw(spec.table)`, then `UPDATE ${tbl} SET drug_id = ...` — is
 * invisible to it. `api/_lib/drug-merge.ts` does exactly that for the two
 * (drug_id, parameter)-keyed tables, and its `drug_parameters` writes were unseen
 * here; it surfaced only because an unrelated drizzle-builder write on
 * `parameterEntries` in the same file happened to match. A module writing ONLY
 * through interpolation would have passed silently.
 *
 * Detected as a pair, because neither half means much alone: a write against an
 * interpolated table, AND the file naming one of the guarded tables as a string.
 * That is deliberately conservative — it can over-report a file that interpolates
 * some other table while merely mentioning ours, and over-reporting costs one
 * declaration line while under-reporting costs an unguarded write.
 */
const INTERPOLATED_SQL_WRITE =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\$\{/i;
const NAMES_GUARDED_TABLE = /['"`](drug_parameters|parameter_entries)['"`]/;

/**
 * The store functions that write a row on the caller's behalf.
 *
 * Scanning only for direct table writes was not enough: `seed-pm-am-ratios.ts`
 * calls `insertParameterEntry` and so never matched `WRITE`, which is exactly
 * how it inserted live source rows beside a permanent marker while this test
 * stayed green. A guard that can only see one spelling of "writes a row" gives
 * false confidence about the other.
 *
 * Both of these now check applicability themselves, so a caller inherits the
 * guard — this list exists so that if either ever stops doing so, the callers
 * needing their own check are enumerable rather than discovered in production.
 */
const GUARDED_WRITE_HELPERS =
  /\b(upsertDrugParameter|insertParameterEntry)\s*\(/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(ROOT, full));
    }
  };
  for (const dir of SEARCH_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

function directWriters(): string[] {
  const write = writePattern();
  return sourceFiles()
    .filter((rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      return (
        write.test(src) ||
        RAW_SQL_WRITE.test(src) ||
        (INTERPOLATED_SQL_WRITE.test(src) && NAMES_GUARDED_TABLE.test(src))
      );
    })
    .sort();
}

describe('applicability: direct writers to the parameter tables', () => {
  it('are all declared, so a new one cannot slip in unguarded', () => {
    const undeclared = directWriters().filter((f) => !(f in ALLOWED));
    expect(
      undeclared,
      undeclared.length
        ? `These modules write drug_parameters or parameter_entries directly but are not declared in ` +
          `tests/parameter-write-guards.test.ts:\n\n  ${undeclared.join('\n  ')}\n\n` +
          `A direct write bypasses upsertDrugParameter's applicability guard, so it can publish a value ` +
          `for a pair the gap queue has been told cannot exist. Either route the write through ` +
          `upsertDrugParameter, or give the module its own blockedParametersFor check and add it to ` +
          `ALLOWED with the reason.`
        : '',
    ).toEqual([]);
  });

  it('has no stale entries left behind by a refactor', () => {
    // A leftover exemption is a standing invitation to add an unguarded write
    // to a file that no longer needs the allowance.
    const actual = new Set(directWriters());
    const stale = Object.keys(ALLOWED).filter((f) => !actual.has(f));
    expect(stale, `No longer write these tables directly: ${stale.join(', ')}`)
      .toEqual([]);
  });

  it('names a reason for every exemption', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe('applicability: the guarded write helpers', () => {
  /**
   * The two functions that write a parameter row for their caller must check
   * applicability themselves. That is what lets a caller who has never heard
   * of the rule still be safe, and it is the property the allowlist above
   * depends on — several of those entries are only defensible because the
   * helper they call is guarded.
   */
  it.each([
    ['api/_lib/drugParameterStore.ts', 'upsertDrugParameter'],
    ['api/_lib/parameter-entries-store.ts', 'insertParameterEntry'],
  ])('%s guards %s', (file, fn) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const body = src.slice(src.indexOf(`export async function ${fn}(`));
    const untilNextExport = body.slice(
      0,
      body.indexOf('\nexport ', 1) === -1
        ? undefined
        : body.indexOf('\nexport ', 1),
    );
    expect(
      /parameterWriteBlockedBy|withDrugApplicabilityLock/.test(untilNextExport),
      `${fn} no longer checks applicability. Every caller inherits that guard — ` +
        `if it is being removed on purpose, each caller listed in ALLOWED needs its own check first.`,
    ).toBe(true);
  });

  it('finds callers of those helpers, so the scan sees both spellings of a write', () => {
    // Regression cover for the gap that let seed-pm-am-ratios through: it
    // calls insertParameterEntry and so never matched the direct-write regex.
    // The scan is only meaningful if it actually locates such callers.
    const callers = sourceFiles().filter((rel) =>
      GUARDED_WRITE_HELPERS.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
    );
    expect(callers).toContain('scripts/seed-pm-am-ratios.ts');
    expect(callers.length).toBeGreaterThan(3);
  });
});
