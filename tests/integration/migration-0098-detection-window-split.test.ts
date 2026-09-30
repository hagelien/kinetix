/**
 * Migration 0098 — splitting `bloodOralFluidDetectionWindow` into
 * `bloodDetectionWindow` + `oralFluidDetectionWindow`.
 *
 * The registry no longer declares the combined id, so any row still carrying it
 * is invisible: the API rejects writes to it, the sidebar skips it, and the
 * value it holds — sourced, cited, reviewed — silently stops rendering. The
 * migration therefore has to reach every table that stores a parameter id, plus
 * the two jsonb id lists, or the split loses data instead of sharpening it.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (against an empty database) leaves nothing to observe. The real statements
 * are pulled out of the .sql file and re-run against seeded rows — the same
 * approach as the 0078 and 0087 tests, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentFocusConfig,
  drugParameters,
  parameterEntries,
  parameterPriorityFlags,
  pendingEdits,
  users,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';
import { validateParameterBag } from '../../api/_lib/drugs-helpers.js';
import { isDrugParameterId } from '../../src/lib/drugParameters.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;

const OLD = 'bloodOralFluidDetectionWindow';
const BLOOD = 'bloodDetectionWindow';
const ORAL_FLUID = 'oralFluidDetectionWindow';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0098_split_blood_oral_fluid_detection_window.sql',
);

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

/** Read the parameter ids stored in one table, in insertion order. */
async function parametersIn(table: string): Promise<string[]> {
  const rows = await db.execute<{ parameter: string | null }>(
    sql.raw(`SELECT parameter FROM ${table} ORDER BY 1`),
  );
  return rows.rows.map((r) => r.parameter ?? '(null)');
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  drugId = await seedDrug(db);
});

describe('migration 0098 — blood / oral-fluid detection window split', () => {
  it('moves the cached value and its source entries to the blood window', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: OLD,
      value: { min: 6, max: 12, unit: 'h' },
      updatedBy: userId,
    });
    await db.insert(parameterEntries).values({
      drugId,
      parameter: OLD,
      low: '6',
      high: '12',
      unit: 'h',
      createdBy: userId,
    });

    await runMigration();

    const [cached] = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect(cached?.parameter).toBe(BLOOD);
    // The aggregate is a recomputed cache of the entries below it, so the two
    // have to move together or the summary describes a parameter that no longer
    // has any rows under it.
    expect(await parametersIn('parameter_entries')).toEqual([BLOOD]);
  });

  it('carries the review, history and agent-queue rows across', async () => {
    await db.execute(sql`
      INSERT INTO drug_parameter_revisions (drug_id, parameter, new_value, created_by)
      VALUES (${drugId}, ${OLD}, ${'{"min":6,"unit":"h"}'}::jsonb, ${userId})
    `);
    await db.execute(sql`
      INSERT INTO drug_parameter_applicability (drug_id, parameter, reason)
      VALUES (${drugId}, ${OLD}, 'Metabolite is never administered.')
    `);
    await db.execute(sql`
      INSERT INTO drug_parameter_discussions (drug_id, parameter, body, created_by)
      VALUES (${drugId}, ${OLD}, 'Which cut-off is this against?', ${userId})
    `);
    await db.insert(pendingEdits).values({
      editType: 'parameter',
      targetId: drugId,
      parameter: OLD,
      proposedValue: { min: 6, max: 12, unit: 'h' },
      submittedBy: userId,
    });
    await db.insert(parameterPriorityFlags).values({
      drugId,
      parameter: OLD,
      note: 'Needed for an active case.',
    });
    await db.execute(sql`
      INSERT INTO verification_log (target_type, target_id, parameter, concordance, outcome)
      VALUES ('parameter', ${drugId}, ${OLD}, 'absent', 'no_change')
    `);

    await runMigration();

    expect(await parametersIn('drug_parameter_revisions')).toEqual([BLOOD]);
    expect(await parametersIn('drug_parameter_applicability')).toEqual([BLOOD]);
    expect(await parametersIn('drug_parameter_discussions')).toEqual([BLOOD]);
    expect(await parametersIn('pending_edits')).toEqual([BLOOD]);
    expect(await parametersIn('verification_log')).toEqual([BLOOD]);
    // A flag already raised against the combined window is renamed, not
    // duplicated; the oral-fluid flag the split adds is driven by the stored
    // value (covered below), and this drug has none.
    expect(await parametersIn('parameter_priority_flags')).toEqual([BLOOD]);
  });

  it('rewrites the parameter inside a param_entry payload, not a plain one', async () => {
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: OLD,
      proposedValue: {
        op: 'create',
        input: { drugId, parameter: OLD, low: 6, high: 12, unit: 'h' },
      },
      submittedBy: userId,
    });
    // A plain `parameter` edit stores the range itself, with no nested id to
    // rewrite — the payload must come through untouched.
    await db.insert(pendingEdits).values({
      editType: 'parameter',
      targetId: drugId,
      parameter: OLD,
      proposedValue: { min: 6, max: 12, unit: 'h' },
      submittedBy: userId,
    });

    await runMigration();

    const rows = await db
      .select({
        editType: pendingEdits.editType,
        parameter: pendingEdits.parameter,
        proposedValue: pendingEdits.proposedValue,
      })
      .from(pendingEdits)
      .orderBy(pendingEdits.id);

    const entryEdit = rows[0]!;
    // Approval cross-checks the payload against the row's `parameter` column
    // and refuses the edit when they disagree (param_entry_target_mismatch), so
    // a rename that skipped the payload would strand every open proposal.
    expect(entryEdit.parameter).toBe(BLOOD);
    expect(
      (entryEdit.proposedValue as { input: { parameter: string } }).input
        .parameter,
    ).toBe(BLOOD);

    expect(rows[1]!.parameter).toBe(BLOOD);
    expect(rows[1]!.proposedValue).toEqual({ min: 6, max: 12, unit: 'h' });
  });

  it('renames the id inside a queued monograph draft parameter bag', async () => {
    // A `wiki_new` draft keeps its initial PK values keyed by parameter id in
    // proposed_meta, not in the `parameter` column — and approval runs the bag
    // through validateParameterBag, which throws `Unknown parameter` on an id
    // the registry no longer declares. Left alone, the draft carries a key
    // nothing can resolve: not the review card that renders it, not the gap
    // queue that reads it, not a reviewer who strips the bag by hand.
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      proposedValue: { content: 'Ny monografi' },
      proposedMeta: {
        title: 'Nytt stoff',
        parameters: {
          halfLife: { min: 2, max: 4, unit: 'h' },
          [OLD]: { min: 6, max: 12, unit: 'h' },
        },
      },
      submittedBy: userId,
    });

    await runMigration();

    const [draft] = await db.select().from(pendingEdits);
    const bag = (draft!.proposedMeta as { parameters: Record<string, unknown> })
      .parameters;
    expect(Object.keys(bag).sort()).toEqual([BLOOD, 'halfLife']);
    expect(bag[BLOOD]).toEqual({ min: 6, max: 12, unit: 'h' });
    // Every key resolves against the live registry again. The bag is still not
    // approvable — both ids are source-value-backed, and validateParameterBag
    // refuses an authored value for those — but it now fails on the rule that
    // applies to it rather than on an id that no longer exists.
    for (const id of Object.keys(bag)) {
      expect(isDrugParameterId(id), `${id} is a live parameter id`).toBe(true);
    }
    expect(() => validateParameterBag(bag)).toThrow(/source values/i);
  });

  it('repoints the pinned and focused parameter lists', async () => {
    await db
      .update(users)
      .set({ favoriteParameters: ['halfLife', OLD, 'urineDetectionWindow'] })
      .where(eq(users.id, userId));
    await db.insert(agentFocusConfig).values({
      mode: 'parameters',
      parameters: [OLD],
      updatedBy: userId,
    });

    await runMigration();

    const [user] = await db
      .select({ favorites: users.favoriteParameters })
      .from(users)
      .where(eq(users.id, userId));
    // Order is the user's pin order; only the renamed element changes.
    expect(user?.favorites).toEqual([
      'halfLife',
      BLOOD,
      'urineDetectionWindow',
    ]);

    const [focus] = await db.select().from(agentFocusConfig);
    expect(focus?.parameters).toEqual([BLOOD]);
  });

  it('queues the oral-fluid window for sourcing on every migrated drug', async () => {
    const other = await seedDrug(db, { slug: 'other-drug' });
    await db.insert(drugParameters).values([
      { drugId, parameter: OLD, value: { min: 6, max: 12, unit: 'h' } },
      { drugId: other, parameter: 'halfLife', value: { min: 2, unit: 'h' } },
    ]);

    await runMigration();

    const flags = await db
      .select()
      .from(parameterPriorityFlags)
      .where(eq(parameterPriorityFlags.parameter, ORAL_FLUID));
    // Only the drug that had a combined window is flagged — the split creates
    // no work for a drug that never had one.
    expect(flags).toHaveLength(1);
    expect(flags[0]!.drugId).toBe(drugId);
    expect(flags[0]!.status).toBe('active');
    expect(flags[0]!.note).toContain('oral-fluid window');
  });

  it('is idempotent — a replay adds no duplicate flag', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: OLD,
      value: { min: 6, max: 12, unit: 'h' },
    });

    await runMigration();
    await runMigration();

    const flags = await db
      .select()
      .from(parameterPriorityFlags)
      .where(
        and(
          eq(parameterPriorityFlags.parameter, ORAL_FLUID),
          eq(parameterPriorityFlags.status, 'active'),
        ),
      );
    expect(flags).toHaveLength(1);
  });

  it('a replay catches a row the outgoing build wrote after the migration', async () => {
    // The build-window hazard the post-deploy backfill exists for: migrations
    // run during `vercel build`, so the previous deployment keeps accepting
    // writes under the old id for minutes after these statements ran. The
    // backfill replays this same file, so the late row has to be picked up by
    // a second pass exactly as the first pass picked up the rest.
    await runMigration();

    const late = await seedDrug(db, { slug: 'late-write' });
    await db.insert(drugParameters).values({
      drugId: late,
      parameter: OLD,
      value: { min: 4, max: 8, unit: 'h' },
    });

    await runMigration();

    const [row] = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, late));
    expect(row?.parameter).toBe(BLOOD);
    const flags = await db
      .select()
      .from(parameterPriorityFlags)
      .where(eq(parameterPriorityFlags.drugId, late));
    expect(flags.map((f) => f.parameter)).toEqual([ORAL_FLUID]);
  });

  it('leaves a drug that already has an oral-fluid value unflagged', async () => {
    await db.insert(drugParameters).values([
      { drugId, parameter: OLD, value: { min: 6, max: 12, unit: 'h' } },
      { drugId, parameter: ORAL_FLUID, value: { min: 3, unit: 'h' } },
    ]);

    await runMigration();

    // Nothing to source: the split's other half is already filled, so a flag
    // here would be queue noise the maintenance agent has to clear by hand.
    const flags = await db.select().from(parameterPriorityFlags);
    expect(flags).toHaveLength(0);
  });
});
