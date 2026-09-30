/**
 * Baseline hydration in the peer-verification queue, against real SQL.
 *
 * `agent-verifications-queue-target-id.test.ts` covers the by-id lookup
 * itself. This file covers what that lookup HANDS BACK for the two shapes the
 * escalation queue routes to the flagship tier and the batch mapper used to
 * get wrong: a legacy revision whose only citation is in the singular
 * `reference_id`, and a `param_entry` update or delete, whose `targetId` is
 * an entry id and whose proposedValue names only the operation. Both live in
 * the per-type SQL and mapper, which the mocked unit suite never executes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import {
  agents,
  citations,
  drugParameterRevisions,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import handler from '../../api/agent-verifications-queue.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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
});

function createResponse() {
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

async function callQueue(
  callerUserId: number,
  query: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  getUserFromRequestMock.mockResolvedValue({
    userId: callerUserId,
    role: 'contributor',
  });
  const req = {
    method: 'GET',
    url: `/api/agent-verifications-queue?minAgeMinutes=0&${query}`,
    headers: { host: 'localhost' },
  } as IncomingMessage;
  const { res, state } = createResponse();
  await handler(req, res);
  return { statusCode: state.statusCode, body: JSON.parse(state.body) };
}

const ENTRY_BACKED_PARAM = 'therapeuticConcentration';
const OTHER_ENTRY_BACKED_PARAM = 'halfLife';

describe('agent verification queue — hydration by targetId', () => {
  it('hydrates a legacy revision\'s singular reference_id beside an empty array', async () => {
    const authorId = await seedUser(db, {
      email: 'byid-legacy-author@example.com',
      username: 'byid-legacy-author',
    });
    const callerId = await seedUser(db, {
      email: 'byid-legacy@example.com',
      username: 'byid-legacy',
      role: 'contributor',
    });
    await db
      .insert(agents)
      .values({
        userId: callerId,
        name: 'byid-legacy-agent',
        slug: 'byid-legacy-agent',
        status: 'active',
      });
    const drugId = await seedDrug(db, { slug: 'byid-legacy-drug' });
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/byid-legacy' })
      .returning({ id: citations.id });

    // The escalation feed sends T2 here precisely BECAUSE of this citation,
    // so hydration dropping it would hide the source under inspection.
    const [legacy] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter: ENTRY_BACKED_PARAM,
        oldValue: null,
        newValue: { low: 1, high: 2 },
        referenceId: citation!.id,
        referenceIds: [],
        createdBy: authorId,
      })
      .returning({ id: drugParameterRevisions.id });

    const { body } = await callQueue(
      callerId,
      `targetType=drug_parameter_revision&targetId=${legacy!.id}`,
    );
    const items = body.items as Array<{ payload: Record<string, unknown> }>;
    expect(items[0]!.payload.referenceIds).toEqual([citation!.id]);
  });

  it('hydrates the entry and drug behind a param_entry delete', async () => {
    const authorId = await seedUser(db, {
      email: 'byid-entry-author@example.com',
      username: 'byid-entry-author',
    });
    const callerId = await seedUser(db, {
      email: 'byid-entry@example.com',
      username: 'byid-entry',
      role: 'contributor',
    });
    await db
      .insert(agents)
      .values({
        userId: callerId,
        name: 'byid-entry-agent',
        slug: 'byid-entry-agent',
        status: 'active',
      });
    const drugId = await seedDrug(db, {
      slug: 'byid-entry-drug',
      names: { nb: 'Slettemiddel', en: 'Delete drug' },
    });
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: ENTRY_BACKED_PARAM,
        low: '1',
        high: '2',
        unit: 'mg/L',
      })
      .returning({ id: parameterEntries.id });

    // A delete proposal's payload is just `{op: 'delete'}` and its targetId is
    // the ENTRY id, so without hydration the verifier is handed a bare number.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: ENTRY_BACKED_PARAM,
        proposedValue: { op: 'delete' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    const { body } = await callQueue(
      callerId,
      `targetType=pending_edit&targetId=${edit!.id}`,
    );
    const items = body.items as Array<{ payload: Record<string, unknown> }>;
    expect(items).toHaveLength(1);
    const payload = items[0]!.payload;
    expect(payload.drugName).toBe('Slettemiddel');
    expect(payload.currentEntry).toMatchObject({
      id: entry!.id,
      drugId,
      parameter: ENTRY_BACKED_PARAM,
    });
  });

  it('leaves drug context unresolved when the named entry is gone', async () => {
    const authorId = await seedUser(db, {
      email: 'byid-gone-author@example.com',
      username: 'byid-gone-author',
    });
    const callerId = await seedUser(db, {
      email: 'byid-gone@example.com',
      username: 'byid-gone',
      role: 'contributor',
    });
    await db
      .insert(agents)
      .values({
        userId: callerId,
        name: 'byid-gone-agent',
        slug: 'byid-gone-agent',
        status: 'active',
      });
    const drugId = await seedDrug(db, {
      slug: 'byid-gone-drug',
      names: { nb: 'Urelatert middel', en: 'Unrelated drug' },
    });
    // An entry id that is also a live drug id, then removed — the shape a
    // direct delete leaves behind while the proposal stays pending.
    await db.insert(parameterEntries).values({
      id: drugId,
      drugId,
      parameter: ENTRY_BACKED_PARAM,
      low: '1',
      high: '2',
      unit: 'mg/L',
    });
    const [orphan] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: drugId,
        parameter: ENTRY_BACKED_PARAM,
        proposedValue: { op: 'update', low: 3 },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // A plain parameter edit on that same drug, so the drug IS in the batch's
    // lookup — which is what lets a targetId misread as a drug id resolve to
    // a real, wrong baseline rather than simply to nothing.
    await db.insert(pendingEdits).values({
      editType: 'parameter',
      targetId: drugId,
      parameter: ENTRY_BACKED_PARAM,
      proposedValue: { median: 5 },
      submittedBy: authorId,
      status: 'pending',
    });
    await db.delete(parameterEntries).where(eq(parameterEntries.id, drugId));

    const { body } = await callQueue(callerId, 'targetType=pending_edit');
    const items = body.items as Array<{
      targetId: number;
      payload: Record<string, unknown>;
    }>;
    const item = items.find((i) => i.targetId === orphan!.id)!;
    // No entry, and no guess at one: reading the entry id as a drug id would
    // have named 'Urelatert middel' here.
    expect(item.payload.currentEntry).toBeUndefined();
    expect(item.payload.drugName).toBeUndefined();
    expect(item.payload.currentValue).toBeUndefined();
  });

  it('does not hand a param_entry create the entry whose id equals its drug id', async () => {
    const authorId = await seedUser(db, {
      email: 'byid-collide-author@example.com',
      username: 'byid-collide-author',
    });
    const callerId = await seedUser(db, {
      email: 'byid-collide@example.com',
      username: 'byid-collide',
      role: 'contributor',
    });
    await db
      .insert(agents)
      .values({
        userId: callerId,
        name: 'byid-collide-agent',
        slug: 'byid-collide-agent',
        status: 'active',
      });

    // `drugs.id` and `parameter_entries.id` are independent serial spaces, so
    // a create naming drug N and an update naming entry N can coexist. Force
    // the collision by giving the entry the create's drug id.
    const createDrugId = await seedDrug(db, {
      slug: 'byid-collide-drug',
      names: { nb: 'Riktig middel', en: 'Right drug' },
    });
    const otherDrugId = await seedDrug(db, {
      slug: 'byid-collide-other',
      names: { nb: 'Feil middel', en: 'Wrong drug' },
    });
    await db.insert(parameterEntries).values({
      id: createDrugId,
      drugId: otherDrugId,
      parameter: OTHER_ENTRY_BACKED_PARAM,
      low: '9',
      high: '10',
      unit: 'h',
    });

    const [createEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: createDrugId,
        parameter: ENTRY_BACKED_PARAM,
        proposedValue: { op: 'create', low: 1, high: 2, unit: 'mg/L' },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    const [updateEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: createDrugId,
        parameter: OTHER_ENTRY_BACKED_PARAM,
        proposedValue: { op: 'update', low: 3 },
        submittedBy: authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    // One ordinary batch, so both edits are mapped together — which is what
    // makes the shared entry lookup able to cross-contaminate them.
    const { body } = await callQueue(callerId, 'targetType=pending_edit');
    const items = body.items as Array<{
      targetId: number;
      payload: Record<string, unknown>;
    }>;
    const created = items.find((i) => i.targetId === createEdit!.id)!;
    const updated = items.find((i) => i.targetId === updateEdit!.id)!;

    // The create names a drug, not that entry.
    expect(created.payload.currentEntry).toBeUndefined();
    expect(created.payload.drugName).toBe('Riktig middel');
    // The update really is against that entry, on the other drug.
    expect(updated.payload.currentEntry).toMatchObject({
      id: createDrugId,
      drugId: otherDrugId,
    });
    expect(updated.payload.drugName).toBe('Feil middel');
  });

});
