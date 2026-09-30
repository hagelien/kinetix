import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentFocusConfig,
  analyticalMethodComponents,
  analyticalMethods,
  disputes,
  drugParameterApplicability,
  drugParameterDiscussions,
  drugParameterRevisions,
  drugParameters,
  parameterEntries,
  parameterPriorityFlags,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import { retireLoqLodRows } from '../../scripts/retire-loq-lod-rows.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

/**
 * `npm run retire:loq-lod` — the post-deploy sweep for the retired `loq`/`lod`
 * parameters.
 *
 * The registry change alone only stops NEW writes; whether the rows already in
 * the database are gone is a property of this SQL, and a table missed here
 * leaves a row that no surface can render and no editor can reach. The test
 * drives the exported entry point, which executes the exported statement text,
 * so a copy cannot drift from what an operator actually runs.
 */
let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function seedDispute(
  targetType: string,
  targetId: number,
  createdBy: number,
): Promise<number> {
  const [row] = await db
    .insert(disputes)
    .values({
      targetType,
      targetId,
      createdBy,
      source: 'agent',
      reasonMd: 'This limit is method-specific and cannot be a drug property.',
      status: 'open',
    })
    .returning({ id: disputes.id });
  return row!.id;
}

describe('retire loq/lod rows', () => {
  it('removes the retired rows from every table that keys on a parameter', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);

    for (const parameter of ['loq', 'lod', 'halfLife']) {
      await db.insert(drugParameters).values({
        drugId,
        parameter,
        value: { median: 2, unit: 'ng/mL' } as never,
        updatedBy: userId,
      });
      await db.insert(parameterEntries).values({
        drugId,
        parameter,
        low: '0.5',
        unit: 'ng/mL',
      });
      await db.insert(drugParameterRevisions).values({
        drugId,
        parameter,
        newValue: { median: 2 } as never,
        createdBy: userId,
      });
      await db.insert(pendingEdits).values({
        editType: 'parameter',
        targetId: drugId,
        parameter,
        proposedValue: { median: 2 } as never,
        status: 'pending',
        submittedBy: userId,
      });
      await db.insert(pendingEdits).values({
        editType: 'param_entry',
        targetId: drugId,
        parameter,
        proposedValue: { op: 'create' } as never,
        status: 'pending',
        submittedBy: userId,
      });
      await db.insert(parameterPriorityFlags).values({
        drugId,
        parameter,
        createdBy: userId,
      });
      await db.insert(drugParameterApplicability).values({
        drugId,
        parameter,
        status: 'not_applicable',
        reason: 'test',
        createdBy: userId,
      });
      await db.insert(drugParameterDiscussions).values({
        drugId,
        parameter,
        body: 'test',
        createdBy: userId,
      });
    }

    await retireLoqLodRows({ apply: true });

    const parameterOf = async (
      rows: PromiseLike<Array<{ parameter: string | null }>>,
    ) => (await rows).map((r) => r.parameter);

    expect(await parameterOf(db.select().from(drugParameters))).toEqual([
      'halfLife',
    ]);
    expect(await parameterOf(db.select().from(parameterEntries))).toEqual([
      'halfLife',
    ]);
    expect(await parameterOf(db.select().from(drugParameterRevisions))).toEqual([
      'halfLife',
    ]);
    expect(await parameterOf(db.select().from(parameterPriorityFlags))).toEqual([
      'halfLife',
    ]);
    expect(
      await parameterOf(db.select().from(drugParameterApplicability)),
    ).toEqual(['halfLife']);
    expect(
      await parameterOf(db.select().from(drugParameterDiscussions)),
    ).toEqual(['halfLife']);
    // Both edit types are swept, and only for the retired parameters.
    expect(
      (await db.select().from(pendingEdits)).map(
        (r) => `${r.editType}:${r.parameter}`,
      ),
    ).toEqual(['parameter:halfLife', 'param_entry:halfLife']);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'loq',
      value: { median: 2, unit: 'ng/mL' } as never,
      updatedBy: userId,
    });

    const first = await retireLoqLodRows({ apply: true });
    const second = await retireLoqLodRows({ apply: true });

    expect(first.reduce((n, r) => n + r.rows, 0)).toBe(1);
    expect(second.reduce((n, r) => n + r.rows, 0)).toBe(0);
  });

  it('reports without writing on a dry run', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'loq',
      value: { median: 2, unit: 'ng/mL' } as never,
      updatedBy: userId,
    });

    const planned = await retireLoqLodRows({ apply: false });

    expect(planned.reduce((n, r) => n + r.rows, 0)).toBe(1);
    expect(await db.select().from(drugParameters)).toHaveLength(1);
  });

  describe('open disputes', () => {
    // `disputes.target_id` is polymorphic and unconstrained, and
    // `listOpenDisputes` reads open rows without joining to the target. A
    // dispute left pointing at a deleted revision, proposal or thread becomes a
    // feed item nobody can resolve, so each one is withdrawn BEFORE its target
    // goes.
    it('withdraws a dispute on a deleted parameter revision', async () => {
      const userId = await seedUser(db);
      const drugId = await seedDrug(db);
      const [revision] = await db
        .insert(drugParameterRevisions)
        .values({
          drugId,
          parameter: 'loq',
          newValue: { median: 2 } as never,
          createdBy: userId,
        })
        .returning({ id: drugParameterRevisions.id });
      const disputeId = await seedDispute(
        'drug_parameter_revision',
        revision!.id,
        userId,
      );

      await retireLoqLodRows({ apply: true });

      const [row] = await db
        .select()
        .from(disputes)
        .where(eq(disputes.id, disputeId));
      expect(row!.status).toBe('resolved');
      expect(row!.resolution).toBe('withdrawn');
      // No person made this call, so it is not attributed to one.
      expect(row!.resolvedBy).toBeNull();
      expect(row!.resolvedAt).not.toBeNull();
    });

    it('withdraws disputes on a deleted proposal and discussion thread', async () => {
      const userId = await seedUser(db);
      const drugId = await seedDrug(db);
      const [edit] = await db
        .insert(pendingEdits)
        .values({
          editType: 'param_entry',
          targetId: drugId,
          parameter: 'lod',
          proposedValue: { op: 'create' } as never,
          status: 'pending',
          submittedBy: userId,
        })
        .returning({ id: pendingEdits.id });
      const [thread] = await db
        .insert(drugParameterDiscussions)
        .values({ drugId, parameter: 'lod', body: 'x', createdBy: userId })
        .returning({ id: drugParameterDiscussions.id });
      const editDispute = await seedDispute('pending_edit', edit!.id, userId);
      const threadDispute = await seedDispute(
        'drug_discussion',
        thread!.id,
        userId,
      );

      await retireLoqLodRows({ apply: true });

      const rows = await db.select().from(disputes);
      expect(rows).toHaveLength(2);
      for (const id of [editDispute, threadDispute]) {
        const row = rows.find((r) => r.id === id);
        expect(row!.status, `dispute ${id}`).toBe('resolved');
        expect(row!.resolution, `dispute ${id}`).toBe('withdrawn');
      }
    });

    it('leaves a dispute on a surviving target open', async () => {
      const userId = await seedUser(db);
      const drugId = await seedDrug(db);
      const [revision] = await db
        .insert(drugParameterRevisions)
        .values({
          drugId,
          parameter: 'halfLife',
          newValue: { median: 2 } as never,
          createdBy: userId,
        })
        .returning({ id: drugParameterRevisions.id });
      const disputeId = await seedDispute(
        'drug_parameter_revision',
        revision!.id,
        userId,
      );

      await retireLoqLodRows({ apply: true });

      const [row] = await db
        .select()
        .from(disputes)
        .where(eq(disputes.id, disputeId));
      expect(row!.status).toBe('open');
    });
  });

  it('leaves a wiki-page discussion thread alone', async () => {
    // `drug_parameter_discussions.parameter` doubles as the `fact:<id>` key for
    // topic pages, where `drug_id` is null and `wiki_page_id` is set. Sweeping
    // by parameter alone would reach into that population; the `drug_id IS NOT
    // NULL` guard is what keeps this sweep to the drug-level threads.
    const userId = await seedUser(db);
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'topic',
        title: 'Topic',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });
    await db.insert(drugParameterDiscussions).values({
      wikiPageId: page!.id,
      parameter: 'loq',
      body: 'topic thread',
      createdBy: userId,
    });

    await retireLoqLodRows({ apply: true });

    expect(await db.select().from(drugParameterDiscussions)).toHaveLength(1);
  });

  it('prunes the retired ids out of the admin agent focus list', async () => {
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'parameters',
      parameters: ['halfLife', 'loq', 'clearance', 'lod'] as never,
    });

    await retireLoqLodRows({ apply: true });

    const [row] = await db.select().from(agentFocusConfig);
    expect(row!.parameters).toEqual(['halfLife', 'clearance']);
  });

  it('leaves a focus list without the retired ids untouched', async () => {
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'parameters',
      parameters: ['halfLife'] as never,
    });

    await retireLoqLodRows({ apply: true });

    const [row] = await db.select().from(agentFocusConfig);
    expect(row!.parameters).toEqual(['halfLife']);
  });

  it('empties a focus list that named only the retired ids, rather than widening it', async () => {
    // An empty `parameters` list under mode='parameters' means "nothing is in
    // scope" — the agent logs no_change and the response echoes the empty
    // focus. Resetting the mode to 'all' would silently point the maintenance
    // agent at the whole catalogue against an explicit admin instruction.
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'parameters',
      parameters: ['loq', 'lod'] as never,
    });

    await retireLoqLodRows({ apply: true });

    const [row] = await db.select().from(agentFocusConfig);
    expect(row!.parameters).toEqual([]);
    expect(row!.mode).toBe('parameters');
  });

  it('does not touch the method-level limits, which are the replacement', async () => {
    // `analytical_method_components.lor` (cut-off) and `.mkk` (LLOQ) are where
    // an analytical limit legitimately lives — per analyte, per method. The
    // sweep must not reach them while clearing the drug-level rows.
    const drugId = await seedDrug(db);
    const [method] = await db
      .insert(analyticalMethods)
      .values({ code: '9002', name: 'Test method', methodType: 'confirmatory' })
      .returning({ id: analyticalMethods.id });
    await db.insert(analyticalMethodComponents).values({
      methodId: method!.id,
      drugId,
      lor: 0.02,
      mkk: 0.00075,
      lod: 0.00667,
      unit: 'µmol/l',
    });

    await retireLoqLodRows({ apply: true });

    const rows = await db.select().from(analyticalMethodComponents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lor).toBeCloseTo(0.02);
    expect(rows[0]!.mkk).toBeCloseTo(0.00075);
    expect(rows[0]!.lod).toBeCloseTo(0.00667);
  });
});
