/**
 * Regression guard for the production deploy failure at migration 0078.
 *
 * `drug_parameters.value` is an un-typed JSONB blob, so a `qualifier` field can
 * hold a string longer than the `varchar(8)` operator column it is copied into.
 * Production carried such a value, and 0078 Step 5 (the grandfather backfill)
 * inserted it raw, throwing `22001 value too long for type character
 * varying(8)` — which aborted the whole deploy.
 *
 * The neon-http migrator wraps nothing in a transaction (each statement
 * auto-commits), so that failure also left 0078's earlier rename/ADD COLUMN
 * steps committed while the migration stayed unrecorded — meaning the entire
 * file re-runs on the next deploy and must be idempotent.
 *
 * Unlike the shared harness (which replays the whole chain in one pass), this
 * test stops before 0078 to seed the offending row, then applies 0078 twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

function statementsFor(tag: string): string[] {
  const body = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
  return body
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\bCONCURRENTLY\b/gi, ''));
}

function journalTags(): string[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.map((e) => e.tag);
}

describe('migration 0078 grandfather backfill', () => {
  let client: PGlite;
  let tags: string[];
  const tagAt = (prefix: string) => {
    const t = tags.find((x) => x.startsWith(prefix));
    if (!t) throw new Error(`no migration tag starting ${prefix}`);
    return t;
  };
  const applyTag = async (tag: string) => {
    for (const stmt of statementsFor(tag)) await client.exec(stmt);
  };

  beforeAll(async () => {
    client = await PGlite.create({ extensions: { pg_trgm } });
    tags = journalTags();
    const idx78 = tags.indexOf(tagAt('0078'));
    for (const t of tags.slice(0, idx78)) await applyTag(t);

    // Mirror the production data that broke the deploy: an oversized qualifier
    // (13 chars) plus a legitimate strict-threshold operator.
    await client.exec(`INSERT INTO drugs (slug, names)
      VALUES ('testdrug', '{"nb":"Testdrug"}'::jsonb)`);
    await client.exec(`INSERT INTO drug_parameters (drug_id, parameter, value) VALUES
      (1, 'toxicConcentration',
       '{"median": 1.5, "unit": "mg/L", "qualifier": "approximately"}'::jsonb),
      (1, 'fatalConcentration',
       '{"median": 9.0, "unit": "mg/L", "qualifier": "<"}'::jsonb)`);
  }, 60000);

  afterAll(async () => {
    await client?.close();
  });

  it('applies without overflowing varchar(8) and preserves the values', async () => {
    await expect(applyTag(tagAt('0078'))).resolves.not.toThrow();

    const { rows } = await client.query<{
      parameter: string;
      qualifier: string | null;
      median: string;
      matrix: string;
    }>(
      `SELECT parameter, qualifier, median::text AS median, matrix
       FROM parameter_entries WHERE origin = 'grandfathered' ORDER BY parameter`,
    );
    expect(rows).toHaveLength(2);
    const byParam = Object.fromEntries(rows.map((r) => [r.parameter, r]));

    // Oversized, non-operator qualifier is dropped; the value survives intact.
    expect(byParam.toxicConcentration.qualifier).toBeNull();
    expect(Number(byParam.toxicConcentration.median)).toBe(1.5);
    expect(byParam.toxicConcentration.matrix).toBe('whole_blood');
    // A real strict-threshold operator is preserved.
    expect(byParam.fatalConcentration.qualifier).toBe('<');
    expect(Number(byParam.fatalConcentration.median)).toBe(9.0);
  });

  it('is idempotent when re-run on an already-migrated database', async () => {
    // Simulates the production partial-apply state: table already renamed and
    // columns already added, migration not recorded. The whole file must be a
    // clean no-op — no duplicate rows and, crucially, no DDL error.
    await expect(applyTag(tagAt('0078'))).resolves.not.toThrow();
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM parameter_entries WHERE origin = 'grandfathered'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('applies the remaining chain (0079..) including the 0080 corrective backfill', async () => {
    const rest = tags.slice(tags.indexOf(tagAt('0079')));
    for (const t of rest) await expect(applyTag(t)).resolves.not.toThrow();
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM parameter_entries WHERE origin = 'grandfathered'`,
    );
    // 0080 re-runs the same guarded backfill; it must not duplicate or overflow.
    expect(rows[0].n).toBe(2);
  });
});
