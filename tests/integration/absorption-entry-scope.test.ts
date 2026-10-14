/**
 * #12 — formulation and population on the absorption parameters, against a
 * migrated schema (owner decision of 2026-10-07: reuse the dose-context
 * columns).
 *
 *  - migration 0153's CHECK lets tmax / ka / bioavailability / absorptionModel
 *    carry the scope columns and nothing else of the dose context, and keeps
 *    refusing them on every other parameter;
 *  - POST/PATCH /api/parameter-entries accept the scope where it belongs and
 *    refuse it elsewhere; an update that says nothing about a stored scope is
 *    refused rather than erasing it, directly and at approval;
 *  - the pooled summaries never mix two formulations.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import parameterEntriesHandler from '../../api/parameter-entries.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import {
  getParameterSummariesWithRoutes,
  listEntriesForDrug,
} from '../../api/_lib/parameter-entries-store.js';
import { drugParameters, parameterEntries, pendingEdits } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
  drugId = await seedDrug(db, { slug: 'oksymorfon' });
});

async function insertFails(values: Record<string, unknown>): Promise<string | null> {
  try {
    await db.insert(parameterEntries).values(values as never);
    return null;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe('23514');
    return cause?.constraint ?? 'unknown';
  }
}

const SCOPE = {
  releaseProfile: 'modified',
  physicalForm: 'suspension',
  doseRegimen: 'multiple',
  doseIntervalHours: '168',
  pkPopulation: 'patients_unspecified',
  populationQualifier: 'opioid use disorder',
};

describe('migration 0153 — the scope CHECK', () => {
  it.each([
    ['tmax', { unit: 'h', low: '1', high: '2' }],
    ['ka', { unit: '1/h', low: '0.1', high: '0.3', route: 'oral' }],
    ['bioavailability', { unit: 'fraction', low: '0.2', high: '0.4', route: 'sublingual' }],
    ['absorptionModel', { unit: '', categoricalValue: 'zero-order', route: 'im' }],
  ] as const)('stores %s with its formulation and population', async (parameter, reading) => {
    expect(await insertFails({ drugId, parameter, ...reading, ...SCOPE })).toBeNull();
  });

  it.each([
    ['halfLife', { unit: 'h', low: '1', high: '2' }],
    ['volumeOfDistribution', { unit: 'L/kg', low: '1', high: '2' }],
    ['proteinBinding', { unit: 'fraction', low: '0.1', high: '0.2' }],
  ] as const)('still refuses the scope on %s', async (parameter, reading) => {
    for (const [key, value] of Object.entries(SCOPE)) {
      const values: Record<string, unknown> = { drugId, parameter, ...reading, [key]: value };
      if (key === 'populationQualifier') values.pkPopulation = 'patients_unspecified';
      expect(await insertFails(values), key).toBe('parameter_entries_dose_context_forbidden');
    }
  });

  it.each([
    ['a dose', { doseValue: '2', doseUnit: 'mg' }],
    ['a value basis', { valueBasis: 'concentration' }],
    ['an administered drug', { administeredDrugId: 'self' }],
    ['a prandial state', { prandialState: 'fed' }],
    ['an infusion', { ivInputMode: 'bolus' }],
    ['a dose number', { doseRegimen: 'multiple', doseNumber: 3 }],
  ] as const)('refuses the rest of the dose context on tmax: %s', async (_label, over) => {
    const values: Record<string, unknown> = { drugId, parameter: 'tmax', unit: 'h', low: '1', high: '2', ...over };
    if (values.administeredDrugId === 'self') values.administeredDrugId = drugId;
    expect(await insertFails(values)).toBe('parameter_entries_dose_context_forbidden');
  });

  it('holds the scope to 0129’s dependency rules on tmax too', async () => {
    const tmax = { drugId, parameter: 'tmax', unit: 'h', low: '1', high: '2' };
    expect(await insertFails({ ...tmax, doseRegimen: 'single', doseIntervalHours: '12' })).toBe(
      'parameter_entries_dose_context_dependencies',
    );
    expect(await insertFails({ ...tmax, populationQualifier: 'CYP2D6 PM' })).toBe(
      'parameter_entries_dose_context_dependencies',
    );
    expect(await insertFails({ ...tmax, releaseProfile: 'extended' })).toBe(
      'parameter_entries_dose_context_vocabulary',
    );
  });
});

function createResponse() {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

async function call(method: 'POST' | 'PATCH', url: string, body: unknown, userId: number, role: string) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' };
  authMock.mockResolvedValue({ userId, role });
  const { res, state } = createResponse();
  await parameterEntriesHandler(req, res);
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null };
}

describe('POST/PATCH /api/parameter-entries — the scope on the write path', () => {
  let citationId: number;
  let admin: number;
  beforeEach(async () => {
    citationId = await seedAdmissibleCitation(db);
    admin = await seedUser(db, { role: 'admin' });
  });

  it('stores a tmax with its formulation and population', async () => {
    const res = await call(
      'POST',
      '/api/parameter-entries',
      {
        drugId,
        parameter: 'tmax',
        citationId,
        unit: 'h',
        low: 4,
        high: 12,
        route: 'oral',
        releaseProfile: 'modified',
        physicalForm: 'tablet_capsule',
        pkPopulation: 'healthy_adult',
      },
      admin,
      'admin',
    );
    expect(res.status).toBe(201);
    const [entry] = await listEntriesForDrug(drugId, 'tmax');
    expect(entry!.doseContext).toMatchObject({
      releaseProfile: 'modified',
      physicalForm: 'tablet_capsule',
      pkPopulation: 'healthy_adult',
      doseIntervalHours: null,
    });
  });

  it.each([
    ['a scope field on a half-life', { parameter: 'halfLife', releaseProfile: 'modified' }, /takes no dose context/],
    ['a dose on a tmax', { doseValue: 2, doseUnit: 'mg' }, /takes only formulation and population/],
    ['an interval on a single-dose tmax', { doseRegimen: 'single', doseIntervalHours: 12 }, /single dose/],
  ] as const)('refuses %s', async (_label, over, message) => {
    const res = await call(
      'POST',
      '/api/parameter-entries',
      { drugId, parameter: 'tmax', citationId, unit: 'h', low: 1, high: 2, ...over },
      admin,
      'admin',
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'param_entry_invalid_for_parameter' });
    expect(res.body.error).toMatch(message);
    expect(await db.select().from(parameterEntries)).toEqual([]);
  });

  async function taggedTmax(): Promise<number> {
    const [row] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'tmax',
        citationId,
        unit: 'h',
        low: '4',
        high: '12',
        releaseProfile: 'modified',
        doseRegimen: 'multiple',
        doseIntervalHours: '168',
        createdBy: admin,
      } as never)
      .returning({ id: parameterEntries.id });
    return row!.id;
  }

  it('refuses an update that says nothing about a stored scope, leaving the row as it was', async () => {
    const id = await taggedTmax();
    const res = await call('PATCH', `/api/parameter-entries?id=${id}`, { citationId, unit: 'h', low: 5, high: 12 }, admin, 'admin');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'param_entry_scope_omitted' });
    const [row] = await db.select().from(parameterEntries).where(eq(parameterEntries.id, id));
    expect(row!.releaseProfile).toBe('modified');
    expect(Number(row!.low)).toBe(4);
  });

  it('applies an update that restates the scope — or clears it explicitly', async () => {
    const id = await taggedTmax();
    const restated = await call(
      'PATCH',
      `/api/parameter-entries?id=${id}`,
      { citationId, unit: 'h', low: 5, high: 12, releaseProfile: 'modified', doseRegimen: 'multiple', doseIntervalHours: 168 },
      admin,
      'admin',
    );
    expect(restated.status).toBe(200);
    let [row] = await db.select().from(parameterEntries).where(eq(parameterEntries.id, id));
    expect(row).toMatchObject({ releaseProfile: 'modified', doseIntervalHours: '168.0000' });
    expect(Number(row!.low)).toBe(5);

    const cleared = await call(
      'PATCH',
      `/api/parameter-entries?id=${id}`,
      { citationId, unit: 'h', low: 5, high: 12, releaseProfile: null },
      admin,
      'admin',
    );
    expect(cleared.status).toBe(200);
    [row] = await db.select().from(parameterEntries).where(eq(parameterEntries.id, id));
    expect(row).toMatchObject({ releaseProfile: null, doseRegimen: null, doseIntervalHours: null });
  });

  it('refuses at approval a queued update that says nothing about the stored scope', async () => {
    const id = await taggedTmax();
    const submitter = await seedUser(db, { email: 'c@example.com', username: 'c' });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: id,
        parameter: 'tmax',
        referenceId: citationId,
        referenceIds: [citationId],
        proposedValue: { op: 'update', patch: { citationId, unit: 'h', low: 5, high: 12 } } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await expect(applyApprovedEdit(edit!.id, admin)).rejects.toMatchObject({
      code: 'param_entry_scope_omitted',
    });
    const [row] = await db.select().from(parameterEntries).where(eq(parameterEntries.id, id));
    expect(row!.releaseProfile).toBe('modified');
  });
});

describe('pooling never mixes formulations', () => {
  it('keeps an extended-release Tmax out of the drug-level value and pools a route by formulation', async () => {
    const citationId = await seedAdmissibleCitation(db);
    const admin = await seedUser(db, { role: 'admin' });
    const post = (body: Record<string, unknown>) =>
      call('POST', '/api/parameter-entries', { drugId, parameter: 'tmax', citationId, unit: 'h', ...body }, admin, 'admin');

    // Drug-level: two unlabelled immediate-release-era readings and an ER one.
    expect((await post({ low: 0.5, high: 1 })).status).toBe(201);
    expect((await post({ low: 1, high: 1.5 })).status).toBe(201);
    expect((await post({ low: 6, high: 10, releaseProfile: 'modified' })).status).toBe(201);
    // One route, two depots of different intervals.
    expect((await post({ route: 'im', low: 20, high: 30, releaseProfile: 'modified', doseIntervalHours: 168 })).status).toBe(201);
    expect((await post({ route: 'im', low: 90, high: 120, releaseProfile: 'modified', doseIntervalHours: 720 })).status).toBe(201);

    const { summaries, routeSummaries } = await getParameterSummariesWithRoutes(drugId);
    expect(summaries.tmax).toMatchObject({ pooledCount: 2, max: 1.5, formulationExcludedCount: 1 });
    expect(routeSummaries.tmax!.im).toMatchObject({ pooledCount: 0, representative: null, formulationExcludedCount: 2 });

    // The cached drug-level value is the same pool.
    const [cached] = await db
      .select({ value: drugParameters.value })
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect(cached!.value).toMatchObject({ max: 1.5, derivedFromEntries: true });
  });
});
