import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  approvals,
  citations,
  drugParameters,
  drugParameterRevisions,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import {
  applyApprovedEdit,
  assertLockedEntryOwner,
} from '../../api/_lib/pending-edits-helpers.js';
import { markEntryMutationsConflicted } from '../../api/_lib/entry-conflicts.js';
import {
  buildEnrichmentMaps,
  enrichFromMaps,
} from '../../api/pending-edits.js';
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
});

let citationSeq = 0;
async function seedCitation(): Promise<number> {
  citationSeq += 1;
  const [c] = await db
    .insert(citations)
    .values({ type: 'doi', identifier: `10.1/x${citationSeq}`, metadata: {} })
    .returning({ id: citations.id });
  return c!.id;
}

async function insertEntryEdit(input: {
  submittedBy: number;
  targetId: number;
  parameter: string;
  proposedValue: unknown;
  referenceIds?: number[];
  /** The singular legacy column, for rows queued before `reference_ids`. */
  referenceId?: number;
}): Promise<number> {
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: input.targetId,
      parameter: input.parameter,
      proposedValue: input.proposedValue as never,
      referenceIds: input.referenceIds ?? null,
      referenceId: input.referenceId ?? null,
      status: 'pending',
      submittedBy: input.submittedBy,
    })
    .returning({ id: pendingEdits.id });
  return row!.id;
}

describe('param_entry approval pipeline', () => {
  it('create → inserts a contributor entry, recomputes the cache, stamps approval', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'r@example.com',
      username: 'r',
    });
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [citationId],
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
    });

    await applyApprovedEdit(editId, reviewer);

    const entries = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('contributor');
    expect(entries[0]!.parameter).toBe('therapeuticConcentration');

    const [cached] = await db
      .select()
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          eq(drugParameters.parameter, 'therapeuticConcentration'),
        ),
      );
    expect(cached).toBeDefined();
    expect((cached!.value as { median?: number }).median).toBe(20);

    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId));
    expect(revisions).toHaveLength(1);
    // The revision is linked to the approved edit so the peer sweep can find it.
    expect(revisions[0]!.pendingEditId).toBe(editId);

    const stamps = await db
      .select()
      .from(approvals)
      .where(eq(approvals.targetType, 'drug_parameter_revision'));
    expect(stamps.length).toBeGreaterThanOrEqual(1);

    const [pe] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    expect(pe!.status).toBe('approved');
  });

  it('update → mutates the entry and recomputes', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'r2@example.com',
      username: 'r2',
    });
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'therapeuticConcentration',
        low: '10',
        high: '20',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_therapeutic',
        origin: 'contributor',
        citationId,
      })
      .returning({ id: parameterEntries.id });

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'therapeuticConcentration',
      referenceIds: [citationId],
      proposedValue: {
        op: 'update',
        patch: {
          median: 50,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
    });

    await applyApprovedEdit(editId, reviewer);

    const [updated] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, entry!.id));
    expect(Number(updated!.median)).toBe(50);

    const [cached] = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect((cached!.value as { median?: number }).median).toBe(50);
  });

  it('delete → removes the entry', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'r3@example.com',
      username: 'r3',
    });
    const drugId = await seedDrug(db);
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'toxicConcentration',
        low: '100',
        high: '200',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_toxic',
        origin: 'contributor',
      })
      .returning({ id: parameterEntries.id });

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'toxicConcentration',
      proposedValue: { op: 'delete' },
    });

    await applyApprovedEdit(editId, reviewer);

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, entry!.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects approving an authored value for a source-value-backed parameter', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'ra@example.com',
      username: 'ra',
    });
    const drugId = await seedDrug(db);
    // An entry backs therapeuticConcentration, so its value is a cache.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      low: '10',
      high: '20',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      origin: 'contributor',
    });
    // A direct hand edit to that parameter.
    const [pe] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'therapeuticConcentration',
        proposedValue: { min: 5, max: 50, unit: 'mg/L' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await expect(applyApprovedEdit(pe!.id, reviewer)).rejects.toThrow();
  });

  it('rejects it on a parameter that has no source values yet', async () => {
    // The refusal is a property of the parameter, not of the pair's state. A
    // summarizable parameter with an empty pool is where an authored value is
    // most tempting — and where it would sit outside the source-value system
    // until a recompute silently replaced it — so it is refused there too.
    // Such an edit can no longer be submitted; this covers the ones queued
    // before the rule, which a reviewer must reject rather than apply.
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'rc@example.com',
      username: 'rc',
    });
    const drugId = await seedDrug(db);

    const [pe] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'halfLife',
        proposedValue: { min: 1, max: 4, unit: 'h' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await expect(applyApprovedEdit(pe!.id, reviewer)).rejects.toMatchObject({
      code: 'parameter_entry_backed',
    });
  });

  it('rejects a create whose payload target diverges from the queued row', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'rb@example.com',
      username: 'rb',
    });
    const drugId = await seedDrug(db);
    const otherDrugId = await seedDrug(db, { slug: 'other', names: { nb: 'B', en: 'B' } });
    const citationId = await seedCitation();

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [citationId],
      // Payload points at a DIFFERENT drug than the queued targetId.
      proposedValue: {
        op: 'create',
        input: {
          drugId: otherDrugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
    });

    await expect(applyApprovedEdit(editId, reviewer)).rejects.toThrow();
    // Nothing was inserted for either drug.
    const rows = await db.select().from(parameterEntries);
    expect(rows).toHaveLength(0);
  });

  it('rejects a payload citation not advertised by the pending row', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'rc@example.com',
      username: 'rc',
    });
    const drugId = await seedDrug(db);
    const advertised = await seedCitation();
    const swapped = await seedCitation();

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [advertised], // card shows this reference…
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId: swapped, // …but the payload cites another
        },
      },
    });

    await expect(applyApprovedEdit(editId, reviewer)).rejects.toThrow();
  });

  it('accepts a legacy row citing its singular reference with an empty array', async () => {
    // `reference_ids = '{}'` is a row that never set the array, not one citing
    // nothing: the queue hydration shows the singular `reference_id`, and a
    // resubmit is gated against it (`readEffectiveReferenceIds`). The approval
    // read it with `??`, so the empty array won and the payload was refused for
    // citing the very source the card displays.
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'rlegacy@example.com',
      username: 'rlegacy',
    });
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [],
      referenceId: citationId,
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
    });

    await applyApprovedEdit(editId, reviewer);

    const entries = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.citationId).toBe(citationId);
  });

  it('multiple create proposals for the same parameter coexist and both apply', async () => {
    const submitter = await seedUser(db);
    const reviewer = await seedUser(db, {
      email: 'r4@example.com',
      username: 'r4',
    });
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();

    const mkCreate = (low: number, high: number) =>
      insertEntryEdit({
        submittedBy: submitter,
        targetId: drugId,
        parameter: 'therapeuticConcentration',
        referenceIds: [citationId],
        proposedValue: {
          op: 'create',
          input: {
            drugId,
            parameter: 'therapeuticConcentration',
            low,
            high,
            unit: 'mg/L',
            matrix: 'whole_blood',
            scenario: 'living_therapeutic',
            citationId,
          },
        },
      });

    // Two open create edits on the same (drug, parameter) are allowed — the
    // open-entry unique index exempts creates because a parameter is multi-value.
    const a = await mkCreate(10, 20);
    const b = await mkCreate(30, 40);
    await applyApprovedEdit(a, reviewer);
    await applyApprovedEdit(b, reviewer);

    const entries = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(entries).toHaveLength(2);

    // The cache reflects both entries: the range spans the source bounds
    // (10–20 and 30–40 → 10–40), preserving the documented intervals.
    const [cached] = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    const value = cached!.value as { min?: number; max?: number };
    expect(value.min).toBe(10);
    expect(value.max).toBe(40);
  });
});

// The approval takes its drug advisory lock BEFORE the `pending_edits` row
// lock, so that every party follows one order — advisory, then row — and no
// ABBA cycle can form against a direct writer holding the drug lock while it
// marks proposals conflicted.
//
// That only holds if the drug it locked is the drug that owns the entry. The
// owner is read with nothing held, because the id it returns is what tells us
// which lock to take, and a merge committing in that window reassigns the entry
// from the loser to the winner. Locking the loser then protects nothing, and
// the approval goes on to request the winner's lock from underneath the row
// lock — rebuilding the exact cycle the hoist exists to prevent.
//
// The interleave itself needs two connections writing at once, which this
// single-connection harness cannot stage. The rule is what gets pinned.
describe('an approval refuses an entry that moved out from under its lock', () => {
  async function queuedUpdateFor(entryId: number, submittedBy: number) {
    const editId = await insertEntryEdit({
      submittedBy,
      targetId: entryId,
      parameter: 'therapeuticConcentration',
      proposedValue: { op: 'update', patch: { median: 25 } },
    });
    const [row] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    return row!;
  }

  it('refuses when the owner is outside the locked set', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'therapeuticConcentration',
        low: '10',
        high: '30',
        median: '20',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_therapeutic',
        citationId,
        origin: 'contributor',
        createdBy: submitter,
      })
      .returning({ id: parameterEntries.id });
    const preflight = await queuedUpdateFor(entry!.id, submitter);

    // The set the approval locked was derived a moment ago; the row now says
    // a different drug owns it, exactly as a merge would leave things.
    const winner = await seedDrug(db, {
      slug: 'winner',
      names: { nb: 'Vinner', en: 'Winner' },
    });
    await db
      .update(parameterEntries)
      .set({ drugId: winner })
      .where(eq(parameterEntries.id, entry!.id));

    await expect(
      assertLockedEntryOwner(db, preflight, [drugId]),
    ).rejects.toMatchObject({
      code: 'pending_edit_entry_owner_moved',
      // A subclass of the review-token mismatch, so every existing caller
      // already reports it as "stale, nothing applied" rather than a 500.
      statusHint: 409,
    });

    // …and it passes once the locked set is the one that actually owns it.
    await expect(
      assertLockedEntryOwner(db, preflight, [winner]),
    ).resolves.toBeUndefined();
  });

  it('does not second-guess a create, whose drug comes from the payload', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();
    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      referenceIds: [citationId],
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
    });
    const [preflight] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));

    // There is no entry row yet for a merge to move, so an unrelated locked
    // set must not turn a perfectly good create into a refusal.
    await expect(
      assertLockedEntryOwner(db, preflight!, [drugId]),
    ).resolves.toBeUndefined();
  });

  it('leaves a vanished entry to the apply, which reports it properly', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db);
    const citationId = await seedCitation();
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'therapeuticConcentration',
        low: '10',
        high: '30',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_therapeutic',
        citationId,
        origin: 'contributor',
        createdBy: submitter,
      })
      .returning({ id: parameterEntries.id });
    const preflight = await queuedUpdateFor(entry!.id, submitter);
    await db.delete(parameterEntries).where(eq(parameterEntries.id, entry!.id));

    // A deleted entry is not an ownership move, and saying "it moved" would be
    // a worse message than the one the apply gives.
    await expect(
      assertLockedEntryOwner(db, preflight, [drugId]),
    ).resolves.toBeUndefined();
  });
});

describe('markEntryMutationsConflicted (shared direct-write guard)', () => {
  it('conflicts open update/delete proposals for an entry but exempts creates', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db);
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'toxicConcentration',
        low: '100',
        high: '200',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_toxic',
        origin: 'legacy',
      })
      .returning({ id: parameterEntries.id });

    const updateEdit = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'toxicConcentration',
      proposedValue: { op: 'update', patch: { median: 150, unit: 'mg/L' } },
    });
    // A create proposal targets the drug id, not the entry — it must be exempt.
    const createEdit = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'toxicConcentration',
      proposedValue: { op: 'create', input: { drugId } },
    });

    // Simulate a legacy-route (or admin-direct) write to the same physical row.
    await markEntryMutationsConflicted(entry!.id);

    const [updated] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, updateEdit));
    expect(
      (updated!.proposedMeta as { conflict?: { reason?: string } } | null)
        ?.conflict?.reason,
    ).toBe('direct_admin_write');

    const [created] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, createEdit));
    expect(created!.proposedMeta).toBeNull();
  });

  // The marker is not only a flag — the author's PATCH compares it against the
  // marker their snapshot carried, to tell "the conflict I already rebased
  // against" from "one written since". A constant marker cannot make that
  // distinction: two direct writes leave byte-identical objects, so a rebase
  // against the FIRST silently discharges the SECOND, and the approval then
  // reverses a write nobody reviewed. Each marking has to be its own.
  it('gives every marking a distinct identity', async () => {
    const submitter = await seedUser(db, {
      email: 'rid@example.com',
      username: 'rid',
    });
    const drugId = await seedDrug(db);
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'toxicConcentration',
        low: '100',
        high: '200',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_toxic',
        origin: 'legacy',
      })
      .returning({ id: parameterEntries.id });

    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'toxicConcentration',
      proposedValue: { op: 'update', patch: { median: 150, unit: 'mg/L' } },
    });

    const markerNow = async () => {
      const [row] = await db
        .select()
        .from(pendingEdits)
        .where(eq(pendingEdits.id, editId));
      return (row!.proposedMeta as { conflict?: Record<string, unknown> })
        .conflict!;
    };

    await markEntryMutationsConflicted(entry!.id);
    const first = await markerNow();
    await markEntryMutationsConflicted(entry!.id);
    const second = await markerNow();

    // Same reason — it is the same KIND of conflict — and a different identity,
    // which is what the comparison needs.
    expect(first.reason).toBe('direct_admin_write');
    expect(second.reason).toBe('direct_admin_write');
    expect(typeof second.id).toBe('string');
    expect(second.id).not.toBe(first.id);
    // And so the whole objects differ, which is the form the PATCH compares in.
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  // A proposal does not have to be `pending` right now to reach an approval
  // later. `returned` is waiting on its author and `draft` is pulled back to be
  // worked on; both go back into the queue with whatever payload they hold, so
  // a resubmission that changes nothing carries the stale snapshot forward.
  // Marking only `pending` left exactly that path unguarded.
  it('conflicts returned and draft proposals too, but not decided ones', async () => {
    const submitter = await seedUser(db, {
      email: 'rs@example.com',
      username: 'rs',
    });
    const drugId = await seedDrug(db);
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'toxicConcentration',
        low: '100',
        high: '200',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_toxic',
        origin: 'legacy',
      })
      .returning({ id: parameterEntries.id });

    const proposalIn = async (status: string) => {
      const id = await insertEntryEdit({
        submittedBy: submitter,
        targetId: entry!.id,
        parameter: 'toxicConcentration',
        proposedValue: { op: 'update', patch: { median: 150, unit: 'mg/L' } },
      });
      await db
        .update(pendingEdits)
        .set({ status })
        .where(eq(pendingEdits.id, id));
      return id;
    };
    const returned = await proposalIn('returned');
    const draft = await proposalIn('draft');
    const rejected = await proposalIn('rejected');

    await markEntryMutationsConflicted(entry!.id);

    const conflictOf = async (id: number) => {
      const [row] = await db
        .select()
        .from(pendingEdits)
        .where(eq(pendingEdits.id, id));
      return (row!.proposedMeta as { conflict?: unknown } | null)?.conflict;
    };
    expect(await conflictOf(returned)).toBeTruthy();
    expect(await conflictOf(draft)).toBeTruthy();
    // Decided rows are history; a marker there is noise on something nobody
    // can act on.
    expect(await conflictOf(rejected)).toBeUndefined();
  });
});

describe('param_entry review-card enrichment', () => {
  async function enrich(editId: number) {
    const [row] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId));
    const maps = await buildEnrichmentMaps([row!]);
    return enrichFromMaps(row!, maps);
  }

  it('names the target drug on a create card (targetId = drug id)', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db, { names: { nb: 'Diazepam', en: 'Diazepam' } });
    const citationId = await seedCitation();
    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'therapeuticConcentration',
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'therapeuticConcentration',
          low: 10,
          high: 30,
          unit: 'mg/L',
          matrix: 'whole_blood',
          scenario: 'living_therapeutic',
          citationId,
        },
      },
      referenceIds: [citationId],
    });

    const enriched = await enrich(editId);
    expect(enriched.drugName).toBe('Diazepam');
  });

  it('hydrates the live entry + drug on a delete card (targetId = entry id)', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db, { names: { nb: 'Diazepam', en: 'Diazepam' } });
    const citationId = await seedCitation();
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'toxicConcentration',
        low: '100',
        high: '200',
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_toxic',
        origin: 'contributor',
        citationId,
      })
      .returning({ id: parameterEntries.id });
    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'toxicConcentration',
      proposedValue: { op: 'delete' },
    });

    const enriched = await enrich(editId);
    // The reviewer sees which drug is affected and the entry being removed.
    expect(enriched.drugName).toBe('Diazepam');
    const current = enriched.currentEntry as {
      low: number | null;
      high: number | null;
      matrix: string;
      citationId: number | null;
    };
    expect(current.low).toBe(100);
    expect(current.high).toBe(200);
    expect(current.matrix).toBe('whole_blood');
    expect(current.citationId).toBe(citationId);
  });

  it('names the dosed parent on a metabolite Cmax card, proposed and live (#1346)', async () => {
    // The entry belongs to the metabolite; the dose belongs to the parent. A
    // card reading "administered: substance #311" cannot be checked.
    const submitter = await seedUser(db);
    const bze = await seedDrug(db, {
      slug: 'benzoylekgonin',
      names: { nb: 'Benzoylekgonin', en: 'Benzoylecgonine' },
    });
    const cocaine = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
    });
    const citationId = await seedCitation();
    const cmax = {
      drugId: bze,
      parameter: 'cmax',
      valueBasis: 'concentration',
      centralValue: 84,
      centralStatistic: 'arithmetic_mean',
      unit: 'ng/mL',
      matrix: 'plasma',
      route: 'oral',
      doseValue: 2,
      doseUnit: 'mg',
      administeredDrugId: cocaine,
      citationId,
    };
    const createId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: bze,
      parameter: 'cmax',
      proposedValue: { op: 'create', input: cmax },
      referenceIds: [citationId],
    });
    const created = await enrich(createId);
    expect(created.drugName).toBe('Benzoylekgonin');
    expect(created.doseContextDrugNames).toEqual({ [cocaine]: 'Kokain' });

    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId: bze,
        parameter: 'cmax',
        unit: 'ng/mL',
        matrix: 'plasma',
        route: 'oral',
        centralValue: '84',
        centralStatistic: 'arithmetic_mean',
        valueBasis: 'concentration',
        doseValue: '2',
        doseUnit: 'mg',
        administeredDrugId: cocaine,
        origin: 'contributor',
        citationId,
      } as never)
      .returning({ id: parameterEntries.id });
    const deleteId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: entry!.id,
      parameter: 'cmax',
      proposedValue: { op: 'delete' },
    });
    const deleted = await enrich(deleteId);
    expect(deleted.doseContextDrugNames).toEqual({ [cocaine]: 'Kokain' });
  });

  it('adds no drug names to an entry without dose context', async () => {
    const submitter = await seedUser(db);
    const drugId = await seedDrug(db, { names: { nb: 'Diazepam', en: 'Diazepam' } });
    const citationId = await seedCitation();
    const editId = await insertEntryEdit({
      submittedBy: submitter,
      targetId: drugId,
      parameter: 'halfLife',
      proposedValue: {
        op: 'create',
        input: { drugId, parameter: 'halfLife', median: 40, unit: 'h', citationId },
      },
      referenceIds: [citationId],
    });

    expect((await enrich(editId)).doseContextDrugNames).toBeUndefined();
  });
});
