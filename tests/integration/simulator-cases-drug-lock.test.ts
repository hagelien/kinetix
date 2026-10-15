/**
 * Drug-existence validation on simulator case saves (issue #1076, item 4).
 *
 * A case's `case_data.drugs[].drugId` is arbitrary client-supplied data with
 * no FK behind it, so nothing stopped a save from pointing at a drug that a
 * concurrent merge/delete had already removed. `saveCaseWithMergeLock`
 * resolves every referenced drug, takes the per-drug advisory lock the merge
 * admin holds (`lockDrugForEntryApplicability`), and re-verifies existence
 * under that lock before writing — closing the same window a page or
 * pending-edit submission closes. These tests pin the outward behaviour: a
 * case naming a drug that doesn't exist is rejected (409) and never
 * persisted, while an ordinary case against a real drug saves normally.
 *
 * The resolve that picks which drugs to lock runs before the lock, so a
 * writer holding it (`retarget:cid`, a merge with `--adopt-cid`) can commit
 * in between: the drug still exists but the case's bare-CID key no longer
 * names it, and the writer's one rewrite of `simulator_cases` has run. PGlite
 * has one connection and cannot block, so that interleaving is simulated by
 * running the writer's change right after the save's lock is granted, on the
 * save's own transaction — the state the save would see had the writer
 * committed while it waited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { authMock, afterLock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  afterLock: { hook: null as null | (() => Promise<void>) },
}));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));
vi.mock('../../api/_lib/parameterApplicabilityStore.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/parameterApplicabilityStore.js')>();
  return {
    ...actual,
    // Real lock, then (once) whatever the test says a concurrent writer
    // committed while the save was queued on it.
    lockDrugForEntryApplicability: async (drugId: number) => {
      await actual.lockDrugForEntryApplicability(drugId);
      const hook = afterLock.hook;
      afterLock.hook = null;
      if (hook) await hook();
    },
  };
});

import { eq } from 'drizzle-orm';
import handler from '../../api/simulator/cases.js';
import { getDb } from '../../api/_lib/db.js';
import { drugs, simulatorCases } from '../../db/schema.js';
import { rewriteCaseKeysAndCid } from '../../scripts/lib/retarget-cid-apply.js';
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
  authMock.mockReset();
  afterLock.hook = null;
});

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
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

function postRequest(body: unknown): IncomingMessage {
  return jsonRequest('POST', '/api/simulator/cases', body);
}

function putRequest(id: number, body: unknown): IncomingMessage {
  return jsonRequest('PUT', `/api/simulator/cases?id=${id}`, body);
}

function jsonRequest(method: string, url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

describe('POST /api/simulator/cases — drug existence under the merge lock', () => {
  it('refuses a case referencing a drugId that does not exist, and saves nothing', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Spøkelsescase',
        caseData: { drugs: [{ drugId: '999999' }] },
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('case_drug_missing');
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(0);
  });

  it('saves a case whose referenced drug is real', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const drugId = await seedDrug(db, { slug: 'ekte-simulator-middel' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Ekte case',
        caseData: { drugs: [{ drugId: String(drugId) }] },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(1);
  });

  it('saves a case with no drug references at all (no lock needed)', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });

    const { res, state } = createResponse();
    await handler(
      postRequest({
        name: 'Case uten legemiddel',
        caseData: { notes: 'plain payload' },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(1);
  });
});

describe('case save re-resolves its drug refs under the lock', () => {
  it('refuses a bare-CID key whose CID retarget:cid moved while the save waited', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const drugId = await seedDrug(db, { slug: 'retarget-under-save', pubchemCid: 111 });
    afterLock.hook = () => rewriteCaseKeysAndCid(getDb(), drugId, ['111'], 222);

    const { res, state } = createResponse();
    await handler(
      postRequest({ name: 'Gammel CID', caseData: { drugs: [{ drugId: '111' }] } }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('case_drug_missing');
    expect(await db.select().from(simulatorCases)).toHaveLength(0);
    const [d] = await db.select().from(drugs).where(eq(drugs.id, drugId));
    expect(d!.pubchemCid).toBe(222);
  });

  it('does not overwrite the rewritten key on an update that raced the retarget', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const drugId = await seedDrug(db, { slug: 'retarget-under-update', pubchemCid: 111 });
    const [existing] = await db
      .insert(simulatorCases)
      .values({ name: 'case', createdBy: userId, caseData: { drugs: [{ drugId: '111' }] } })
      .returning();
    afterLock.hook = () => rewriteCaseKeysAndCid(getDb(), drugId, ['111'], 222);

    const { res, state } = createResponse();
    await handler(
      putRequest(existing!.id, { name: 'case', caseData: { drugs: [{ drugId: '111' }] } }),
      res,
    );

    expect(state.statusCode).toBe(409);
    const [row] = await db.select().from(simulatorCases);
    expect(row!.caseData).toEqual({ drugs: [{ drugId: '222' }] });
  });

  it("refuses a key naming a merge survivor's CID it gave up for --adopt-cid", async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const survivor = await seedDrug(db, { slug: 'survivor', pubchemCid: 500 });
    const loser = await seedDrug(db, { slug: 'loser', pubchemCid: 600 });
    afterLock.hook = async () => {
      const tx = getDb();
      await tx.delete(drugs).where(eq(drugs.id, loser));
      await tx.update(drugs).set({ pubchemCid: 600 }).where(eq(drugs.id, survivor));
    };

    const { res, state } = createResponse();
    await handler(
      postRequest({ name: 'Overlevende', caseData: { drugs: [{ drugId: '500' }] } }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('case_drug_missing');
    expect(await db.select().from(simulatorCases)).toHaveLength(0);
  });

  it('refuses a key that now resolves to a different drug than the one locked', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const first = await seedDrug(db, { slug: 'first-holder', pubchemCid: 111 });
    const second = await seedDrug(db, { slug: 'second-holder', pubchemCid: 333 });
    afterLock.hook = async () => {
      const tx = getDb();
      await tx.update(drugs).set({ pubchemCid: 999 }).where(eq(drugs.id, first));
      await tx.update(drugs).set({ pubchemCid: 111 }).where(eq(drugs.id, second));
    };

    const { res, state } = createResponse();
    await handler(
      postRequest({ name: 'Byttet', caseData: { drugs: [{ drugId: '111' }] } }),
      res,
    );

    expect(state.statusCode).toBe(409);
    const body = JSON.parse(state.body);
    expect(body.code).toBe('case_drug_changed');
    expect(body.error).toContain('drugId=111');
    expect(await db.select().from(simulatorCases)).toHaveLength(0);
  });
});

// Codex on #261: a client loaded before #1256 still sends a drug's bare id.
// Stored for a drug that has a CID, that key would resolve CID-first to the
// next drug taking the number, past the CID shadow check that only reads the
// cases. Under the lock the save keys such a drug by its CID instead.
describe('case save re-keys a bare internal id onto the drug\'s CID', () => {
  async function saveCase(drugIds: string[]) {
    const { res, state } = createResponse();
    await handler(
      postRequest({ name: 'Gammel klient', caseData: { drugs: drugIds.map((drugId) => ({ drugId })) } }),
      res,
    );
    return state;
  }

  async function storedKeys(): Promise<string[]> {
    const [row] = await db.select({ caseData: simulatorCases.caseData }).from(simulatorCases);
    return ((row!.caseData as { drugs: Array<{ drugId: string }> }).drugs ?? []).map(
      (d) => d.drugId,
    );
  }

  it('stores a CID-bearing drug sent by its bare id under its CID', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const withCid = await seedDrug(db, { slug: 'med-cid', pubchemCid: 5555 });

    const state = await saveCase([String(withCid)]);

    expect(state.statusCode).toBe(201);
    expect(await storedKeys()).toEqual(['5555']);
  });

  it('leaves a CID-less drug\'s bare id, a drug:<id> key and a CID key as sent', async () => {
    const userId = await seedUser(db);
    authMock.mockResolvedValue({ userId, role: 'contributor' });
    const cidLess = await seedDrug(db, { slug: 'uten-cid', pubchemCid: null });
    const internal = await seedDrug(db, { slug: 'intern', pubchemCid: null });
    await seedDrug(db, { slug: 'med-cid', pubchemCid: 7777 });

    const state = await saveCase([String(cidLess), `drug:${internal}`, '7777']);

    expect(state.statusCode).toBe(201);
    expect(await storedKeys()).toEqual([String(cidLess), `drug:${internal}`, '7777']);
  });
});
