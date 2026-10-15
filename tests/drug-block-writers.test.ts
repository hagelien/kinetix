/**
 * Every code path that writes a whole-block table is accounted for (#37).
 *
 * The metabolism box (`drug_metabolism_profiles`, `drug_elimination_routes`,
 * `drug_metabolites`), the mechanisms (`drug_receptor_targets`) and the model
 * structure (`parameter_entries` rows for the axes and `ka`) have a revision
 * history, `drug_block_revisions`. A writer that changes them without going
 * through the recorder (`api/_lib/drugBlockHistory.ts`) leaves a silent gap in
 * that history — which is how three review rounds on #303 each found one more.
 *
 * So the writers are pinned here. A file that starts writing one of those
 * tables fails this test until it is listed below with how it is recorded, and
 * each listing is checked against the file: a recorder must call the recorder,
 * an exception must say why it is one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCANNED_DIRS = ['api', 'scripts', 'tools', 'plugins'];

const BLOCK_TABLES = [
  ['drugMetabolismProfiles', 'drug_metabolism_profiles'],
  ['drugEliminationRoutes', 'drug_elimination_routes'],
  ['drugMetabolites', 'drug_metabolites'],
  ['drugReceptorTargets', 'drug_receptor_targets'],
  ['parameterEntries', 'parameter_entries'],
] as const;

const WRITE_PATTERNS: RegExp[] = [
  ...BLOCK_TABLES.map(([ts]) => new RegExp(`\\.(insert|update|delete)\\(\\s*${ts}\\s*\\)`)),
  ...BLOCK_TABLES.map(
    ([, table]) => new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+"?${table}\\b`, 'i'),
  ),
  // The store functions that perform those writes on a caller's behalf.
  /\breplaceDrugMetabolism\(/,
  /\breplaceDrugReceptorTargets\(/,
  /\b(insertParameterEntry|updateParameterEntryRow|deleteParameterEntryRow|attachSourceQuoteIfMissing)\(/,
];

type Writer =
  /** Wraps its writes in withBlockHistory / beginBlockHistory. */
  | { kind: 'records' }
  /** Writes entries, then runs the per-parameter recompute that records them. */
  | { kind: 'recompute-hook' }
  /** The store implementation; every caller is itself listed here. */
  | { kind: 'store'; mustContain: string }
  /** Not recorded, for the reason given (checked to still hold, see below). */
  | { kind: 'exception'; reason: string; mustContain?: string };

const WRITERS: Record<string, Writer> = {
  // API — interactive and review paths.
  'api/drug-metabolism.ts': { kind: 'records' },
  'api/drug-receptor-targets.ts': { kind: 'records' },
  'api/_lib/pending-edits-helpers.ts': { kind: 'records' },
  'api/parameter-entries.ts': { kind: 'recompute-hook' },
  'api/_lib/conversationIngestionStore.ts': { kind: 'recompute-hook' },
  'api/_lib/researchImportStore.ts': { kind: 'records' },
  'api/_lib/drug-merge.ts': { kind: 'records' },
  'api/_lib/metabolismStore.ts': { kind: 'store', mustContain: 'withBlockHistory' },
  'api/_lib/receptorTargetStore.ts': { kind: 'store', mustContain: 'withBlockHistory' },
  'api/_lib/parameter-entries-store.ts': {
    kind: 'store',
    mustContain: 'recordModelStructureRevision(',
  },
  'api/_lib/citation-merge.ts': {
    kind: 'exception',
    reason:
      'repoints citation ids only; it rewrites the same ids inside every block snapshot, so the history stays equal to the live blocks',
    mustContain: 'rewriteBlockSnapshotCitation(',
  },
  'api/drugs.ts': {
    kind: 'exception',
    reason: "deleting a drug deletes its entries and, by cascade, the drug's block history",
  },
  // Operator scripts.
  'scripts/seed-drugs.ts': { kind: 'records' },
  'scripts/import-farmakologiportalen.ts': { kind: 'records' },
  'scripts/backfill-metabolite-links.ts': { kind: 'records' },
  'scripts/repair-hallucinated-citations.ts': { kind: 'records' },
  'scripts/merge-drugs.ts': { kind: 'records' },
  'scripts/retire-loq-lod-rows.ts': {
    kind: 'exception',
    reason: "deletes only 'loq'/'lod' entries, which are not a block parameter",
    mustContain: "IN ('loq', 'lod')",
  },
  'scripts/seed-pm-am-ratios.ts': {
    kind: 'exception',
    reason: 'inserts only pmAmRatio entries, which are not a block parameter',
    mustContain: 'PM_AM_PARAMETER',
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const writers = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .filter((path) => {
    const text = readFileSync(path, 'utf8');
    return WRITE_PATTERNS.some((re) => re.test(text));
  })
  .map((path) => relative(ROOT, path).split('\\').join('/'))
  // The recorder itself only reads those tables.
  .filter((path) => path !== 'api/_lib/drugBlockHistory.ts')
  .sort();

describe('writers of the whole-block tables (#37)', () => {
  it('lists every file that writes them', () => {
    const unlisted = writers.filter((path) => !(path in WRITERS));
    expect(
      unlisted,
      'New writer(s) of a block table: wrap the write in withBlockHistory ' +
        '(api/_lib/drugBlockHistory.ts) and list the file in WRITERS',
    ).toEqual([]);
  });

  it('lists no file that has stopped writing them', () => {
    expect(Object.keys(WRITERS).filter((path) => !writers.includes(path))).toEqual([]);
  });

  // Atomicity (Codex review on #303): a block write that commits before its
  // revision row can survive a failure that loses the row. The recorder makes
  // that impossible for code that goes through it — withBlockHistory always
  // runs in a transaction, and beginBlockHistory / the recompute hook refuse
  // to run outside one — so what is left to pin is that nobody writes a block
  // table through an auto-commit client of their own making.
  it('the recorder only runs inside a transaction', () => {
    const recorder = readFileSync(join(ROOT, 'api/_lib/drugBlockHistory.ts'), 'utf8');
    expect(recorder).toMatch(/return inTransaction\(async \(\) => \{\s*const history = await beginBlockHistory/);
    expect(recorder).toMatch(/if \(!isInPoolTransaction\(\)\) \{\s*throw new BlockHistoryOutsideTransactionError\('beginBlockHistory'\)/);
    const hook = readFileSync(join(ROOT, 'api/_lib/drugBlockRevisions.ts'), 'utf8');
    expect(hook).toMatch(/if \(!isInPoolTransaction\(\)\) \{\s*throw new Error\(\s*'recordModelStructureRevision must run inside/);
  });

  it.each(Object.keys(WRITERS))(
    '%s writes no block table through an auto-commit client of its own',
    (path) => {
      const text = readFileSync(join(ROOT, path), 'utf8');
      // A module that builds its own neon-http client (`drizzle(neon(...))`)
      // must not write a block table through it: those writes commit one by
      // one, outside the recorder's transaction.
      if (!/\bdrizzle\(/.test(text)) return;
      for (const [ts] of BLOCK_TABLES) {
        expect(text).not.toMatch(
          new RegExp(`\\bdb\\s*\\.\\s*(insert|update|delete)\\(\\s*${ts}\\b`),
        );
      }
    },
  );

  it.each(Object.entries(WRITERS))('%s is recorded as listed', (path, writer) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    switch (writer.kind) {
      case 'records':
        expect(text).toMatch(/\b(withBlockHistory|beginBlockHistory)\(/);
        break;
      case 'recompute-hook':
        expect(text).toMatch(/\brecomputeParameterAndDependents\(/);
        break;
      case 'store':
        expect(text).toContain(writer.mustContain);
        break;
      case 'exception':
        expect(writer.reason.length).toBeGreaterThan(20);
        if (writer.mustContain) expect(text).toContain(writer.mustContain);
        break;
    }
  });
});
