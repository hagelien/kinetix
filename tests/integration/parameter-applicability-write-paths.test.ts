/**
 * The not-applicable invariant across every write boundary, not just the one.
 *
 * A marker means the quantity is undefined for the substance. If any write
 * path can still publish a value, the database asserts both at once — the gap
 * queue skips the pair as impossible while the monograph serves a number for
 * it. The first cut of this feature guarded only `PUT /api/drug-parameter`,
 * which left the approval path and the entry-summary recompute open; these
 * tests pin the other two shut.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  citations,
  drugParameterApplicability,
  drugParameters,
  drugs,
  parameterEntries,
  pendingEdits,
  verificationLog,
} from '../../db/schema.js';
import { applyApprovedEdit } from '../../api/_lib/pending-edits-helpers.js';
import { upsertDrugParameter } from '../../api/_lib/drugParameterStore.js';
import {
  blockedParametersFor,
  ParameterNotApplicableError,
  withDrugApplicabilityLock,
} from '../../api/_lib/parameterApplicabilityStore.js';
import { getDb, inTransaction, runInPoolTransaction } from '../../api/_lib/db.js';
import { applyInitialParameters } from '../../api/_lib/drugs-helpers.js';
import {
  applyDrugRowUpdate,
  conflictingAdministrationData,
} from '../../api/drugs.js';
import {
  insertParameterEntry,
  recomputeAndCacheParameterSummary,
} from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import {
  deleteReferenceConcentration,
  insertReferenceConcentration,
  updateReferenceConcentration,
} from '../../api/_lib/reference-concentrations-helpers.js';
import { writeMolecularWeight } from '../../scripts/backfill-molecular-weights.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;
let submitter: number;
let reviewer: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  submitter = await seedUser(db, { email: 's@example.com', username: 's' });
  reviewer = await seedUser(db, { email: 'r@example.com', username: 'r' });
  drugId = await seedDrug(db);
});

async function seedCitation(): Promise<number> {
  const [c] = await db
    .insert(citations)
    .values({ type: 'doi', identifier: '10.1/applicability', metadata: {} })
    .returning({ id: citations.id });
  return c!.id;
}

async function mark(parameter: string, reason = 'Not a defined quantity.') {
  // Inserted directly rather than through the endpoint: the endpoint refuses
  // to mark a pair that already holds a value or entries, and these tests need
  // exactly that already-conflicting state to prove the write paths hold.
  await db
    .insert(drugParameterApplicability)
    .values({ drugId, parameter, reason });
}

async function popularity(): Promise<number> {
  const [row] = await db
    .select({ score: drugs.popularityScore })
    .from(drugs)
    .where(eq(drugs.id, drugId));
  return row!.score;
}

async function storedValue(parameter: string): Promise<unknown> {
  const [row] = await db
    .select({ value: drugParameters.value })
    .from(drugParameters)
    .where(eq(drugParameters.parameter, parameter));
  return row?.value ?? null;
}

describe('applicability at the approval boundary', () => {
  it('rejects approving a parameter edit queued before the marker landed', async () => {
    // The submission gate only sees the marker as it stood when the edit was
    // queued, so the decision has to be re-made where it becomes final.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'bioavailability',
        proposedValue: { min: 0.5, max: 0.6, unit: 'fraction' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await mark('bioavailability');

    await expect(applyApprovedEdit(edit!.id, reviewer)).rejects.toThrow(
      /not applicable/i,
    );
    expect(await storedValue('bioavailability')).toBeNull();
  });

  it('carries the stable code so the review card can translate it', async () => {
    // The English message above is a developer fallback. A Norwegian reviewer
    // sees `review.errors.parameterNotApplicable` only if the throw carries the
    // code — the route passes `err.code` through and PendingEditCard maps it.
    // The entry branch had it and this one did not, so the card's own comment
    // claiming both branches emit it was false.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'bioavailability',
        proposedValue: { min: 0.5, max: 0.6, unit: 'fraction' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await mark('bioavailability');

    await expect(applyApprovedEdit(edit!.id, reviewer)).rejects.toMatchObject({
      code: 'parameter_not_applicable',
      statusHint: 409,
    });
  });

  it('still approves an edit on an unmarked parameter', async () => {
    // An authored parameter (analyte stability is matrix-specific, so it is
    // not pooled from source values): the applicability gate is the only thing
    // that could stop it, and nothing here is marked. A summarizable parameter
    // cannot reach this branch at all — see the source-value refusal below it.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'analyteStability',
        proposedValue: { min: 1, max: 2, unit: 'h' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await applyApprovedEdit(edit!.id, reviewer);
    expect(await storedValue('analyteStability')).toEqual({
      min: 1,
      max: 2,
      unit: 'h',
    });
  });

  it('refuses an authored value for a source-value-backed parameter', async () => {
    // Ordering matters: the applicability re-check runs first, so a marked
    // pair still reports the stronger refusal. An unmarked one lands here.
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'bioavailability',
        proposedValue: { min: 0.5, max: 0.6, unit: 'fraction' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await expect(applyApprovedEdit(edit!.id, reviewer)).rejects.toMatchObject({
      code: 'parameter_entry_backed',
      statusHint: 409,
    });
    expect(await storedValue('bioavailability')).toBeNull();
  });
});

describe('inTransaction joins rather than nests', () => {
  /**
   * The property that keeps the advisory lock from deadlocking against itself.
   *
   * `runInPoolTransaction` nested inside another opens a fresh Pool on a
   * *different connection*. When the outer connection holds
   * `pg_advisory_xact_lock(drugId)` and the inner one asks for it, the inner
   * blocks on the outer while the outer awaits the inner — a hang, not an
   * error. That is exactly what monograph creation with initial parameters
   * did once the page path took the lock and `applyInitialParameters` opened
   * its own transaction.
   *
   * **This suite cannot reproduce the deadlock itself.** With the PGlite
   * harness `runInPoolTransaction` routes through the one connection, so a
   * nested call becomes a savepoint and the lock is re-entrant — the hang is
   * invisible here and appears only against a real pool. What *is* observable
   * is the structural cause: whether a second transaction context was created
   * at all. That is what these assert, and it is what fails on the old code.
   */
  it('reuses the caller’s transaction handle', async () => {
    let outer: unknown;
    let inner: unknown;
    await runInPoolTransaction(async () => {
      outer = getDb();
      await inTransaction(async () => {
        inner = getDb();
      });
    });
    expect(inner).toBe(outer);
  });

  it('opens one when the caller has none', async () => {
    const ambient = getDb();
    let inside: unknown;
    await inTransaction(async () => {
      inside = getDb();
    });
    expect(inside).not.toBe(ambient);
  });

  it('lets applyInitialParameters run under a caller that holds the drug lock', async () => {
    // The production shape: the monograph path takes the lock, then fills the
    // parameter bag. Against a real pool this hung; here it at least proves
    // the path composes and the values land.
    const citationId = await seedCitation();
    await withDrugApplicabilityLock(drugId, async () => {
      await applyInitialParameters({
        drugId,
        entries: [{ id: 'halfLife', value: { min: 5, max: 12, unit: 'h' } }],
        referenceId: citationId,
        userId: submitter,
      });
    });

    const [stored] = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect(stored!.parameter).toBe('halfLife');
  });

  it('takes the drug lock before it touches the drug row', async () => {
    /**
     * Lock *order*, not just lock presence.
     *
     * The popularity bump is an `UPDATE drugs`, which holds a row lock until
     * commit. It used to run before anything reached the advisory lock, so
     * under the wiki_new approval path (one transaction around the whole
     * approval) the order was row → advisory, while `applyDrugRowUpdate`
     * serving a concurrent PATCH takes them advisory → row. Classic ABBA:
     * Postgres resolves it by killing one request.
     *
     * **The deadlock is not reproducible here** — one PGlite connection, so
     * there is no second session to deadlock against. What is observable is
     * the structural cause: whether the row update happens inside the lock's
     * transaction. With a non-transactional caller the lock helper opens one,
     * so a later refusal must now roll the bump back. On the old code the
     * bump auto-committed before the lock was ever taken and survived.
     */
    await mark('halfLife');
    const before = await popularity();

    await expect(
      applyInitialParameters({
        drugId,
        entries: [{ id: 'halfLife', value: { min: 5, max: 12, unit: 'h' } }],
        referenceId: await seedCitation(),
        userId: submitter,
      }),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    expect(await popularity()).toBe(before);
  });
});

describe('the substance-class rule binds writes, not just the queue', () => {
  /**
   * The class rule has to be a fact about the data, not a queue-display
   * convention. If a metabolite can still be given a bioavailability, the
   * queue calls the pair impossible while the monograph serves a number for
   * it — the same contradiction an explicit marker prevents, reached through
   * the other layer.
   */
  async function metabolite(): Promise<number> {
    return seedDrug(db, {
      slug: 'an-analyte',
      names: { en: 'An analyte' },
      substanceClass: 'metabolite',
    });
  }

  it('refuses an administration-requiring value with no marker present', async () => {
    const id = await metabolite();
    await expect(
      upsertDrugParameter(
        db,
        id,
        'bioavailability',
        { min: 0.5, max: 0.6, unit: 'fraction' },
        submitter,
      ),
    ).rejects.toThrow(/not administered/i);
  });

  it('still accepts the parameters that stay meaningful for an analyte', async () => {
    const id = await metabolite();
    await expect(
      upsertDrugParameter(
        db,
        id,
        'halfLife',
        { min: 5, max: 12, unit: 'h' },
        submitter,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects the approval of an edit for a class-excluded parameter', async () => {
    const id = await metabolite();
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: id,
        parameter: 'bioavailability',
        proposedValue: { min: 0.5, max: 0.6, unit: 'fraction' } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });

    await expect(applyApprovedEdit(edit!.id, reviewer)).rejects.toThrow(
      /not administered/i,
    );
  });

  it('does not let the absent cooldown block a write', async () => {
    // The cooldown records that a search came back empty, not that the
    // quantity cannot exist. Someone who has now found a source must be able
    // to store it — that is the outcome the cooldown is waiting for.
    await db.insert(verificationLog).values({
      targetType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      concordance: 'absent',
      outcome: 'commented_only',
      sourcesConsultedCount: 0,
    });

    await expect(
      upsertDrugParameter(
        db,
        drugId,
        'clearance',
        { min: 1, max: 2, unit: 'L/h' },
        submitter,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('blockedParametersFor — the preflight behind wiki page creation', () => {
  /**
   * `api/wiki/pages.ts` inserts the page and its revision before
   * `applyInitialParameters` runs, on a path with no transaction. A parameter
   * the write guard refuses would throw into a 500 with the page already
   * committed, and the retry would collide with its own slug — so the check
   * has to happen before anything is written, and has to name every offender
   * at once rather than failing on the first.
   */
  it('names every parameter an analyte cannot have', async () => {
    const id = await seedDrug(db, {
      slug: 'panel-analyte',
      names: { en: 'Panel analyte' },
      substanceClass: 'metabolite',
    });

    expect(
      await blockedParametersFor(db, id, [
        'halfLife',
        'bioavailability',
        // Not blocked: a metabolite's time to peak is measured after the
        // parent is dosed and is a routine published endpoint.
        'tmax',
        'fatalDose',
        'molecularWeight',
      ]),
    ).toEqual(['bioavailability', 'fatalDose']);
  });

  it('catches an explicit marker in the same pass', async () => {
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      reason: 'Undefined for this substance.',
    });

    expect(
      await blockedParametersFor(db, drugId, ['halfLife', 'bloodPlasmaRatio']),
    ).toEqual(['bloodPlasmaRatio']);
  });

  it('passes a clean bag and an empty bag', async () => {
    expect(
      await blockedParametersFor(db, drugId, ['halfLife', 'bioavailability']),
    ).toEqual([]);
    expect(await blockedParametersFor(db, drugId, [])).toEqual([]);
  });

  it('reports nothing for a drug that does not exist', async () => {
    // Not this check's business — the FK, or the caller's own 404, is the
    // right failure for a missing target.
    expect(await blockedParametersFor(db, 999999, ['bioavailability'])).toEqual(
      [],
    );
  });
});

describe('reclassification cannot contradict live data', () => {
  it('lists the parameters standing in the way of an analyte class', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'bioavailability',
      value: { min: 0.5, max: 0.6, unit: 'fraction' },
    });
    const citationId = await seedCitation();
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'fatalDose',
      low: 1,
      high: 2,
      unit: 'mg/kg',
      citationId,
      origin: 'contributor',
      createdBy: submitter,
    });

    expect(await conflictingAdministrationData(drugId, 'metabolite')).toEqual([
      'bioavailability',
      'fatalDose',
    ]);
  });

  it('raises nothing when only unaffected parameters hold values', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value: { min: 5, max: 12, unit: 'h' },
    });

    expect(await conflictingAdministrationData(drugId, 'metabolite')).toEqual(
      [],
    );
  });

  it('rolls the class back when the rest of the same edit fails', async () => {
    // The class change and the metadata update are one statement inside one
    // locked transaction. Applying the class in its own transaction first —
    // as an earlier revision did — left a rejected request half-applied: the
    // caller sees an error while the reclassification silently persists and
    // starts suppressing gaps.
    const other = await seedDrug(db, {
      slug: 'occupies-the-cid',
      names: { en: 'Occupies the CID' },
      pubchemCid: 424242,
    });
    expect(other).toBeGreaterThan(0);

    await expect(
      applyDrugRowUpdate(
        drugId,
        { substanceClass: 'metabolite', pubchemCid: 424242 },
        'metabolite',
      ),
    ).rejects.toThrow();

    const [row] = await db
      .select({ substanceClass: drugs.substanceClass })
      .from(drugs)
      .where(eq(drugs.id, drugId));
    expect(row!.substanceClass).toBe('drug');
  });

  it('never blocks a change back to an administered class', async () => {
    // Widening what is defined can create no contradiction, so it is always
    // allowed — including as the escape hatch from a wrong classification.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'bioavailability',
      value: { min: 0.5, max: 0.6, unit: 'fraction' },
    });

    expect(await conflictingAdministrationData(drugId, 'drug')).toEqual([]);
  });
});

describe('the row update and the molecular-weight write are one unit', () => {
  /**
   * `PATCH /api/drugs` can carry drug metadata, a reclassification and a
   * molecularWeight in the same request. molecularWeight is not a drug column
   * — it lands in `drug_parameters`, behind the applicability guard — so for a
   * while it was written *after* the row update had already committed. A
   * marked pair then threw out of an uncaught guard: 500 to the caller, with
   * the name/CID/class change durably applied.
   */
  it('rolls the row update back when the parameter write is refused', async () => {
    await mark('molecularWeight');

    await expect(
      applyDrugRowUpdate(drugId, { nameShort: 'Renamed' }, undefined, {
        molecularWeight: 303.4,
        userId: submitter,
      }),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    const [row] = await db
      .select({ nameShort: drugs.nameShort })
      .from(drugs)
      .where(eq(drugs.id, drugId));
    expect(row!.nameShort).toBeNull();
    expect(await storedValue('molecularWeight')).toBeNull();
  });

  it('rolls a reclassification back with it', async () => {
    // The worst shape of the bug: the refused parameter write follows a class
    // change, so the caller gets an error while the substance is quietly
    // reclassified — and an analyte class suppresses gaps for every
    // administered parameter, not just this one.
    await mark('molecularWeight');

    await expect(
      applyDrugRowUpdate(
        drugId,
        { substanceClass: 'metabolite' },
        'metabolite',
        { molecularWeight: 303.4, userId: submitter },
      ),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    const [row] = await db
      .select({ substanceClass: drugs.substanceClass })
      .from(drugs)
      .where(eq(drugs.id, drugId));
    expect(row!.substanceClass).toBe('drug');
  });

  it('commits both when nothing blocks the pair', async () => {
    const applied = await applyDrugRowUpdate(
      drugId,
      { nameShort: 'Renamed' },
      undefined,
      { molecularWeight: 303.4, userId: submitter },
    );

    expect('row' in applied && applied.row?.nameShort).toBe('Renamed');
    expect(await storedValue('molecularWeight')).toBe(303.4);
  });
});

describe('the legacy reference-concentration endpoint writes the same table', () => {
  /**
   * `referenceConcentrations` is an alias for `parameterEntries` in
   * `db/schema.ts`, so this compatibility DAO is a third way to write a source
   * row for a (drug, parameter) pair — and it went around
   * `insertParameterEntry`, where the guard lives. The writer-audit could not
   * see it either: the scan matched the two table identifiers by name, and an
   * alias is a different name for the same act.
   */
  it('refuses to create a source row for a marked pair', async () => {
    await mark('therapeuticConcentration');

    await expect(
      insertReferenceConcentration({
        input: {
          drugId,
          low: 10,
          high: 20,
          unit: 'ng/mL',
          matrix: 'blood',
          scenario: 'living_therapeutic',
        },
        createdBy: submitter,
      }),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  it('still creates one when the pair is not marked', async () => {
    const created = await insertReferenceConcentration({
      input: {
        drugId,
        low: 10,
        high: 20,
        unit: 'ng/mL',
        matrix: 'blood',
        scenario: 'living_therapeutic',
      },
      createdBy: submitter,
    });

    expect(created.parameter).toBe('therapeuticConcentration');
  });

  it('refuses a scenario change that moves a row onto a marked pair', async () => {
    // The sideways route to the same contradiction: the update re-derives
    // `parameter` from the scenario, so an unmarked row can be walked onto a
    // marked pair without ever calling the insert path.
    const created = await insertReferenceConcentration({
      input: {
        drugId,
        low: 10,
        high: 20,
        unit: 'ng/mL',
        matrix: 'blood',
        scenario: 'living_therapeutic',
      },
      createdBy: submitter,
    });
    await mark('toxicConcentration');

    await expect(
      updateReferenceConcentration({
        id: created.id,
        input: {
          drugId,
          low: 30,
          high: 40,
          unit: 'ng/mL',
          matrix: 'blood',
          scenario: 'living_toxic',
        },
      }),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    const [after] = await db
      .select({ parameter: parameterEntries.parameter })
      .from(parameterEntries)
      .where(eq(parameterEntries.id, created.id));
    expect(after!.parameter).toBe('therapeuticConcentration');
  });

  it('always allows deleting one, marked or not', async () => {
    // Removing the contradiction must never be blocked by the contradiction —
    // the same asymmetry upsertDrugParameter applies to clearing a value.
    const created = await insertReferenceConcentration({
      input: {
        drugId,
        low: 10,
        high: 20,
        unit: 'ng/mL',
        matrix: 'blood',
        scenario: 'living_therapeutic',
      },
      createdBy: submitter,
    });
    await mark('therapeuticConcentration');

    expect(await deleteReferenceConcentration(created.id)).toBe(true);
  });
});

describe('the molecular-weight backfill reports what it actually did', () => {
  /**
   * A backfill that silently skips is indistinguishable from one that worked —
   * the failure this whole feature exists to prevent, in miniature. The run's
   * pre-check is unlocked, so a marker landing between it and the write makes
   * the conditional INSERT match zero rows; counting that as a write would
   * hand the operator a tally saying the gap is filled when it is not.
   */
  it('writes and says so when nothing blocks the pair', async () => {
    expect(await writeMolecularWeight(drugId, 303.4, submitter)).toBe('written');
    expect(await storedValue('molecularWeight')).toBe(303.4);
  });

  it('reports blocked, not written, when a marker is in the way', async () => {
    await mark('molecularWeight');

    expect(await writeMolecularWeight(drugId, 303.4, submitter)).toBe('blocked');
    expect(await storedValue('molecularWeight')).toBeNull();
  });

  it('distinguishes a value that arrived while the run was fetching', async () => {
    // Also zero rows, via ON CONFLICT DO NOTHING — but not the same news, and
    // reporting it as "blocked" would send an operator looking for a marker
    // that does not exist.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'molecularWeight',
      value: 111.1,
    });

    expect(await writeMolecularWeight(drugId, 303.4, submitter)).toBe(
      'already-present',
    );
    expect(await storedValue('molecularWeight')).toBe(111.1);
  });
});

describe('applicability at the entry-approval boundary', () => {
  /**
   * The gap the recompute's skip left open. `applyApprovedParameterEntry`
   * inserts the entry row itself and only then recomputes; because the
   * recompute *skips* an excluded parameter rather than throwing (so one
   * excluded parameter cannot block its siblings), nothing downstream failed
   * the approval — the entry simply committed next to the marker forbidding
   * it. The check has to happen at the approval boundary, before the row is
   * written.
   */
  async function queueEntryCreate(parameter: string): Promise<number> {
    const citationId = await seedCitation();
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: drugId,
        parameter,
        referenceIds: [citationId],
        proposedValue: {
          op: 'create',
          input: {
            drugId,
            parameter,
            low: 0.5,
            high: 0.6,
            unit: 'fraction',
            citationId,
          },
        } as never,
        status: 'pending',
        submittedBy: submitter,
      })
      .returning({ id: pendingEdits.id });
    return edit!.id;
  }

  it('rejects an entry create queued before the marker landed', async () => {
    const editId = await queueEntryCreate('bioavailability');
    await mark('bioavailability');

    // Asserted on the code, not just the prose — this branch and the parameter
    // branch above must stay in step, and they did not: one carried the code
    // and the other rendered raw English to a Norwegian reviewer.
    await expect(applyApprovedEdit(editId, reviewer)).rejects.toMatchObject({
      code: 'parameter_not_applicable',
      statusHint: 409,
    });
    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  it('rejects an entry create for a parameter the class rules out', async () => {
    const editId = await queueEntryCreate('bioavailability');
    await db
      .update(drugs)
      .set({ substanceClass: 'metabolite' })
      .where(eq(drugs.id, drugId));

    await expect(applyApprovedEdit(editId, reviewer)).rejects.toThrow(
      /not administered/i,
    );
    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  it('still approves an entry on an unaffected parameter', async () => {
    const editId = await queueEntryCreate('bioavailability');

    await applyApprovedEdit(editId, reviewer);
    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toHaveLength(1);
  });
});

describe('insertParameterEntry guards itself', () => {
  /**
   * The entry store owns this invariant now, rather than trusting its callers.
   *
   * Relying on the endpoint and the approval path was wrong: a third caller —
   * `scripts/seed-pm-am-ratios.ts` — went through neither and inserted live
   * source rows beside a permanent marker. Nothing downstream objected, since
   * the recompute skips an excluded parameter rather than failing. Guarding the
   * function itself is what makes a caller who has never heard of the rule safe.
   */
  it('refuses an entry on a marked pair, whoever is calling', async () => {
    await mark('halfLife');
    const citationId = await seedCitation();

    await expect(
      insertParameterEntry(
        {
          drugId,
          parameter: 'halfLife',
          median: 8,
          unit: 'h',
          citationId,
        } as never,
        submitter,
      ),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);

    expect(
      await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, drugId)),
    ).toEqual([]);
  });

  it('refuses one the substance class rules out', async () => {
    await db
      .update(drugs)
      .set({ substanceClass: 'metabolite' })
      .where(eq(drugs.id, drugId));
    const citationId = await seedCitation();

    await expect(
      insertParameterEntry(
        {
          drugId,
          parameter: 'bioavailability',
          low: 0.5,
          high: 0.6,
          unit: 'fraction',
          citationId,
        } as never,
        submitter,
      ),
    ).rejects.toThrow(/not administered/i);
  });

  it('still accepts an entry on an open pair', async () => {
    const citationId = await seedCitation();
    const row = await insertParameterEntry(
      {
        drugId,
        parameter: 'halfLife',
        median: 8,
        unit: 'h',
        citationId,
      } as never,
      submitter,
    );
    expect(row.parameter).toBe('halfLife');
  });
});

describe('applicability at the entry-recompute boundary', () => {
  it('publishes no cached aggregate for a marked parameter', async () => {
    const citationId = await seedCitation();
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'bioavailability',
      low: 0.5,
      high: 0.6,
      unit: 'fraction',
      citationId,
      origin: 'contributor',
      createdBy: submitter,
    });
    await mark('bioavailability');

    // Skipped, not thrown: one entry write cascades a recompute across every
    // summarizable parameter on the drug, so a throw here would let one marked
    // parameter block its unmarked siblings.
    await expect(
      recomputeAndCacheParameterSummary(drugId, 'bioavailability', submitter),
    ).resolves.toBeNull();
    expect(await storedValue('bioavailability')).toBeNull();
  });

  it('recomputes an unmarked parameter on the same drug regardless', async () => {
    const citationId = await seedCitation();
    await db.insert(parameterEntries).values([
      {
        drugId,
        parameter: 'bioavailability',
        low: 0.5,
        high: 0.6,
        unit: 'fraction',
        citationId,
        origin: 'contributor',
        createdBy: submitter,
      },
      {
        drugId,
        parameter: 'halfLife',
        low: 5,
        high: 12,
        unit: 'h',
        citationId,
        origin: 'contributor',
        createdBy: submitter,
      },
    ]);
    await mark('bioavailability');

    await recomputeAndCacheParameterSummary(drugId, 'halfLife', submitter);
    expect(await storedValue('halfLife')).not.toBeNull();
  });
});
