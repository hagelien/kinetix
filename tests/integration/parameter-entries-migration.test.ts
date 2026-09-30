import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  drugParameters,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { listReferenceConcentrations } from '../../api/_lib/reference-concentrations-helpers.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0078 = path.resolve(
  HERE,
  '../../drizzle/0078_parameter_entries.sql',
);

/**
 * Pull one statement out of migration 0078 by a substring that uniquely
 * identifies it, so the test exercises the REAL migration SQL (not a copy that
 * could drift). The harness truncates every table between tests, so the
 * migration's own backfill (which ran once against an empty DB) leaves nothing
 * to observe — we re-run the relevant statement against seeded data instead.
 */
function migrationStatement(marker: string): string {
  const body = readFileSync(MIGRATION_0078, 'utf8');
  const statements = body
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  const match = statements.find((s) => s.includes(marker));
  if (!match) throw new Error(`No migration statement matching ${marker}`);
  return match;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

describe('migration 0078 — parameter_entries', () => {
  it('renamed reference_concentrations to parameter_entries', async () => {
    const present = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('parameter_entries', 'reference_concentrations')
    `);
    const names = present.rows.map((r) => r.table_name);
    expect(names).toContain('parameter_entries');
    expect(names).not.toContain('reference_concentrations');
  });

  it('added parameter (NOT NULL) and sort_order (default 0) columns', async () => {
    const cols = await db.execute<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'parameter_entries'
        AND column_name IN ('parameter', 'sort_order')
    `);
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    expect(byName.get('parameter')?.is_nullable).toBe('NO');
    expect(byName.get('sort_order')?.is_nullable).toBe('NO');
    expect(byName.get('sort_order')?.column_default).toContain('0');
  });

  it('cascades entry deletion when the drug is deleted', async () => {
    const drugId = await seedDrug(db);
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '100',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
    });
    await db.execute(sql`DELETE FROM drugs WHERE id = ${drugId}`);
    const remaining = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(remaining).toHaveLength(0);
  });

  it('grandfathers a hand-authored value into a whole-blood synthetic entry', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'therapeuticConcentration',
      value: { min: 10, max: 100, unit: 'mg/L', note: 'serum, adults' },
      updatedBy: userId,
    });

    const insertBackfill = migrationStatement('INSERT INTO "parameter_entries"');
    await db.execute(sql.raw(insertBackfill));

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          eq(parameterEntries.parameter, 'therapeuticConcentration'),
        ),
      );
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    // Value preserved EXACTLY; whole_blood so matrix normalization is a no-op.
    expect(Number(entry.low)).toBe(10);
    expect(Number(entry.high)).toBe(100);
    expect(entry.unit).toBe('mg/L');
    expect(entry.matrix).toBe('whole_blood');
    expect(entry.scenario).toBe('living_therapeutic');
    expect(entry.origin).toBe('grandfathered');
    expect(entry.comments).toContain('serum, adults');
    expect(entry.comments).toContain('legacy value');

    // Idempotent: the NOT EXISTS guard prevents a duplicate on re-run.
    await db.execute(sql.raw(insertBackfill));
    const afterRerun = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(afterRerun).toHaveLength(1);
  });

  it('skips grandfathering when a WHOLE-BLOOD entry already represents the value', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'therapeuticConcentration',
      value: { min: 10, max: 100, unit: 'mg/L' },
      updatedBy: userId,
    });
    // A whole-blood entry already carries this exact curated value.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '100',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    // No duplicate — the value is already represented in whole blood.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.matrix).toBe('whole_blood');
  });

  it('grandfathers even when a serum entry shares the literal bounds', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'therapeuticConcentration',
      value: { min: 10, max: 100, unit: 'mg/L' },
      updatedBy: userId,
    });
    // Same literal bounds but in serum — NOT equivalent after matrix
    // normalization, so exact preservation requires a whole-blood entry.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '100',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.matrix === 'whole_blood')).toBe(true);
  });

  it('still grandfathers when only a STALE legacy row (different value) exists', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Value edited after 0023 to a curated range …
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'therapeuticConcentration',
      value: { min: 10, max: 100, unit: 'mg/L' },
      updatedBy: userId,
    });
    // … while an older legacy concentration row with a DIFFERENT value lingers.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '20',
      high: '80',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    // The curated value is grandfathered as its own whole_blood entry so the
    // Phase-2 recompute cannot silently overwrite it with the stale evidence.
    expect(rows).toHaveLength(2);
    const synthetic = rows.find((r) => r.matrix === 'whole_blood');
    expect(synthetic).toBeDefined();
    expect(Number(synthetic!.low)).toBe(10);
    expect(Number(synthetic!.high)).toBe(100);
  });

  it('collapses a point-only authored value to low = high = median = point', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'fatalConcentration',
      value: { median: 5, unit: 'mg/L' },
      updatedBy: userId,
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const [entry] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(Number(entry!.low)).toBe(5);
    expect(Number(entry!.high)).toBe(5);
    expect(Number(entry!.median)).toBe(5);
    expect(entry!.scenario).toBe('postmortem_mono_intox');
  });

  it('preserves an authored central estimate alongside min/max bounds', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'toxicConcentration',
      value: { min: 10, max: 100, median: 20, unit: 'mg/L' },
      updatedBy: userId,
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const [entry] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    // Bounds preserved AND the curated central stat retained (not discarded in
    // favor of the 55 midpoint).
    expect(Number(entry!.low)).toBe(10);
    expect(Number(entry!.high)).toBe(100);
    expect(Number(entry!.median)).toBe(20);
  });

  it('preserves a strict-threshold qualifier from the authored value', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // A "< 120" upper threshold (Farmakologiportalen-style).
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'toxicConcentration',
      value: { max: 120, qualifier: '<', unit: 'mg/L' },
      updatedBy: userId,
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    const [entry] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    // The operator is retained rather than silently becoming an inclusive bound.
    expect(entry!.qualifier).toBe('<');
    expect(Number(entry!.high)).toBe(120);
    expect(entry!.low).toBeNull();
  });

  it('does not grandfather a matrix-specific parameter (analyte stability)', async () => {
    // The backfill covers the five interpretive concentrations and nothing
    // else. (It read the same way for `loq`/`lod` until they were retired: an
    // analytical limit belongs to a method in a lab, not to the drug.)
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'analyteStability',
      value: { median: 48, unit: 'h' },
      updatedBy: userId,
    });

    await db.execute(sql.raw(migrationStatement('INSERT INTO "parameter_entries"')));

    // No synthetic entry — the parameter keeps its authored drug_parameters
    // value and is grandfathered by the Phase-2 aggregate rule instead, so it
    // is never assigned a false 'case_report' scenario or a fabricated unit.
    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(rows).toHaveLength(0);
  });
});

describe('legacy reference-concentrations endpoint excludes synthetic rows', () => {
  it('lists legacy-origin rows but not grandfathered ones', async () => {
    const drugId = await seedDrug(db);
    // A genuine legacy source row (default origin='legacy').
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '100',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
    });
    // A synthetic cache-preservation row with identical value in whole blood.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '100',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      origin: 'grandfathered',
    });

    const listed = await listReferenceConcentrations({ drugId });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.matrix).toBe('serum');
    expect(listed[0]!.origin).toBe('legacy');
  });
});

describe('migration 0079 — pending_edits_open_entry_idx', () => {
  it('allows many concurrent create edits but one open update per entry', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);

    const insertEntryEdit = (op: string, targetId: number) =>
      db.insert(pendingEdits).values({
        editType: 'param_entry',
        targetId,
        parameter: 'therapeuticConcentration',
        proposedValue: { op } as never,
        status: 'pending',
        submittedBy: userId,
      });

    // Two create proposals on the same (drug, parameter) coexist.
    await insertEntryEdit('create', drugId);
    await expect(insertEntryEdit('create', drugId)).resolves.toBeDefined();

    // First update on entry 42 is fine.
    await insertEntryEdit('update', 42);
    // Second open update on the SAME entry violates the partial unique index.
    await expect(insertEntryEdit('update', 42)).rejects.toThrow();
    // An update on a DIFFERENT entry is fine.
    await expect(insertEntryEdit('update', 43)).resolves.toBeDefined();
  });
});
