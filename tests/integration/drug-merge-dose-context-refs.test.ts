/**
 * Cmax release B (#1340): a drug merge repoints the two dose-context drug
 * references on `parameter_entries` — `administered_drug_id` and
 * `interacting_drug_id` — before it deletes the loser.
 *
 * Both are ON DELETE RESTRICT, and both can name the loser from ANY drug's
 * entry (a metabolite's Cmax names its parent as the drug administered). A
 * merge that repointed only `drug_id` would leave those references on the
 * loser, and its final delete would then fail on the constraint. Nothing
 * writes either column before release C; these tests seed the values
 * directly, because the whole point of release B is that the handler is
 * deployed everywhere before the first value can exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drugs, parameterEntries, pendingEdits } from '../../db/schema.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import {
  detectDataConflicts,
  DrugMergeDataConflictError,
  loadDrugSideInfo,
  mergeDrugs,
} from '../../api/_lib/drug-merge.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

function merge(winnerId: number, loserId: number) {
  return runInPoolTransaction(() =>
    mergeDrugs(getDb(), {
      winnerId,
      loserId,
      resolutions: {},
      actorUserId: userId,
      approvedPlanFingerprint: null,
    }),
  );
}

async function seedEntry(
  drugId: number,
  refs: { administeredDrugId?: number; interactingDrugId?: number },
  low = '1',
): Promise<number> {
  const [row] = await db
    .insert(parameterEntries)
    .values({
      // A well-formed Cmax row (migration 0129 requires the administered drug,
      // a value basis and, for a concentration, its dose; it forbids dose
      // context on any other parameter).
      drugId,
      parameter: 'cmax',
      unit: 'ng/mL',
      matrix: 'plasma',
      low,
      high: '20',
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
      createdBy: userId,
    })
    .returning({ id: parameterEntries.id });
  return row!.id;
}

async function entry(id: number) {
  const [row] = await db
    .select({
      drugId: parameterEntries.drugId,
      administeredDrugId: parameterEntries.administeredDrugId,
      interactingDrugId: parameterEntries.interactingDrugId,
    })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, id));
  return row;
}

describe('drug merge — dose-context drug references', () => {
  it("repoints another drug's administered and interacting references, then deletes the loser", async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const byDose = await seedEntry(metabolite, { administeredDrugId: loser });
    const byInteraction = await seedEntry(
      metabolite,
      { administeredDrugId: metabolite, interactingDrugId: loser },
      '3',
    );

    await merge(winner, loser);

    expect(await db.select().from(drugs).where(eq(drugs.id, loser))).toEqual([]);
    expect(await entry(byDose)).toEqual({
      drugId: metabolite,
      administeredDrugId: winner,
      interactingDrugId: null,
    });
    expect(await entry(byInteraction)).toEqual({
      drugId: metabolite,
      administeredDrugId: metabolite,
      interactingDrugId: winner,
    });
  });

  // The loser's own self-administered entry: `drug_id` and
  // `administered_drug_id` both name the loser. After the merge it is a
  // self-reference on the winner — the same shape a natively authored
  // self-administered entry has, which is what lets the two be compared.
  it("turns the loser's self-reference into a self-reference on the winner", async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const own = await seedEntry(loser, { administeredDrugId: loser });

    await merge(winner, loser);

    expect(await entry(own)).toEqual({
      drugId: winner,
      administeredDrugId: winner,
      interactingDrugId: null,
    });
    expect(await db.select().from(drugs).where(eq(drugs.id, loser))).toEqual([]);
  });

  it('leaves references to uninvolved drugs alone', async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const parent = await seedDrug(db, { slug: 'heroin' });
    const ketoconazole = await seedDrug(db, { slug: 'ketokonazol' });
    const moved = await seedEntry(loser, {
      administeredDrugId: parent,
      interactingDrugId: ketoconazole,
    });

    await merge(winner, loser);

    expect(await entry(moved)).toEqual({
      drugId: winner,
      administeredDrugId: parent,
      interactingDrugId: ketoconazole,
    });
  });

  // An interaction arm between the two sides of the merge would come out as
  // a drug interacting with itself. Refused in the preflight, whichever side
  // owns the entry, and the apply path refuses it too.
  it.each([
    ['winner', 'loser'],
    ['loser', 'winner'],
  ] as const)(
    'refuses a merge when the %s carries an interaction arm naming the %s',
    async (owner, named) => {
      const winner = await seedDrug(db, { slug: 'kokain' });
      const loser = await seedDrug(db, { slug: 'kokain-dup' });
      const ids = { winner, loser };
      const armId = await seedEntry(ids[owner], {
        administeredDrugId: ids[owner],
        interactingDrugId: ids[named],
      });

      const [w, l] = await Promise.all([
        loadDrugSideInfo(db, winner),
        loadDrugSideInfo(db, loser),
      ]);
      const conflicts = await detectDataConflicts(db, w!, l!);
      expect(conflicts).toEqual([
        expect.objectContaining({
          table: 'parameter_entries',
          message: expect.objectContaining({
            code: 'dataConflict.parameterEntrySelfInteraction',
            params: { parameter: 'cmax', entryId: armId },
          }),
        }),
      ]);

      await expect(merge(winner, loser)).rejects.toBeInstanceOf(
        DrugMergeDataConflictError,
      );
      expect(await entry(armId)).toEqual({
        drugId: ids[owner],
        administeredDrugId: ids[owner],
        interactingDrugId: ids[named],
      });
    },
  );

  // Codex P1 on #1360: two otherwise identical entries of a third drug, one
  // naming the loser and one the winner, become one observation recorded
  // twice. The merge's own dedup compares only the merged drugs' rows, so it
  // would pool both; the preflight refuses instead.
  it.each([['administeredDrugId'], ['interactingDrugId']] as const)(
    "refuses a merge that would make a third drug's entries identical through %s",
    async (key) => {
      const winner = await seedDrug(db, { slug: 'kokain' });
      const loser = await seedDrug(db, { slug: 'kokain-dup' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      const extra =
        key === 'interactingDrugId' ? { administeredDrugId: metabolite } : {};
      const first = await seedEntry(metabolite, { ...extra, [key]: loser });
      const second = await seedEntry(metabolite, { ...extra, [key]: winner });

      const [w, l] = await Promise.all([
        loadDrugSideInfo(db, winner),
        loadDrugSideInfo(db, loser),
      ]);
      expect(await detectDataConflicts(db, w!, l!)).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            code: 'dataConflict.parameterEntryThirdPartyDuplicate',
            params: {
              parameter: 'cmax',
              firstEntryId: first,
              secondEntryId: second,
            },
          }),
        }),
      ]);
      await expect(merge(winner, loser)).rejects.toBeInstanceOf(
        DrugMergeDataConflictError,
      );
      expect((await entry(first))![key]).toBe(loser);
    },
  );

  it("still merges when a third drug's entries differ in more than the merged drug", async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    await seedEntry(metabolite, { administeredDrugId: loser }, '1');
    await seedEntry(metabolite, { administeredDrugId: winner }, '1.5');

    await merge(winner, loser);
    expect(await db.select().from(drugs).where(eq(drugs.id, loser))).toEqual([]);
  });

  // Codex P1 on #1360: a third drug's entry can pair the two as the drug dosed
  // and the drug coadministered — a metabolite's Cmax after dosing one, in the
  // presence of the other. The repoint would turn it into a drug interacting
  // with itself just the same.
  it.each([
    ['loser', 'winner'],
    ['winner', 'loser'],
  ] as const)(
    "refuses a merge when a third drug's entry dosed the %s with the %s coadministered",
    async (dosed, interacting) => {
      const winner = await seedDrug(db, { slug: 'kokain' });
      const loser = await seedDrug(db, { slug: 'kokain-dup' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      const ids = { winner, loser };
      const armId = await seedEntry(metabolite, {
        administeredDrugId: ids[dosed],
        interactingDrugId: ids[interacting],
      });

      const [w, l] = await Promise.all([
        loadDrugSideInfo(db, winner),
        loadDrugSideInfo(db, loser),
      ]);
      expect(await detectDataConflicts(db, w!, l!)).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            code: 'dataConflict.parameterEntrySelfInteraction',
            params: { parameter: 'cmax', entryId: armId },
          }),
        }),
      ]);
      await expect(merge(winner, loser)).rejects.toBeInstanceOf(
        DrugMergeDataConflictError,
      );
      expect(await entry(armId)).toEqual({
        drugId: metabolite,
        administeredDrugId: ids[dosed],
        interactingDrugId: ids[interacting],
      });
    },
  );
});

// The rolling-deploy window in the other direction: while release B's
// migration has run, the previous deployment is still serving requests, and
// its entry insert names only the legacy columns. That insert must succeed.
describe('release-B schema — previous deployment compatibility', () => {
  it('accepts an insert that names none of the new columns, and leaves them null', async () => {
    const drugId = await seedDrug(db, { slug: 'kokain' });
    const res = await db.execute(sql`
      INSERT INTO parameter_entries (drug_id, parameter, unit, matrix, low, high, origin)
      VALUES (${drugId}, 'tmax', 'h', 'plasma', 1, 2, 'legacy')
      RETURNING id`);
    const id = Number((res.rows as Array<{ id: number }>)[0]!.id);
    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row).toMatchObject({
      administeredDrugId: null,
      interactingDrugId: null,
      centralValue: null,
      centralStatistic: null,
      intervalKind: null,
      doseValue: null,
      doseUnit: null,
      valueBasis: null,
    });
  });
});

// The merge's duplicate identity compares the complete entry shape, AFTER the
// drug references are repointed (Cmax release B, #1340). Two arms of one paper
// reporting the same number at different doses are two observations and both
// survive; the same arm on both sides is one observation and is folded.
describe('drug merge — duplicate identity over dose context', () => {
  async function seedArm(
    drugId: number,
    administeredDrugId: number,
    doseValue: string,
  ): Promise<number> {
    const [row] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'cmax',
        unit: 'µmol/L',
        matrix: 'plasma',
        low: '0.07',
        high: '0.098',
        centralValue: '0.084',
        centralStatistic: 'arithmetic_mean',
        intervalKind: 'sd',
        doseValue,
        doseUnit: 'mg',
        valueBasis: 'concentration',
        administeredDrugId,
        createdBy: userId,
      })
      .returning({ id: parameterEntries.id });
    return row!.id;
  }

  async function entriesOf(drugId: number) {
    return db
      .select({
        doseValue: parameterEntries.doseValue,
        administeredDrugId: parameterEntries.administeredDrugId,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId))
      .orderBy(parameterEntries.doseValue);
  }

  it('keeps two arms that differ only in dose', async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    await seedArm(winner, winner, '2');
    await seedArm(loser, loser, '4');

    await merge(winner, loser);

    expect(await entriesOf(winner)).toEqual([
      { doseValue: '2.000000', administeredDrugId: winner },
      { doseValue: '4.000000', administeredDrugId: winner },
    ]);
  });

  // The loser's self-reference becomes the winner's once repointed, so the
  // two rows ARE the same observation and fold into one — the comparison must
  // run on post-merge values, or both would survive as a double-counted pair.
  it("folds a loser's self-referencing arm into the winner's identical one", async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    await seedArm(winner, winner, '2');
    await seedArm(loser, loser, '2');

    const [w, l] = await Promise.all([
      loadDrugSideInfo(db, winner),
      loadDrugSideInfo(db, loser),
    ]);
    expect(await detectDataConflicts(db, w!, l!)).toEqual([]);

    await merge(winner, loser);

    expect(await entriesOf(winner)).toEqual([
      { doseValue: '2.000000', administeredDrugId: winner },
    ]);
  });

  it('keeps arms whose administered drugs genuinely differ', async () => {
    const winner = await seedDrug(db, { slug: 'benzoylekgonin' });
    const loser = await seedDrug(db, { slug: 'benzoylekgonin-dup' });
    const cocaine = await seedDrug(db, { slug: 'kokain' });
    await seedArm(winner, cocaine, '2');
    await seedArm(loser, loser, '2');

    await merge(winner, loser);

    expect(await entriesOf(winner)).toHaveLength(2);
  });
});

// The preflight must judge the grouping the apply will act on. A loser arm
// naming the loser as administered drug becomes the winner's twin only once
// repointed; compared on raw columns, the preflight would see two unrelated
// rows, miss that their sample sizes disagree, and let the apply fold them —
// silently discarding one cohort size.
describe('drug merge — preflight compares post-merge references', () => {
  it('refuses divergent n between arms that only become identical after repointing', async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    for (const [drugId, n] of [
      [winner, 10],
      [loser, 12],
    ] as const) {
      await db.insert(parameterEntries).values({
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
        n,
        administeredDrugId: drugId,
        createdBy: userId,
      });
    }
    const [w, l] = await Promise.all([
      loadDrugSideInfo(db, winner),
      loadDrugSideInfo(db, loser),
    ]);
    expect(await detectDataConflicts(db, w!, l!)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ code: 'dataConflict.parameterEntryDivergentN' }),
      }),
    ]);
  });
});

// RFC *Merge / provenance*: "a merge repoints administeredDrugId and
// interactingDrugId INSIDE an active param_entry payload whose outer
// target_id is a different drug, and that proposal still approves cleanly
// afterwards." The retarget by outer target_id never selects such a proposal
// — its analyte is not the loser — so without the nested repoint the loser's
// delete leaves it naming a drug that no longer exists.
describe('drug merge — drug references nested in active proposals', () => {
  async function queueCmax(
    analyte: number,
    citationId: number,
    refs: { administeredDrugId: number; interactingDrugId?: number },
    status: 'pending' | 'draft' | 'returned' = 'pending',
  ): Promise<number> {
    const input = {
      drugId: analyte,
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
      valueBasis: 'concentration',
      doseValue: 2,
      doseUnit: 'mg',
      doseRegimen: 'single',
      coadministrationState: refs.interactingDrugId ? 'with_interacting_drug' : 'monotherapy',
      ...refs,
    };
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: analyte,
        parameter: 'cmax',
        referenceId: citationId,
        referenceIds: [citationId],
        proposedValue: { op: 'create', input } as never,
        status,
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });
    return edit!.id;
  }

  async function nestedRefs(editId: number) {
    const [row] = await db
      .select({ value: pendingEdits.proposedValue })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    const input = (row!.value as { input: Record<string, unknown> }).input;
    return {
      drugId: input.drugId,
      administeredDrugId: input.administeredDrugId,
      interactingDrugId: input.interactingDrugId ?? null,
    };
  }

  it.each(['pending', 'draft', 'returned'] as const)(
    'repoints both nested ids in a %s proposal about a third drug, which then approves',
    async (status) => {
      const winner = await seedDrug(db, { slug: 'kokain' });
      const loser = await seedDrug(db, { slug: 'kokain-dup' });
      const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
      const citationId = await seedAdmissibleCitation(db);
      const editId = await queueCmax(
        metabolite,
        citationId,
        { administeredDrugId: loser, interactingDrugId: loser },
        status,
      );

      await merge(winner, loser);

      expect(await nestedRefs(editId)).toEqual({
        drugId: metabolite,
        administeredDrugId: winner,
        interactingDrugId: winner,
      });

      if (status === 'pending') {
        const reviewer = await seedUser(db, {
          role: 'admin',
          email: 'reviewer@example.com',
          username: 'reviewer',
        });
        await applyApprovedEdit(editId, reviewer);
        const [entry] = await db
          .select({
            administeredDrugId: parameterEntries.administeredDrugId,
            interactingDrugId: parameterEntries.interactingDrugId,
          })
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, metabolite));
        expect(entry).toEqual({ administeredDrugId: winner, interactingDrugId: winner });
      }
    },
  );

  it('leaves a settled proposal alone', async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const citationId = await seedAdmissibleCitation(db);
    const editId = await queueCmax(metabolite, citationId, { administeredDrugId: loser });
    await db.update(pendingEdits).set({ status: 'rejected' }).where(eq(pendingEdits.id, editId));

    await merge(winner, loser);

    expect((await nestedRefs(editId)).administeredDrugId).toBe(loser);
  });

  it('refuses a merge an open proposal would turn into a self-interaction', async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const citationId = await seedAdmissibleCitation(db);
    const editId = await queueCmax(winner, citationId, {
      administeredDrugId: winner,
      interactingDrugId: loser,
    });

    const [w, l] = await Promise.all([
      loadDrugSideInfo(db, winner),
      loadDrugSideInfo(db, loser),
    ]);
    expect(await detectDataConflicts(db, w!, l!)).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          code: 'dataConflict.pendingEntrySelfInteraction',
          params: { pendingEditId: editId },
        }),
      }),
    );
  });

  it("refuses a merge when a third drug's open proposal doses one side with the other coadministered", async () => {
    const winner = await seedDrug(db, { slug: 'kokain' });
    const loser = await seedDrug(db, { slug: 'kokain-dup' });
    const metabolite = await seedDrug(db, { slug: 'benzoylekgonin' });
    const citationId = await seedAdmissibleCitation(db);
    const editId = await queueCmax(metabolite, citationId, {
      administeredDrugId: loser,
      interactingDrugId: winner,
    });

    const [w, l] = await Promise.all([
      loadDrugSideInfo(db, winner),
      loadDrugSideInfo(db, loser),
    ]);
    expect(await detectDataConflicts(db, w!, l!)).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          code: 'dataConflict.pendingEntrySelfInteraction',
          params: { pendingEditId: editId },
        }),
      }),
    );
  });
});
