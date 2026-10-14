/**
 * #1339 — the drug-delete teardown explicitly removes a drug's own
 * `parameter_entries` rows, rather than leaving them to the `drug_id`
 * cascade.
 *
 * Today the cascade alone is enough. It stops being enough once the Cmax
 * dose-context release adds a self-referential `administered_drug_id` FK
 * (ON DELETE RESTRICT) to this table: a self-administered Cmax observation
 * points at its own drug, so a drug with such a row would block its own
 * deletion unless the row is already gone by the time the drug goes. This
 * test exercises the real teardown transaction (advisory lock, FK cascades,
 * the explicit deletes) against a real migrated schema, so it would catch
 * either the explicit delete regressing back to cascade-only, or the
 * teardown ordering breaking some other step that reads the entries first.
 *
 * Asserting the entries are gone afterwards cannot tell the two apart: the
 * `drug_id` cascade removes them too. Nor, it turns out, can a
 * self-referencing row under release B's `ON DELETE RESTRICT` key (#1340),
 * which the RFC expected to fail a cascade-only delete. Postgres fires the
 * foreign-key triggers on `drugs` in trigger-NAME order, and the names embed
 * the trigger's oid — so whether the cascade clears the self-referencing row
 * before the restrict check looks for it depends on oids the migration does
 * not control. On this schema the cascade fires first and the delete
 * succeeds; on a database whose oids sort the other way it fails. That is why
 * the explicit delete is required, and also why a test cannot use the
 * constraint to detect its absence.
 *
 * So the guard below watches the deletes themselves: a test-only trigger
 * records, for every `parameter_entries` row deleted, whether its drug row
 * still existed at that moment. The teardown's explicit delete runs while the
 * drug is present; the cascade runs only after the drug row is gone. Remove
 * the explicit delete and that test fails.
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

import drugsHandler from '../../api/drugs.js';
import { drugs, parameterEntries, pendingEdits } from '../../db/schema.js';
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

/** Drive `DELETE /api/drugs?id=` as an admin. */
async function deleteDrug(id: number, userId: number) {
  const req = Readable.from(['']) as IncomingMessage;
  req.method = 'DELETE';
  req.url = `/api/drugs?id=${id}`;
  req.headers = { host: 'localhost' };
  authMock.mockResolvedValue({ userId, role: 'admin' });
  const { res, state } = createResponse();
  await drugsHandler(req, res);
  return state;
}

async function seedEntry(
  drugId: number,
  refs: { administeredDrugId?: number; interactingDrugId?: number } = {},
): Promise<number> {
  const [row] = await db
    .insert(parameterEntries)
    .values(
      refs.administeredDrugId === undefined && refs.interactingDrugId === undefined
        ? {
            drugId,
            parameter: 'therapeuticConcentration',
            unit: 'mg/L',
            matrix: 'serum',
            scenario: 'living_therapeutic',
            low: '1',
            high: '2',
          }
        : {
            // Dose context lives only on a Cmax row (migration 0129), which
            // always names its administered drug — its own when not given.
            drugId,
            parameter: 'cmax',
            unit: 'ng/mL',
            matrix: 'plasma',
            low: '1',
            high: '2',
            intervalKind: 'range',
            valueBasis: 'concentration',
            doseValue: '2',
            doseUnit: 'mg',
            administeredDrugId: refs.administeredDrugId ?? drugId,
            ...(refs.interactingDrugId !== undefined
              ? {
                  interactingDrugId: refs.interactingDrugId,
                  coadministrationState: 'with_interacting_drug',
                }
              : {}),
          },
    )
    .returning({ id: parameterEntries.id });
  return row!.id;
}

describe('DELETE /api/drugs — parameter_entries teardown', () => {
  it('deletes a drug that owns parameter entries, and the entries with it', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedEntry(drugId);
    await seedEntry(drugId);

    const state = await deleteDrug(drugId, admin);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ ok: true, id: drugId });
    expect(await db.select().from(drugs).where(eq(drugs.id, drugId))).toEqual(
      [],
    );
    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  it('deletes a drug with no parameter entries just as cleanly', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'koffein' });

    const state = await deleteDrug(drugId, admin);

    expect(state.statusCode).toBe(200);
    expect(await db.select().from(drugs).where(eq(drugs.id, drugId))).toEqual(
      [],
    );
  });

  it("leaves another drug's entries untouched", async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const target = await seedDrug(db, { slug: 'kokain' });
    const other = await seedDrug(db, { slug: 'koffein' });
    await seedEntry(target);
    const survivingEntryId = await seedEntry(other);

    await deleteDrug(target, admin);

    const survivors = await db
      .select({ id: parameterEntries.id })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, other));
    expect(survivors).toEqual([{ id: survivingEntryId }]);
  });

  // The cascade-insensitive guard (see the header). Every entry the teardown
  // removes must be removed while its drug row still exists — i.e. by the
  // explicit delete, not by the `drug_id` cascade after the drug is gone.
  it('removes the entries itself, before the drug row, not through the cascade', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedEntry(drugId, { administeredDrugId: drugId });
    await seedEntry(drugId);

    await db.execute(sql`
      CREATE TABLE test_entry_delete_log (entry_id integer, drug_present boolean)`);
    await db.execute(sql`
      CREATE FUNCTION test_log_entry_delete() RETURNS trigger AS $$
      BEGIN
        INSERT INTO test_entry_delete_log
          VALUES (OLD.id, EXISTS (SELECT 1 FROM drugs WHERE id = OLD.drug_id));
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER test_log_entry_delete BEFORE DELETE ON parameter_entries
      FOR EACH ROW EXECUTE FUNCTION test_log_entry_delete()`);
    try {
      const state = await deleteDrug(drugId, admin);
      expect(state.statusCode).toBe(200);

      const log = await db.execute(sql`
        SELECT drug_present FROM test_entry_delete_log ORDER BY entry_id`);
      expect(log.rows).toEqual([
        { drug_present: true },
        { drug_present: true },
      ]);
    } finally {
      await db.execute(sql`DROP TRIGGER test_log_entry_delete ON parameter_entries`);
      await db.execute(sql`DROP FUNCTION test_log_entry_delete()`);
      await db.execute(sql`DROP TABLE test_entry_delete_log`);
    }
  });

  // The common-path shape of a self-administered Cmax observation: the entry
  // names its own drug as the substance administered. Whatever order the
  // foreign-key triggers fire in, the teardown must still delete the drug.
  it('deletes a drug whose own entries name it as the administered and interacting drug', async () => {
    const admin = await seedUser(db, { role: 'admin' });
    const drugId = await seedDrug(db, { slug: 'kokain' });
    await seedEntry(drugId, { administeredDrugId: drugId });
    await seedEntry(drugId, { interactingDrugId: drugId });

    const state = await deleteDrug(drugId, admin);

    expect(state.statusCode).toBe(200);
    expect(await db.select().from(drugs).where(eq(drugs.id, drugId))).toEqual(
      [],
    );
    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  // The RESTRICT key doing the job it exists for: benzoylecgonine's Cmax was
  // measured after dosing cocaine, and deleting cocaine must not leave that
  // evidence naming a substance that no longer exists. Refused up front with
  // a 409 that says why, rather than a 500 from the constraint — and nothing
  // is torn down, the target's own entries included.
  it.each([
    ['administered', 'administeredDrugId'],
    ['interacting', 'interactingDrugId'],
  ] as const)(
    "refuses to delete a drug another drug's entry names as the %s drug",
    async (_label, column) => {
      const admin = await seedUser(db, { role: 'admin' });
      const parent = await seedDrug(db, { slug: 'kokain' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      const ownEntry = await seedEntry(parent);
      const dependent = await seedEntry(metabolite, { [column]: parent });

      const state = await deleteDrug(parent, admin);

      expect(state.statusCode).toBe(409);
      expect(JSON.parse(state.body).error).toMatch(
        /interacting drug by 1 source entry on other substances/,
      );
      expect(
        await db.select({ id: drugs.id }).from(drugs).where(eq(drugs.id, parent)),
      ).toEqual([{ id: parent }]);
      const remaining = await db
        .select({ id: parameterEntries.id })
        .from(parameterEntries)
        .orderBy(parameterEntries.id);
      expect(remaining).toEqual([{ id: ownEntry }, { id: dependent }]);
    },
  );
});

describe('DELETE /api/drugs — a legacy monograph keyed by the drug\'s CID', () => {
  it('refuses while a page migration 0148 left keyed by the CID would be orphaned', async () => {
    // The per-deploy link repair leaves a page keyed by a CID alone only
    // while some drug carries that CID. Deleting the drug frees it, and the
    // next deploy would recreate a drug for the page.
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    await db.execute(sql`
      INSERT INTO wiki_pages (slug, title, page_type, drug_cid, created_by, updated_by)
      VALUES ('eslikarbazepin-gammel', 'Eslikarbazepin', 'drug_monograph', 9881504, ${userId}, ${userId})`);

    const state = await deleteDrug(drugId, userId);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('drug_cid_keys_legacy_monograph');
    expect(
      await db.select({ id: drugs.id }).from(drugs).where(eq(drugs.id, drugId)),
    ).toHaveLength(1);
  });
});

// An open `param_entry` proposal about ANOTHER drug that names this one in its
// dose context. JSON carries no foreign key, so the teardown counts them under
// the drug's lock and refuses (Cmax release B, #19). The real-Postgres lock
// suite races this against an author; here the refusal itself, for each of
// the two columns that name a drug, in a create's `input` and an update's
// `patch` — the four JSON paths the scan reads.
describe('DELETE /api/drugs — open proposals naming the drug', () => {
  type Column = 'administeredDrugId' | 'interactingDrugId';

  /** A Cmax payload body naming `ref` under `column`. */
  function doseContext(analyte: number, ref: number, column: Column) {
    return column === 'administeredDrugId'
      ? { administeredDrugId: ref }
      : {
          administeredDrugId: analyte,
          interactingDrugId: ref,
          coadministrationState: 'with_interacting_drug',
        };
  }

  async function queueProposal(
    shape: 'create' | 'update',
    analyte: number,
    ref: number,
    column: Column,
    submittedBy: number,
    status = 'pending',
  ): Promise<number> {
    const refs = doseContext(analyte, ref, column);
    const [targetId, proposedValue] =
      shape === 'create'
        ? [
            analyte,
            {
              op: 'create',
              input: {
                drugId: analyte,
                parameter: 'cmax',
                unit: 'ng/mL',
                matrix: 'plasma',
                centralValue: 84,
                centralStatistic: 'arithmetic_mean',
                valueBasis: 'concentration',
                doseValue: 2,
                doseUnit: 'mg',
                ...refs,
              },
            },
          ]
        : [await seedEntry(analyte), { op: 'update', patch: refs }];
    const [row] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId,
        parameter: 'cmax',
        proposedValue: proposedValue as never,
        status,
        submittedBy,
      })
      .returning({ id: pendingEdits.id });
    return row!.id;
  }

  it.each([
    ['administeredDrugId', 'create'],
    ['administeredDrugId', 'update'],
    ['interactingDrugId', 'create'],
    ['interactingDrugId', 'update'],
  ] as const)(
    'refuses while an open proposal names the drug as %s (%s proposal)',
    async (column, shape) => {
      const admin = await seedUser(db, { role: 'admin' });
      const parent = await seedDrug(db, { slug: 'kokain' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      const ownEntry = await seedEntry(parent);
      const editId = await queueProposal(shape, metabolite, parent, column, admin);

      const state = await deleteDrug(parent, admin);

      expect(state.statusCode).toBe(409);
      expect(JSON.parse(state.body).code).toBe('drug_named_by_open_proposals');
      // Refused before anything was torn down: the drug, its own entry and
      // the proposal all survive.
      expect(
        await db.select({ id: drugs.id }).from(drugs).where(eq(drugs.id, parent)),
      ).toEqual([{ id: parent }]);
      expect(
        await db
          .select({ id: parameterEntries.id })
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, parent)),
      ).toEqual([{ id: ownEntry }]);
      expect(
        await db.select({ id: pendingEdits.id }).from(pendingEdits),
      ).toEqual([{ id: editId }]);
    },
  );

  // The negative control: only ACTIVE proposals block. A settled one is
  // history, not queued work, and must not keep the drug alive.
  it.each([['administeredDrugId'], ['interactingDrugId']] as const)(
    'does not count a settled proposal naming the drug as %s',
    async (column) => {
      const admin = await seedUser(db, { role: 'admin' });
      const parent = await seedDrug(db, { slug: 'kokain' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      await queueProposal('create', metabolite, parent, column, admin, 'rejected');

      const state = await deleteDrug(parent, admin);

      expect(state.statusCode).toBe(200);
      expect(await db.select().from(drugs).where(eq(drugs.id, parent))).toEqual(
        [],
      );
    },
  );
});
