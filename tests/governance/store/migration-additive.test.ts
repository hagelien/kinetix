/**
 * Phase 3 exit gate: the `kg_*` migration is additive and cannot touch Kinetix.
 *
 * The plan's rules for this migration are all negative — additive only, no
 * triggers altering existing behaviour, no change to an existing column's
 * meaning, safe while old application code is still serving. Negative rules
 * are the kind that get broken by a later edit to the same file, so this reads
 * the SQL and enforces them.
 *
 * Deliberately a text analysis rather than a database test: the property is
 * "this file contains no destructive statement", and a database can only show
 * that the statements it *does* contain ran. A `DROP TABLE users` added
 * tomorrow would apply perfectly cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '0114_knowledge_governance_schema';
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'drizzle');

/**
 * Every migration this extraction adds. The additive rules apply to all of
 * them, not just the first — a later phase adding a `kg_` table must clear the
 * same bar, and listing them here is what makes that automatic.
 */
const GOVERNANCE_MIGRATIONS = [
  '0114_knowledge_governance_schema',
  '0115_knowledge_governance_migration_state',
] as const;

/** A migration's SQL with comments stripped, so prose is not read as SQL. */
function readCode(tag: string): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function readStatements(tag: string): string[] {
  return readCode(tag)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const code = readCode(MIGRATION);
const statements = readStatements(MIGRATION);

describe('every knowledge-governance migration', () => {
  it.each(GOVERNANCE_MIGRATIONS)('%s is registered in the journal', (tag) => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === tag)).toBe(true);
  });

  it.each(GOVERNANCE_MIGRATIONS)('%s only creates kg_ objects', (tag) => {
    for (const statement of readStatements(tag)) {
      expect(statement.toUpperCase().startsWith('CREATE')).toBe(true);
    }
    const created = readStatements(tag)
      .map((s) =>
        /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)/i.exec(s),
      )
      .map((m) => m?.[1])
      .filter((name): name is string => Boolean(name));
    expect(created.length).toBeGreaterThan(0);
    for (const name of created) expect(name.startsWith('kg_')).toBe(true);
  });

  it.each(GOVERNANCE_MIGRATIONS)(
    '%s references no Kinetix table in a foreign key',
    (tag) => {
      // A FK into `users` or `citations` would make an immutable governance
      // record deletable by a Kinetix cascade, and would tie the generic core
      // to this host's tables.
      for (const [, table] of readCode(tag).matchAll(/REFERENCES\s+([a-z_]+)\s*\(/gi)) {
        expect(table.startsWith('kg_')).toBe(true);
      }
    },
  );

  it.each(GOVERNANCE_MIGRATIONS)('%s creates every table idempotently', (tag) => {
    for (const statement of readStatements(tag)) {
      if (!/^CREATE\s+TABLE/i.test(statement)) continue;
      expect(statement).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    }
  });
});

describe('0114 knowledge-governance migration', () => {

  it.each([
    ['DROP TABLE'],
    ['DROP COLUMN'],
    ['DROP INDEX'],
    ['DROP CONSTRAINT'],
    ['TRUNCATE'],
    ['DELETE FROM'],
    ['UPDATE '],
    ['ALTER COLUMN'],
    ['RENAME'],
    ['CREATE TRIGGER'],
    ['CREATE RULE'],
    ['CREATE OR REPLACE FUNCTION'],
  ])('contains no %s', (fragment) => {
    expect(code.toUpperCase()).not.toContain(fragment);
  });

  it('only ever creates, never alters', () => {
    // ALTER of any kind is out of scope for this migration: every table it
    // needs it also creates. An ALTER here would necessarily be against a
    // Kinetix table, which is the thing that must not happen.
    for (const statement of statements) {
      expect(statement.toUpperCase().startsWith('CREATE')).toBe(true);
    }
  });

  it('names only kg_* objects', () => {
    // The prefix is what makes "did this migration touch a Kinetix table?"
    // answerable by reading, per §5.
    const created = statements
      .map((s) => /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)/i.exec(s))
      .map((m) => m?.[1])
      .filter((name): name is string => Boolean(name));
    expect(created.length).toBeGreaterThan(0);
    for (const name of created) {
      expect(name.startsWith('kg_')).toBe(true);
    }
  });

  it('creates all thirteen tables from §5', () => {
    // Scoped to migration 0114. Later migrations add their own kg_ tables
    // (0115 adds the migration control plane) and are guarded separately.
    const tables = statements
      .map((s) => /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)/i.exec(s))
      .map((m) => m?.[1])
      .filter((name): name is string => Boolean(name))
      .sort();
    expect(tables).toEqual([
      'kg_assessments',
      'kg_audit_events',
      'kg_dispute_rulings',
      'kg_disputes',
      'kg_evidence_items',
      'kg_evidence_links',
      'kg_legacy_links',
      'kg_policy_decisions',
      'kg_proposal_versions',
      'kg_proposals',
      'kg_publication_events',
      'kg_spaces',
      'kg_targets',
    ]);
  });

  it('creates every table idempotently', () => {
    // The migration must be safe to re-apply against a database that already
    // has these tables — a partially-applied deploy that is retried.
    const creates = statements.filter((s) => /^CREATE\s+TABLE/i.test(s));
    for (const statement of creates) {
      expect(statement).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    }
  });

  it('references no Kinetix table in a foreign key', () => {
    // A FK into `users` or `citations` would make an immutable governance
    // record deletable by a Kinetix cascade, and would tie the generic core to
    // this host's tables. Actors and evidence are referenced by string instead.
    const references = [...code.matchAll(/REFERENCES\s+([a-z_]+)\s*\(/gi)].map(
      (m) => m[1]!,
    );
    expect(references.length).toBeGreaterThan(0);
    for (const table of references) {
      expect(table.startsWith('kg_')).toBe(true);
    }
  });
});
