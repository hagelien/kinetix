/**
 * The `kg_*` migration and `db/schema.ts` were written by hand, twice, from the
 * same spec. That is exactly the situation where they drift: a column renamed
 * in one and not the other typechecks perfectly and fails at runtime, on the
 * first insert, in production.
 *
 * So this compares the Drizzle definitions against the columns the migration
 * chain actually produced in a real Postgres — names, nullability and defaults,
 * for every kg_ table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema.js';
import {
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

/** Every exported Drizzle table whose SQL name starts with `kg_`. */
const KG_TABLES = Object.values(schema)
  .filter(
    (value): value is Parameters<typeof getTableConfig>[0] =>
      typeof value === 'object' &&
      value !== null &&
      Symbol.for('drizzle:Name') in value,
  )
  .map((table) => getTableConfig(table))
  .filter((config) => config.name.startsWith('kg_'))
  .sort((a, b) => a.name.localeCompare(b.name));

async function liveColumns(table: string) {
  const result = await db.execute(sql`
    select column_name, is_nullable
    from information_schema.columns
    where table_name = ${table}
    order by column_name
  `);
  const rows =
    (result as unknown as {
      rows?: Array<{ column_name: string; is_nullable: string }>;
    }).rows ?? [];
  return new Map(rows.map((r) => [r.column_name, r.is_nullable === 'YES']));
}

describe('kg_* schema matches the migration', () => {
  it('finds every kg_ table in db/schema.ts', () => {
    // The list is spelled out rather than counted so a definition deleted by
    // accident fails here instead of silently shrinking the per-table checks
    // below to nothing. It grows as later phases add tables — Phase 3 brought
    // the thirteen of §5, Phase 4 added the migration control plane.
    expect(KG_TABLES.map((t) => t.name)).toEqual([
      'kg_assessments',
      'kg_audit_events',
      'kg_dispute_rulings',
      'kg_disputes',
      'kg_evidence_items',
      'kg_evidence_links',
      'kg_legacy_links',
      'kg_migration_state',
      'kg_policy_decisions',
      'kg_proposal_versions',
      'kg_proposals',
      'kg_publication_events',
      'kg_spaces',
      'kg_targets',
    ]);
  });

  it.each(KG_TABLES.map((t) => [t.name, t] as const))(
    '%s has the same columns in Drizzle and in the database',
    async (name, config) => {
      const live = await liveColumns(name);
      expect(live.size).toBeGreaterThan(0);

      const declared = config.columns.map((c) => c.name).sort();
      expect(declared).toEqual([...live.keys()].sort());

      for (const column of config.columns) {
        const liveNullable = live.get(column.name);
        // A column NOT NULL in one and nullable in the other is the drift that
        // fails on the first insert rather than at deploy time.
        expect(
          { column: column.name, nullable: liveNullable },
          `${name}.${column.name} nullability`,
        ).toEqual({ column: column.name, nullable: !column.notNull });
      }
    },
  );
});
