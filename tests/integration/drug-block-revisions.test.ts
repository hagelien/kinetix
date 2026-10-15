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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import { drugBlockRevisions } from '../../db/schema.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import { replaceDrugMetabolism } from '../../api/_lib/metabolismStore.js';
import { replaceDrugReceptorTargets } from '../../api/_lib/receptorTargetStore.js';
import {
  deleteParameterEntryRow,
  insertParameterEntry,
  recomputeParameterAndDependents,
} from '../../api/_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../../src/lib/parameterEntries.js';
import handler from '../../api/drug-parameter-history.js';
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

function metabolismInput(fraction: number) {
  return {
    profile: { evidenceNote: 'Hovedsakelig nyreutskillelse.' },
    routes: [{ kind: 'renal_unchanged' as const, fraction: { median: fraction } }],
    metabolites: [],
    precursors: [],
  };
}

describe('drug block revisions', () => {
  it('records the metabolism box before and after each change, and skips an identical re-save', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db);
    const write = (fraction: number) =>
      runInPoolTransaction(() =>
        replaceDrugMetabolism(getDb(), drugId, metabolismInput(fraction), userId),
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
      replaceDrugReceptorTargets(
        getDb(),
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
    await recomputeParameterAndDependents(drugId, 'dispositionModel', userId);
    // A recompute with nothing changed (e.g. a cascade) records nothing.
    await recomputeParameterAndDependents(drugId, 'dispositionModel', userId);
    await deleteParameterEntryRow(first.id);
    await recomputeParameterAndDependents(drugId, 'dispositionModel', userId);

    const revisions = await revisionsFor(drugId, 'modelStructure');
    expect(revisions).toHaveLength(2);
    // Declarations are observed after the write, so the first recorded change
    // says its "before" was not recorded rather than claiming an empty block.
    expect(revisions[0]!.oldValue).toBeNull();
    expect(revisions[0]!.newValue).toEqual({
      declarations: [
        {
          parameter: 'dispositionModel',
          categoricalValue: 'two-compartment',
          route: null,
          citationId,
          sourceQuote: null,
        },
      ],
    });
    expect(revisions[1]!.oldValue).toEqual(revisions[0]!.newValue);
    expect(revisions[1]!.newValue).toEqual({ declarations: [] });
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
      await recomputeParameterAndDependents(drugId, parameter as never, userId);
    };
    await declare(winnerId, 'dispositionModel', 'two-compartment');
    await declare(loserId, 'eliminationModel', 'first-order');
    await runInPoolTransaction(() =>
      replaceDrugMetabolism(getDb(), loserId, metabolismInput(0.4), userId),
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
    await recomputeParameterAndDependents(drugId, 'dispositionModel', userId);
    await runInPoolTransaction(() =>
      replaceDrugMetabolism(
        getDb(),
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
    await recomputeParameterAndDependents(drugId, 'dispositionModel', userId);
    expect(await revisionsFor(drugId, 'modelStructure')).toHaveLength(1);
  });

  it('serves a block history from the history endpoint, and refuses an unknown block', async () => {
    const drugId = await seedDrug(db);
    const userId = await seedUser(db, { displayName: 'Kari' });
    await runInPoolTransaction(() =>
      replaceDrugMetabolism(getDb(), drugId, metabolismInput(0.5), userId),
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

    const other = await call(`drugId=${drugId}&block=pharmacodynamics`);
    expect(other.body.revisions).toEqual([]);

    expect((await call(`drugId=${drugId}&block=halfLife`)).status).toBe(400);
  });
});
