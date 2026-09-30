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
import { drugs, parameterEntries } from '../../db/schema.js';
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
