/**
 * #37 — whole-block revision history for metabolism, pharmacodynamics and the
 * PK model structure, over real SQL (PGlite, full migration chain).
 *
 * These blocks are structured lists, not drug_parameters rows, so before
 * `drug_block_revisions` an edit to them — including an admin's direct write —
 * left no history at all. Covers: each block's write path records a
 * before/after snapshot, an identical re-save records nothing, the model
 * structure's first observed change does not claim the block was empty, and
 * the history endpoint serves a block's rows.
 */
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
  requestHasAuthCookie: () => true,
}));

import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import { getDrugMetabolism, replaceDrugMetabolism } from '../../api/_lib/metabolismStore.js';
import { replaceDrugReceptorTargets } from '../../api/_lib/receptorTargetStore.js';
import {
  beginBlockHistory,
  metabolismInputLinkedDrugIds,
  withBlockHistory,
} from '../../api/_lib/drugBlockHistory.js';
import { failBlockRevisionInserts } from './setup/block-history.js';
import {
  collectReferenceUsage,
  collectUsedCitationIdsForDrug,
  filterUsedCitationIds,
} from '../../api/_lib/citation-usage.js';
import {
  drugBlockRevisions,
  pendingEdits,
  drugMetabolismProfiles,
  parameterEntries,
} from '../../db/schema.js';
import {
  attachSourceQuoteIfMissing,
  deleteParameterEntryRow,
  insertParameterEntry,
  recomputeParameterAndDependents,
} from '../../api/_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../../src/lib/parameterEntries.js';
import handler from '../../api/drug-parameter-history.js';
import metabolismHandler from '../../api/drug-metabolism.js';
import receptorHandler from '../../api/drug-receptor-targets.js';
import entryHandler from '../../api/parameter-entries.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import { mergeDrugs } from '../../api/_lib/drug-merge.js';
import { mergeCitations } from '../../api/_lib/citation-merge.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import {
  seedAdmissibleCitation,
  seedBioEntity,
  seedDrug,
  seedUser,
} from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
  getUserFromRequestMock.mockResolvedValue(null);
});

async function revisionsFor(drugId: number, block: string) {
  const rows = await db
    .select()
    .from(drugBlockRevisions)
    .where(eq(drugBlockRevisions.drugId, drugId))
    .orderBy(asc(drugBlockRevisions.id));
  return rows.filter((row) => row.block === block);
}

/** The entry write paths all run the recompute inside their transaction. */
function recomputeInTransaction(
  ...args: Parameters<typeof recomputeParameterAndDependents>
) {
  return runInPoolTransaction(() => recomputeParameterAndDependents(...args));
}

/** A metabolism write the way the API makes one: recorded by the recorder. */
function recordedMetabolismWrite(
  drugId: number,
  input: Parameters<typeof replaceDrugMetabolism>[2],
  userId: number,
) {
  return withBlockHistory(
    {
      drugIds: [drugId, ...metabolismInputLinkedDrugIds(input)],
      blocks: ['metabolism'],
      actorUserId: userId,
    },
    () => replaceDrugMetabolism(getDb(), drugId, input, userId),
  );
}

function recordedReceptorWrite(
  drugId: number,
  mechanisms: Parameters<typeof replaceDrugReceptorTargets>[2],
  userId: number,
) {
  return withBlockHistory(
    { drugIds: [drugId], blocks: ['pharmacodynamics'], actorUserId: userId },
    () => replaceDrugReceptorTargets(getDb(), drugId, mechanisms, userId),
  );
}

function metabolismInput(fraction: number) {
  return {
    profile: { evidenceNote: 'Hovedsakelig nyreutskillelse.' },
    routes: [{ kind: 'renal_unchanged' as const, fraction: { median: fraction } }],
    metabolites: [],
    precursors: [],
  };
}

async function request(
  route: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string, url: string, payload?: unknown,
) {
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)) };
  const state = { status: 0, body: '' };
  const res = { headersSent: false, setHeader: vi.fn(),
    writeHead: vi.fn((status: number) => { state.status = status; return res; }),
    end: vi.fn((body?: string) => { state.body = body ?? ''; return res; }),
  } as unknown as ServerResponse;
  await route(req, res);
  return { status: state.status, body: state.body ? JSON.parse(state.body) : null };
}

async function summaryRequest(block: string, drugId: number, citationId: number, editSummary: string, queued = false) {
  if (block === 'metabolism') return request(metabolismHandler, 'PUT', `/api/drug-metabolism?drugId=${drugId}`,
    { ...metabolismInput(0.5), editSummary, submitForReview: queued });
  if (block === 'pharmacodynamics') {
    const entity = await seedBioEntity(db);
    return request(receptorHandler, 'PUT', `/api/drug-receptor-targets?drugId=${drugId}`,
      { mechanisms: [{ receptorTargetId: entity, interactionType: 'agonist' }], editSummary, submitForReview: queued });
  }
  return request(entryHandler, 'POST', '/api/parameter-entries', {
    drugId, citationId, parameter: 'dispositionModel', categoricalValue: 'two-compartment', unit: '',
    editSummary, submitForReview: queued,
  });
}

describe('drug block revisions', () => {
  it.each(['metabolism', 'pharmacodynamics'] as const)(
    'returns the stable missing-reference save code for %s', async (block) => {
      const drugId = await seedDrug(db);
      const userId = await seedUser(db, { role: 'admin' });
      getUserFromRequestMock.mockResolvedValue({ userId, role: 'admin' });
      const missing = 987654321;
      const entity = await seedBioEntity(db);
      const saved = block === 'metabolism'
        ? await request(metabolismHandler, 'PUT', `/api/drug-metabolism?drugId=${drugId}`,
          { ...metabolismInput(0.5), profile: { referenceIds: [missing] } })
        : await request(receptorHandler, 'PUT', `/api/drug-receptor-targets?drugId=${drugId}`,
          { mechanisms: [{ receptorTargetId: entity, interactionType: 'agonist', referenceIds: [missing] }] });
      expect(saved.status).toBe(400);
      expect(saved.body.code).toBe('block_reference_missing');
      expect(await revisionsFor(drugId, block)).toEqual([]);
    },
  );

  it.each(['metabolism', 'pharmacodynamics'] as const)(
    'retains a direct %s edit summary through the public history API', async (block) => {
      const drugId = await seedDrug(db);
      const userId = await seedUser(db, { role: 'admin' });
      const citationId = await seedAdmissibleCitation(db);
      getUserFromRequestMock.mockResolvedValue({ userId, role: 'admin' });
      const summary = 'Revised after checking the original assay — curator rationale.';
      expect((await summaryRequest(block, drugId, citationId, summary)).status).toBe(200);
      const [revision] = await revisionsFor(drugId, block);
      expect(revision!.editSummary).toBe(summary);
      const history = await request(handler, 'GET', `/api/drug-parameter-history?drugId=${drugId}&block=${block}`);
      expect(history.status).toBe(200);
      expect(history.body.revisions[0].editSummary).toBe(summary);
    },
  );

  it.each(['metabolism', 'pharmacodynamics', 'modelStructure'] as const)(
    'copies an approved %s summary into its revision', async (block) => {
      const drugId = await seedDrug(db);
      const userId = await seedUser(db, { role: 'admin' });
      const citationId = await seedAdmissibleCitation(db);
      getUserFromRequestMock.mockResolvedValue({ userId, role: 'admin' });
      const summary = 'The submitted reason for this reviewed change.';
      const queued = await summaryRequest(block, drugId, citationId, summary, true);
      expect(queued.status).toBe(201);
      await applyApprovedEdit(queued.body.pendingEditId, userId);
      const [revision] = await revisionsFor(drugId, block);
      expect(revision!.editSummary).toBe(summary);
      expect(revision!.pendingEditId).toBe(queued.body.pendingEditId);
      // The revision owns a copy, rather than reading mutable proposal text
      // each time a reader opens history.
      await db.update(pendingEdits).set({ proposedMeta: { editSummary: 'Later metadata' } })
        .where(eq(pendingEdits.id, queued.body.pendingEditId));
      const history = await request(handler, 'GET', `/api/drug-parameter-history?drugId=${drugId}&block=${block}`);
      expect(history.body.revisions[0].editSummary).toBe(summary);
    },
  );

  it('retains direct model-entry create and update summaries', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db, { role: 'admin' });
    const citationId = await seedAdmissibleCitation(db);
    getUserFromRequestMock.mockResolvedValue({ userId, role: 'admin' });
    const created = await summaryRequest('modelStructure', drugId, citationId, 'Model selected from the study.');
    expect(created.status).toBe(201);
    const updated = await request(entryHandler, 'PATCH', `/api/parameter-entries?id=${created.body.id}`,
      { categoricalValue: 'one-compartment', citationId, unit: '', editSummary: 'Corrected after re-reading the methods.' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions.map((r) => r.editSummary)).toEqual([
      'Model selected from the study.', 'Corrected after re-reading the methods.',
    ]);
  });

  it('backfills linked rationale without replacing a summary already saved on the revision', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const [edit] = await db.insert(pendingEdits).values({ editType: 'metabolism', targetId: drugId,
      proposedValue: {}, proposedMeta: { editSummary: 'Recoverable original rationale.' },
      submittedBy: userId, status: 'approved',
    }).returning({ id: pendingEdits.id });
    await db.insert(drugBlockRevisions).values([
      { drugId, block: 'metabolism', newValue: {}, pendingEditId: edit!.id },
      { drugId, block: 'metabolism', newValue: {}, pendingEditId: edit!.id, editSummary: 'Already saved.' },
      { drugId, block: 'metabolism', newValue: {} },
    ]);
    const migration = readFileSync(new URL('../../drizzle/0158_drug_block_revision_summaries.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await db.execute(sql.raw(statement));
    expect((await revisionsFor(drugId, 'metabolism')).map((r) => r.editSummary)).toEqual([
      'Recoverable original rationale.', 'Already saved.', null,
    ]);
  });

  it('records the metabolism box before and after each change, and skips an identical re-save', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const write = (fraction: number) =>
      runInPoolTransaction(() =>
        recordedMetabolismWrite(drugId, metabolismInput(fraction), userId),
      );

    await write(0.6);
    await write(0.6); // same content, re-inserted rows with new ids
    await write(0.8);

    const revisions = await revisionsFor(drugId, 'metabolism');
    expect(revisions).toHaveLength(2);
    const [first, second] = revisions;
    // The box was empty before the first write: an empty snapshot, not NULL.
    expect(first!.oldValue).toEqual({
      evidenceNote: null,
      referenceIds: [],
      routes: [],
      metabolites: [],
      precursors: [],
    });
    expect(first!.createdBy).toBe(userId);
    const routes = (v: unknown) =>
      (v as { routes: Array<{ fraction: { median: number } }> }).routes;
    expect(routes(first!.newValue)[0]!.fraction.median).toBe(0.6);
    expect(routes(second!.oldValue)[0]!.fraction.median).toBe(0.6);
    expect(routes(second!.newValue)[0]!.fraction.median).toBe(0.8);
  });

  it('records the receptor-target mechanisms as one pharmacodynamics block', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const entityId = await seedBioEntity(
      db,
      { slug: 'drd2', symbol: 'DRD2', name: 'Dopamin D2', entityClass: 'receptor' },
      ['drug_target'],
    );

    await runInPoolTransaction(() =>
      recordedReceptorWrite(
        drugId,
        [{ receptorTargetId: entityId, interactionType: 'antagonist', tier: 'primary' }],
        userId,
      ),
    );

    const [revision] = await revisionsFor(drugId, 'pharmacodynamics');
    expect(revision!.oldValue).toEqual({ mechanisms: [] });
    const mechanisms = (revision!.newValue as {
      mechanisms: Array<{ interactionType: string; target: { symbol: string } }>;
    }).mechanisms;
    expect(mechanisms).toHaveLength(1);
    expect(mechanisms[0]!.interactionType).toBe('antagonist');
    expect(mechanisms[0]!.target.symbol).toBe('DRD2');
  });

  it('records each model-structure declaration change, chaining from the last snapshot', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const declare = (categoricalValue: string) =>
      insertParameterEntry(
        {
          drugId,
          citationId,
          parameter: 'dispositionModel',
          categoricalValue,
          unit: '',
        } as ParameterEntryInput,
        userId,
      );

    const first = await declare('two-compartment');
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    // A recompute with nothing changed (e.g. a cascade) records nothing.
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    await deleteParameterEntryRow(first.id);
    await recomputeInTransaction(drugId, 'dispositionModel', userId);

    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(2);
    // Declarations are observed after the write, so the first recorded change
    // says its "before" was not recorded rather than claiming an empty block.
    expect(revisions[0]!.oldValue).toBeNull();
    expect(revisions[0]!.newValue).toEqual({
      routeValues: [],
      declarations: [
        {
          parameter: 'dispositionModel',
          categoricalValue: 'two-compartment',
          route: null,
          citationId,
          sourceQuote: null,
          n: null,
          comments: null,
          observationContext: null,
          // No formulation, regimen or population scope (#12).
          doseRegimen: null,
          doseIntervalHours: null,
          releaseProfile: null,
          physicalForm: null,
          pkPopulation: null,
          populationQualifier: null,
        },
      ],
    });
    expect(revisions[1]!.oldValue).toEqual(revisions[0]!.newValue);
    expect(revisions[1]!.newValue).toEqual({ declarations: [], routeValues: [] });
  });

  // Codex review on #303: a merge repointed the loser's block revisions onto
  // the survivor without recording the merged block, so the next
  // model-structure edit took one side's snapshot as the prior state.
  it('records the merged blocks against the survivor, so later history chains from them', async () => {
    const actorId = await seedUser(db, { email: 'admin@example.com', username: 'admin' });
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const winnerId = await seedDrug(db, { slug: 'vinner', names: { nb: 'Vinner' } });
    const loserId = await seedDrug(db, { slug: 'taper', names: { nb: 'Taper' } });
    const declare = async (drugId: number, parameter: string, categoricalValue: string) => {
      await insertParameterEntry(
        { drugId, citationId, parameter, categoricalValue, unit: '' } as ParameterEntryInput,
        userId,
      );
      await recomputeInTransaction(drugId, parameter as never, userId);
    };
    await declare(winnerId, 'dispositionModel', 'two-compartment');
    await declare(loserId, 'eliminationModel', 'first-order');
    await runInPoolTransaction(() =>
      recordedMetabolismWrite(loserId, metabolismInput(0.4), userId),
    );
    const winnerBefore = (await revisionsFor(winnerId, 'modelStructure')).at(-1)!.newValue;

    await runInPoolTransaction(() =>
      mergeDrugs(getDb(), {
        winnerId,
        loserId,
        resolutions: {},
        actorUserId: actorId,
        approvedPlanFingerprint: null,
      }),
    );

    const model = await revisionsFor(winnerId, 'modelStructure');
    const merged = model.at(-1)!;
    expect(merged.createdBy).toBe(actorId);
    expect(merged.oldValue).toEqual(winnerBefore);
    const parameters = (v: unknown) =>
      (v as { declarations: Array<{ parameter: string }> }).declarations
        .map((d) => d.parameter)
        .sort();
    expect(parameters(merged.newValue)).toEqual(['dispositionModel', 'eliminationModel']);

    const metabolism = (await revisionsFor(winnerId, 'metabolism')).at(-1)!;
    expect(metabolism.createdBy).toBe(actorId);
    expect(metabolism.oldValue).toEqual({
      evidenceNote: null,
      referenceIds: [],
      routes: [],
      metabolites: [],
      precursors: [],
    });
    expect((metabolism.newValue as { routes: unknown[] }).routes).toHaveLength(1);

    // The next edit's "before" is the merged block, not either side's stream.
    await declare(winnerId, 'absorptionModel', 'first-order');
    const next = (await revisionsFor(winnerId, 'modelStructure')).at(-1)!;
    expect(next.oldValue).toEqual(merged.newValue);
  });

  // Codex review on #303: a citation merge left the loser's id in block
  // snapshots, so the history showed a deleted reference and the model
  // structure's next revision chained from a snapshot the live block no longer
  // matched.
  it('repoints citations inside block snapshots when two citations are merged', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const winner = await seedAdmissibleCitation(db, { identifier: '111' });
    const loser = await seedAdmissibleCitation(db, { identifier: '222' });
    await insertParameterEntry(
      {
        drugId,
        citationId: loser,
        parameter: 'dispositionModel',
        categoricalValue: 'two-compartment',
        unit: '',
      } as ParameterEntryInput,
      userId,
    );
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    await runInPoolTransaction(() =>
      recordedMetabolismWrite(
        drugId,
        {
          profile: {},
          routes: [
            {
              kind: 'renal_unchanged' as const,
              fraction: { median: 0.5 },
              referenceIds: [loser, winner],
            },
          ],
          metabolites: [],
          precursors: [],
        },
        userId,
      ),
    );

    await mergeCitations(db, winner, loser);

    const [model] = await revisionsFor(drugId, 'modelStructure');
    expect(
      (model!.newValue as { declarations: Array<{ citationId: number }> })
        .declarations[0]!.citationId,
    ).toBe(winner);
    const [metabolism] = await revisionsFor(drugId, 'metabolism');
    // The list named both papers: the survivor stays, once.
    expect(
      (metabolism!.newValue as { routes: Array<{ referenceIds: number[] }> })
        .routes[0]!.referenceIds,
    ).toEqual([winner]);
    expect(JSON.stringify(metabolism!.oldValue)).not.toContain(String(loser));

    // A recompute with nothing else changed finds the history in step with the
    // live block, so it records nothing.
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    expect(await revisionsFor(drugId, 'modelStructure')).toHaveLength(1);
  });

  // Codex review on #303: the profile's own citations are part of the box, so
  // an edit that only changes them must still be recorded.
  it('records a metabolism edit that changes only the profile citations', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const write = (referenceIds: number[]) =>
      runInPoolTransaction(() =>
        recordedMetabolismWrite(
          drugId,
          { ...metabolismInput(0.5), profile: { evidenceNote: 'Notat.', referenceIds } },
          userId,
        ),
      );
    await write([]);
    await write([citationId]);

    const revisions = await revisionsFor(drugId, 'metabolism');
    expect(revisions).toHaveLength(2);
    expect((revisions[1]!.oldValue as { referenceIds: number[] }).referenceIds).toEqual([]);
    expect((revisions[1]!.newValue as { referenceIds: number[] }).referenceIds).toEqual([
      citationId,
    ]);
    const [profile] = await db
      .select({ referenceIds: drugMetabolismProfiles.referenceIds })
      .from(drugMetabolismProfiles)
      .where(eq(drugMetabolismProfiles.drugId, drugId));
    expect(profile!.referenceIds).toEqual([citationId]);
  });

  // Codex review on #303: the model-structure section also curates the
  // per-route ka values, which have no aggregate revision of their own.
  // #12 lets an absorption declaration carry a formulation/population scope;
  // a change to it alone is a change to the block.
  it('records a change to an absorption declaration\'s formulation scope', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const entry = await insertParameterEntry(
      {
        drugId,
        citationId,
        parameter: 'absorptionModel',
        categoricalValue: 'first-order',
        route: 'oral',
        unit: '',
      } as ParameterEntryInput,
      userId,
    );
    await recomputeInTransaction(drugId, 'absorptionModel', userId);
    await db
      .update(parameterEntries)
      .set({ releaseProfile: 'modified' } as never)
      .where(eq(parameterEntries.id, entry.id));
    await recomputeInTransaction(drugId, 'absorptionModel', userId);

    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(2);
    const decl = (v: unknown) =>
      (v as { declarations: Array<{ releaseProfile: string | null }> }).declarations[0]!;
    expect(decl(revisions[1]!.oldValue).releaseProfile).toBeNull();
    expect(decl(revisions[1]!.newValue).releaseProfile).toBe('modified');
  });

  it.each([
    ['ka', '1/h'], ['firstOrderFraction', 'fraction'], ['zeroOrderDuration', 'h'], ['absorptionLag', 'h'],
  ])('records %s creation, edits and deletion in model-structure history', async (parameter, unit) => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const [entry] = await db.insert(parameterEntries).values({
      drugId,
      citationId,
      parameter: parameter!,
      route: 'oral',
      median: '0.2',
      unit: unit!,
      origin: 'contributor',
    }).returning({ id: parameterEntries.id });
    await recomputeInTransaction(drugId, parameter!, userId);

    const [revision] = await revisionsFor(drugId, 'modelStructure');
    const { routeValues } = revision!.newValue as {
      routeValues: Array<{ parameter: string; route: string; median: string; citationId: number }>;
    };
    expect(routeValues).toHaveLength(1);
    expect(routeValues[0]).toMatchObject({ parameter, route: 'oral', citationId });
    expect(Number(routeValues[0]!.median)).toBe(0.2);
    await db.update(parameterEntries).set({ median: '0.4' }).where(eq(parameterEntries.id, entry!.id));
    await recomputeInTransaction(drugId, parameter!, userId);
    await deleteParameterEntryRow(entry!.id);
    await recomputeInTransaction(drugId, parameter!, userId);
    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(3);
    expect(revisions[1]!.oldValue).toEqual(revisions[0]!.newValue);
    expect(revisions[2]!.oldValue).toEqual(revisions[1]!.newValue);
    expect(revisions[2]!.newValue).toMatchObject({ routeValues: [] });
  });


  it('records ka centre-only, statistic-only and interval-only changes', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const [entry] = await db.insert(parameterEntries).values({
      drugId, citationId, parameter: 'ka', route: 'oral', unit: '1/h',
      centralValue: '1.2', centralStatistic: 'arithmetic_mean', intervalKind: 'range',
      low: '0.8', high: '1.6', origin: 'contributor',
    }).returning({ id: parameterEntries.id });
    const change = async (patch: Partial<typeof parameterEntries.$inferInsert>) => {
      await runInPoolTransaction(async () => {
        await getDb().update(parameterEntries).set(patch).where(eq(parameterEntries.id, entry!.id));
        await recomputeParameterAndDependents(drugId, 'ka', userId);
      });
    };
    await recomputeInTransaction(drugId, 'ka', userId);
    await change({ centralValue: '1.4' });
    await change({ centralStatistic: 'geometric_mean' });
    await change({ intervalKind: 'ci95' });
    await change({ intervalKind: 'ci95' }); // unchanged save creates nothing
    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(4);
    const values = revisions.map((r) =>
      (r.newValue as { routeValues: Array<Record<string, unknown>> }).routeValues[0]!,
    );
    expect(Number(values[0]!.centralValue)).toBe(1.2);
    expect(Number(values[1]!.centralValue)).toBe(1.4);
    expect(values[2]!.centralStatistic).toBe('geometric_mean');
    expect(values[3]!.intervalKind).toBe('ci95');
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]!.oldValue).toEqual(revisions[i - 1]!.newValue);
    }
  });


  it.each([
    ['dispositionModel', 'two-compartment', null],
    ['eliminationModel', 'first-order', null],
    ['absorptionModel', 'first-order', 'oral'],
    ['ka', null, 'oral'],
  ] as const)('records a quote-only %s enrichment, attributed to the actor', async (parameter, categoricalValue, route) => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const [entry] = await db.insert(parameterEntries).values({
      drugId, citationId, parameter: parameter!, categoricalValue, route,
      unit: parameter === 'ka' ? '1/h' : '',
      median: parameter === 'ka' ? '1.2' : null,
    }).returning({ id: parameterEntries.id });
    await recomputeInTransaction(drugId, parameter, userId);
    await expect(attachSourceQuoteIfMissing(entry!.id, 'Kildens ordlyd.', undefined, userId))
      .resolves.toMatchObject({ attached: true });
    await expect(attachSourceQuoteIfMissing(entry!.id, 'En annen ordlyd.', undefined, userId))
      .resolves.toMatchObject({ attached: false });
    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(2);
    expect(revisions[1]!.createdBy).toBe(userId);
    expect(revisions[1]!.oldValue).toEqual(revisions[0]!.newValue);
    const snapshot = revisions[1]!.newValue as {
      declarations: Array<{ sourceQuote: string }>;
      routeValues: Array<{ sourceQuote: string }>;
    };
    expect([...snapshot.declarations, ...snapshot.routeValues][0]!.sourceQuote).toBe('Kildens ordlyd.');
  });

  it('rolls a quote-only block change back if its revision fails', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const [entry] = await db.insert(parameterEntries).values({
      drugId, citationId, parameter: 'ka', route: 'oral', median: '1.2', unit: '1/h',
    }).returning({ id: parameterEntries.id });
    await failBlockRevisionInserts(async () => {
      await expect(attachSourceQuoteIfMissing(entry!.id, 'Kildens ordlyd.', undefined, userId))
        .rejects.toThrow();
    });
    const [row] = await db.select().from(parameterEntries).where(eq(parameterEntries.id, entry!.id));
    expect(row!.sourceQuote).toBeNull();
    expect(await revisionsFor(drugId, 'modelStructure')).toEqual([]);
  });


  it.each(['dispositionModel', 'eliminationModel', 'absorptionModel'] as const)(
    'records evidence-context-only changes to %s declarations', async (parameter) => {
      const drugId = await seedDrug(db);
      const userId = await seedUser(db);
      const citationId = await seedAdmissibleCitation(db);
      const [entry] = await db.insert(parameterEntries).values({
        drugId, citationId, parameter, unit: '',
        categoricalValue: parameter === 'dispositionModel' ? 'two-compartment' : 'first-order',
      }).returning({ id: parameterEntries.id });
      await recomputeInTransaction(drugId, parameter, userId);
      for (const patch of [
        { observationContext: 'Friske voksne, fastende.' },
        { n: 12 },
        { comments: 'Vurdert mot kildens figur.' },
        { comments: 'Vurdert mot kildens figur.' }, // identical save
      ]) {
        await runInPoolTransaction(async () => {
          await getDb().update(parameterEntries).set(patch).where(eq(parameterEntries.id, entry!.id));
          await recomputeParameterAndDependents(drugId, parameter, userId);
        });
      }
      const revisions = await revisionsFor(drugId, 'modelStructure');
      expect(revisions).toHaveLength(4);
      for (let i = 1; i < revisions.length; i++) {
        expect(revisions[i]!.oldValue).toEqual(revisions[i - 1]!.newValue);
      }
      expect((revisions[3]!.newValue as { declarations: unknown[] }).declarations[0]).toMatchObject({
        observationContext: 'Friske voksne, fastende.', n: 12, comments: 'Vurdert mot kildens figur.',
      });
    },
  );

  // Codex review on #303: a citation held only by a block's history is still
  // cited content — the bibliography, a direct lookup and "cited in" must all
  // find it, as they do for a parameter revision's citations.
  it('counts a citation held only in block history as used', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const citationId = await seedAdmissibleCitation(db);
    const entry = await insertParameterEntry(
      {
        drugId,
        citationId,
        parameter: 'dispositionModel',
        categoricalValue: 'two-compartment',
        unit: '',
      } as ParameterEntryInput,
      userId,
    );
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    await deleteParameterEntryRow(entry.id);
    await recomputeInTransaction(drugId, 'dispositionModel', userId);
    // Remove the paper review too, so the history is the only anchor left.
    await db.execute(sql`DELETE FROM paper_reviews WHERE citation_id = ${citationId}`);

    expect(await collectUsedCitationIdsForDrug(getDb(), drugId)).toContain(citationId);
    expect(await filterUsedCitationIds(getDb(), [citationId])).toEqual(new Set([citationId]));
    const usage = await collectReferenceUsage(getDb(), citationId);
    expect(usage.some((u) => u.kind === 'drug' && u.id === drugId)).toBe(true);
  });

  // Metabolism is a graph: a precursor link written on one drug is a
  // metabolite on the other drug's box, so both boxes are recorded.
  it("records the linked drug's box when a write adds a link to it", async () => {
    const userId = await seedUser(db);
    const parentId = await seedDrug(db, { slug: 'forelder', names: { nb: 'Forelder' } });
    const childId = await seedDrug(db, { slug: 'barn', names: { nb: 'Barn' } });
    await runInPoolTransaction(() =>
      recordedMetabolismWrite(
        childId,
        {
          profile: {},
          routes: [],
          metabolites: [],
          precursors: [{ precursorDrugId: parentId, activity: 'active' as const }],
        },
        userId,
      ),
    );

    const [child] = await revisionsFor(childId, 'metabolism');
    expect((child!.newValue as { precursors: unknown[] }).precursors).toHaveLength(1);
    const [parent] = await revisionsFor(parentId, 'metabolism');
    expect(parent!.createdBy).toBe(userId);
    expect((parent!.oldValue as { metabolites: unknown[] }).metabolites).toEqual([]);
    expect((parent!.newValue as { metabolites: unknown[] }).metabolites).toHaveLength(1);
  });

  // Codex review on #303: the profile's citations are part of the public
  // metabolism model too, including a box that has sources and no note.
  it('exposes the profile citations on the metabolism read model, even without a note', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    await runInPoolTransaction(() =>
      recordedMetabolismWrite(
        drugId,
        { profile: { referenceIds: [citationId] }, routes: [], metabolites: [], precursors: [] },
        userId,
      ),
    );
    const metabolism = await getDrugMetabolism(getDb(), drugId);
    expect(metabolism).not.toBeNull();
    expect(metabolism!.evidenceNote).toBeNull();
    expect(metabolism!.referenceIds).toEqual([citationId]);
  });

  // Codex review on #303: a block write and its revision rows commit together.
  // A history insert that fails takes the write down with it.
  it('rolls the block write back when its revision cannot be recorded', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await failBlockRevisionInserts(async () => {
      await expect(
        recordedMetabolismWrite(drugId, metabolismInput(0.6), userId),
      ).rejects.toThrow();
    });
    expect(await getDrugMetabolism(getDb(), drugId)).toBeNull();
    expect(await revisionsFor(drugId, 'metabolism')).toEqual([]);
  });

  it('rolls the revision back when the write fails after it', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await expect(
      runInPoolTransaction(async () => {
        await recordedMetabolismWrite(drugId, metabolismInput(0.6), userId);
        throw new Error('later failure in the same unit of work');
      }),
    ).rejects.toThrow('later failure');
    expect(await getDrugMetabolism(getDb(), drugId)).toBeNull();
    expect(await revisionsFor(drugId, 'metabolism')).toEqual([]);
  });

  it('refuses to bracket writes outside a transaction', async () => {
    await expect(beginBlockHistory({ drugIds: [1], actorUserId: null })).rejects.toThrow(
      /inside a transaction/,
    );
  });

  it('serves a block history from the history endpoint, and refuses an unknown block', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db, { displayName: 'Kari' });
    await runInPoolTransaction(() =>
      recordedMetabolismWrite(drugId, metabolismInput(0.5), userId),
    );

    const call = async (query: string) => {
      const state = { statusCode: 0, body: '' };
      const res = {
        headersSent: false,
        writeHead: vi.fn((statusCode: number) => {
          state.statusCode = statusCode;
          return res;
        }),
        setHeader: vi.fn(),
        end: vi.fn((body?: string) => {
          state.body = body ?? '';
          return res;
        }),
      } as unknown as ServerResponse;
      await handler(
        {
          method: 'GET',
          url: `/api/drug-parameter-history?${query}`,
          headers: { host: 'localhost' },
        } as IncomingMessage,
        res,
      );
      return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
    };

    const ok = await call(`drugId=${drugId}&block=metabolism`);
    expect(ok.status).toBe(200);
    expect(ok.body.revisions).toHaveLength(1);
    expect(ok.body.revisions[0].author).toMatchObject({ id: userId, displayName: 'Kari' });
    expect(ok.body.revisions[0].author.email).toBeUndefined();
    expect(ok.body.revisions[0].editSummary).toBeNull();
    expect(ok.body.revisions[0].reviewDecision).toBeUndefined();
    expect(ok.body.revisions[0].verifications).toBeUndefined();

    const other = await call(`drugId=${drugId}&block=pharmacodynamics`);
    expect(other.body.revisions).toEqual([]);

    expect((await call(`drugId=${drugId}&block=halfLife`)).status).toBe(400);
  });
});
