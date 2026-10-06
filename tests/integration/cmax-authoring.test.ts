/**
 * Authoring and approving Cmax (release C, #1341), against a migrated schema.
 *
 *  - POST /api/parameter-entries writes a Cmax entry directly or queues it,
 *    with the self-administered default and every RFC write rule enforced
 *    (each rule asserted as a rejection, not only the happy path);
 *  - an approval persists the complete shape without truncating it;
 *  - a proposal naming a drug that no longer exists is refused at approval,
 *    and a revision naming one is refused at PATCH.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
  requestHasAuthCookie: () => true,
}));

import parameterEntriesHandler from '../../api/parameter-entries.js';
import pendingEditsHandler from '../../api/pending-edits.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import { listEntriesForDrug } from '../../api/_lib/parameter-entries-store.js';
import { agents, parameterEntries, pendingEdits } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
});

/** A complete release-C Cmax input: a 2 mg single oral dose, mean ± SD. */
function cmaxInput(drugId: number, citationId: number, over: Record<string, unknown> = {}) {
  return {
    drugId,
    parameter: 'cmax',
    citationId,
    unit: 'ng/mL',
    matrix: 'plasma',
    route: 'oral',
    centralValue: 84,
    centralStatistic: 'arithmetic_mean',
    low: 70,
    high: 98,
    intervalKind: 'sd',
    n: 12,
    valueBasis: 'concentration',
    doseValue: 2,
    doseUnit: 'mg',
    doseBasis: 'salt',
    doseSaltForm: 'hydrochloride',
    doseRegimen: 'single',
    administeredDrugId: drugId,
    releaseProfile: 'immediate',
    physicalForm: 'tablet_capsule',
    prandialState: 'fasted',
    coadministrationState: 'monotherapy',
    pkPopulation: 'healthy_adult',
    ...over,
  };
}

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

async function post(body: unknown, userId: number, role: string) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/parameter-entries';
  req.headers = {
    host: 'localhost',
    origin: 'http://localhost',
    'content-type': 'application/json',
  };
  authMock.mockResolvedValue({ userId, role });
  const { res, state } = createResponse();
  await parameterEntriesHandler(req, res);
  return state;
}

async function queueCreate(input: Record<string, unknown>, submittedBy: number) {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: input.drugId as number,
      parameter: 'cmax',
      referenceId: input.citationId as number,
      referenceIds: [input.citationId as number],
      proposedValue: { op: 'create', input } as never,
      status: 'pending',
      submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

// Release C (#1341): Cmax is authorable through the generic entry API, on
// both its branches, with the self-administered default.
describe('authoring Cmax through POST /api/parameter-entries', () => {
  it('refuses an agent holding direct writes that sends no quote, before writing anything', async () => {
    // The direct-write branch would otherwise publish the unquoted value at
    // once: no consensus gate stands behind it.
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db, { role: 'admin', email: 'agent@example.com', username: 'agent' });
    await db.insert(agents).values({ userId, name: 'agent', slug: 'agent', status: 'active', modelTier: 'flagship' });

    const state = await post(cmaxInput(drugId, citationId), userId, 'admin');

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'source_quote_required' });
    expect(await db.select().from(parameterEntries)).toHaveLength(0);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });

  it('writes directly for an admin, defaulting the administered drug to the analyte', async () => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db, { role: 'admin' });
    const { administeredDrugId: _omitted, ...body } = cmaxInput(drugId, citationId);

    const state = await post(body, userId, 'admin');

    expect(state.statusCode).toBe(201);
    const [entry] = await listEntriesForDrug(drugId, 'cmax');
    expect(entry!.doseContext).toMatchObject({
      administeredDrugId: drugId,
      doseValue: 2,
      valueBasis: 'concentration',
      centralStatistic: 'arithmetic_mean',
    });
  });

  it('queues a proposal for a contributor, with the full context intact', async () => {
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const parent = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db, { role: 'contributor' });

    const state = await post(
      cmaxInput(metabolite, citationId, { administeredDrugId: parent }),
      userId,
      'contributor',
    );

    expect(state.statusCode).toBe(201);
    expect(JSON.parse(state.body).pending).toBe(true);
    const [edit] = await db.select().from(pendingEdits);
    const input = (edit!.proposedValue as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ administeredDrugId: parent, doseValue: 2, prandialState: 'fasted' });
    expect(await db.select().from(parameterEntries)).toEqual([]);
  });

  it.each([
    ['an explicit null administered drug', { administeredDrugId: null }, /administeredDrugId/],
    ['no value basis', { valueBasis: undefined }, /valueBasis/],
    ['a concentration with no dose', { doseValue: undefined }, /needs the dose/],
    ['an unlabelled central value', { centralStatistic: undefined }, /centralStatistic/],
    ['bounds with no interval kind', { intervalKind: undefined }, /intervalKind/],
    ['an exact dose beside a range', { doseLow: 1, doseHigh: 4 }, /either an exact/],
    ['a degenerate dose range', { doseValue: undefined, doseLow: 2, doseHigh: 2 }, /state it as doseValue/],
    ['a median contradicting the label', { centralValue: undefined, median: 84 }, /cannot label/],
    ['a censored value with a statistic', { qualifier: '<', low: undefined, high: undefined, intervalKind: undefined }, /censored/],
  ] as const)('rejects %s', async (_label, over, message) => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db, { role: 'admin' });

    const state = await post(cmaxInput(drugId, citationId, over), userId, 'admin');

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toMatch(message);
    expect(await db.select().from(parameterEntries)).toEqual([]);
  });

  it('canonicalizes a median shorthand on write', async () => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db, { role: 'admin' });

    const state = await post(
      cmaxInput(drugId, citationId, {
        centralValue: undefined,
        centralStatistic: undefined,
        intervalKind: 'range',
        median: 84,
      }),
      userId,
      'admin',
    );

    expect(state.statusCode).toBe(201);
    const [row] = await db
      .select({
        median: parameterEntries.median,
        centralValue: parameterEntries.centralValue,
        centralStatistic: parameterEntries.centralStatistic,
      })
      .from(parameterEntries);
    expect(row).toEqual({ median: null, centralValue: '84.000000', centralStatistic: 'median' });
  });
});

describe('approving a Cmax proposal', () => {
  it('persists the complete shape', async () => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, { role: 'admin', email: 'reviewer@example.com', username: 'reviewer' });
    const input = cmaxInput(drugId, citationId);
    const editId = await queueCreate(input, submitter);

    await applyApprovedEdit(editId, reviewer);

    const [entry] = await listEntriesForDrug(drugId, 'cmax');
    expect(entry).toMatchObject({ parameter: 'cmax', unit: 'ng/mL', low: 70, high: 98, n: 12 });
    const { drugId: _d, parameter: _p, citationId: _c, unit: _u, matrix: _m, route: _r, low: _l, high: _h, n: _n, ...doseContext } = input;
    expect(entry!.doseContext).toMatchObject(doseContext);
  });

  it('refuses a proposal whose administered drug has since been deleted', async () => {
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const parent = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, { role: 'admin', email: 'reviewer@example.com', username: 'reviewer' });
    const editId = await queueCreate(
      cmaxInput(metabolite, citationId, { administeredDrugId: parent }),
      submitter,
    );
    // Raw, to stage a proposal that predates the locking: the drug-delete
    // teardown refuses this case itself.
    await db.execute(sql`DELETE FROM drugs WHERE id = ${parent}`);

    await expect(applyApprovedEdit(editId, reviewer)).rejects.toMatchObject({
      code: 'param_entry_drug_missing',
    });
    expect(
      await db.select().from(parameterEntries).where(eq(parameterEntries.drugId, metabolite)),
    ).toEqual([]);
  });

  it('refuses an ill-formed Cmax proposal rather than storing it', async () => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const citationId = await seedAdmissibleCitation(db);
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, { role: 'admin', email: 'reviewer@example.com', username: 'reviewer' });
    const editId = await queueCreate(
      cmaxInput(drugId, citationId, { valueBasis: undefined }),
      submitter,
    );

    await expect(applyApprovedEdit(editId, reviewer)).rejects.toMatchObject({
      code: 'param_entry_invalid_payload',
    });
  });
});

// RFC owner review, amendment 2: revising a proposal is a payload write like
// authoring one, and goes through the same locks and re-reads. A submitter
// revision naming a drug that no longer exists is refused, not stored.
describe('revising a Cmax proposal through PATCH /api/pending-edits', () => {
  async function patch(id: number, body: unknown, userId: number) {
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    req.method = 'PATCH';
    req.url = `/api/pending-edits?id=${id}`;
    req.headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const { res, state } = createResponse();
    await pendingEditsHandler(req, res);
    return state;
  }

  it('refuses a revision whose administered drug has been deleted', async () => {
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const parent = await seedDrug(db, { slug: 'kokain' });
    const gone = await seedDrug(db, { slug: 'slettet' });
    const citationId = await seedAdmissibleCitation(db);
    const submitter = await seedUser(db);
    const input = cmaxInput(metabolite, citationId, { administeredDrugId: parent });
    const editId = await queueCreate(input, submitter);
    await db.execute(sql`DELETE FROM drugs WHERE id = ${gone}`);

    const state = await patch(
      editId,
      { proposedValue: { op: 'create', input: { ...input, administeredDrugId: gone } } },
      submitter,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('param_entry_drug_missing');
    const [edit] = await db
      .select({ value: pendingEdits.proposedValue })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect((edit!.value as { input: { administeredDrugId: number } }).input.administeredDrugId).toBe(
      parent,
    );
  });

  it('accepts a revision naming a live drug', async () => {
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const parent = await seedDrug(db, { slug: 'kokain' });
    const other = await seedDrug(db, { slug: 'heroin' });
    const citationId = await seedAdmissibleCitation(db);
    const submitter = await seedUser(db);
    const input = cmaxInput(metabolite, citationId, { administeredDrugId: parent });
    const editId = await queueCreate(input, submitter);

    const state = await patch(
      editId,
      { proposedValue: { op: 'create', input: { ...input, administeredDrugId: other } } },
      submitter,
    );

    expect(state.statusCode).toBe(200);
  });
});
