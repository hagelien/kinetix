/**
 * The not-applicable marker store over real SQL — the pair-level layer of the
 * applicability model (src/lib/parameterApplicability.ts).
 *
 * The behaviour worth pinning here is the composite-key upsert: a marker is
 * keyed on (drug, parameter), so re-marking a pair must revise the existing
 * row rather than fail or duplicate. Two live answers to "is this quantity
 * defined?" would be worse than none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  citations,
  drugParameterApplicability,
  drugParameters,
  drugs,
  parameterEntries,
} from '../../db/schema.js';
import {
  deleteApplicability,
  isMarkedNotApplicable,
  listApplicabilityForDrug,
  markedNotApplicableAmong,
  ParameterNotApplicableError,
  upsertApplicability,
} from '../../api/_lib/parameterApplicabilityStore.js';
import { upsertDrugParameter } from '../../api/_lib/drugParameterStore.js';
import { hasAnyEntryForParameter } from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;
let editorId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  editorId = await seedUser(db, {
    email: 'editor@example.com',
    username: 'editor',
    role: 'editor',
  });
  drugId = await seedDrug(db, {
    slug: 'benzoylecgonin',
    names: { en: 'Benzoylecgonine' },
    substanceClass: 'metabolite',
  });
});

describe('parameter applicability store', () => {
  it('records a marker with its reason and setter', async () => {
    const row = await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Not administered; no extravascular dose exists.',
      setBy: editorId,
    });

    expect(row.status).toBe('not_applicable');
    expect(row.reason).toBe('Not administered; no extravascular dose exists.');
    expect(row.setBy).toBe(editorId);
    expect(await isMarkedNotApplicable(db, drugId, 'bioavailability')).toBe(true);
  });

  it('revises the existing row instead of duplicating the pair', async () => {
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'First reading.',
      setBy: editorId,
    });
    const other = await seedUser(db, {
      email: 'other@example.com',
      username: 'other',
      role: 'admin',
    });
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Sharper reading.',
      setBy: other,
    });

    const rows = await db
      .select()
      .from(drugParameterApplicability)
      .where(eq(drugParameterApplicability.drugId, drugId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Sharper reading.');
    expect(rows[0]!.setBy).toBe(other);
  });

  it('scopes a marker to its own pair', async () => {
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Not administered.',
      setBy: editorId,
    });

    expect(await isMarkedNotApplicable(db, drugId, 'halfLife')).toBe(false);
    expect(
      await markedNotApplicableAmong(db, drugId, [
        'bioavailability',
        'halfLife',
        'tmax',
      ]),
    ).toEqual(new Set(['bioavailability']));
  });

  it('returns an empty set for an empty parameter list', async () => {
    expect(await markedNotApplicableAmong(db, drugId, [])).toEqual(new Set());
  });

  it('lists a drug’s markers in parameter order', async () => {
    for (const parameter of ['tmax', 'bioavailability'] as const) {
      await upsertApplicability(db, {
        drugId,
        parameter,
        status: 'not_applicable',
        reason: 'Not administered.',
        setBy: editorId,
      });
    }

    expect((await listApplicabilityForDrug(db, drugId)).map((r) => r.parameter))
      .toEqual(['bioavailability', 'tmax']);
  });

  it('lifts a marker and reports whether there was one', async () => {
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Not administered.',
      setBy: editorId,
    });

    expect(await deleteApplicability(db, drugId, 'bioavailability')).toBe(true);
    expect(await isMarkedNotApplicable(db, drugId, 'bioavailability')).toBe(
      false,
    );
    expect(await deleteApplicability(db, drugId, 'bioavailability')).toBe(false);
  });

  it('blocks a value write through the shared store, at any call site', async () => {
    // upsertDrugParameter is the one choke point every drug_parameters write
    // funnels through — the parameter PUT, the approval path and the entry
    // recompute. Guarding only the PUT would let the other two publish a value
    // for a pair the database also says has no such quantity.
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Not administered.',
      setBy: editorId,
    });

    await expect(
      upsertDrugParameter(
        db,
        drugId,
        'bioavailability',
        { min: 0.5, max: 0.6, unit: 'fraction' },
        editorId,
      ),
    ).rejects.toBeInstanceOf(ParameterNotApplicableError);
  });

  it('still allows clearing a value on a marked pair', async () => {
    // Removing the contradiction must never be blocked by the contradiction —
    // otherwise a pair marked while it held a value could never be reconciled.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'bioavailability',
      value: { min: 0.5, max: 0.6, unit: 'fraction' },
    });
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'bioavailability',
      reason: 'Marked directly, bypassing the endpoint guard.',
    });

    await expect(
      upsertDrugParameter(db, drugId, 'bioavailability', null, editorId),
    ).resolves.toBeUndefined();
    expect(
      await db
        .select()
        .from(drugParameters)
        .where(eq(drugParameters.drugId, drugId)),
    ).toEqual([]);
  });

  it('leaves an unmarked pair writable', async () => {
    await expect(
      upsertDrugParameter(
        db,
        drugId,
        'halfLife',
        { min: 5, max: 12, unit: 'h' },
        editorId,
      ),
    ).resolves.toBeUndefined();
  });

  it('counts a grandfathered entry when deciding a pair can be marked', async () => {
    /**
     * The aggregation excludes `origin='grandfathered'` rows once a real source
     * exists — those synthetic migration rows are not evidence, they only
     * preserve a migrated value. The marker's conflict check once borrowed that
     * exclusion, and so imported an answer to a different question: the marker
     * asks "would the UI still show a source value for a pair I'm declaring
     * undefined?", and `GET /api/parameter-entries` does return grandfathered
     * rows. So a pair whose only entry was grandfathered could be marked while
     * the interface kept rendering a number underneath the marker.
     */
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/grandfathered', metadata: {} })
      .returning({ id: citations.id });
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'halfLife',
      median: '8',
      unit: 'h',
      citationId: citation!.id,
      createdBy: editorId,
      origin: 'grandfathered',
    });

    expect(await hasAnyEntryForParameter(drugId, 'halfLife')).toBe(true);
  });

  it('drops markers with the drug they belong to', async () => {
    await upsertApplicability(db, {
      drugId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'Not administered.',
      setBy: editorId,
    });

    // FK is ON DELETE CASCADE; a marker outliving its drug would be a
    // dangling claim about a substance that no longer exists.
    await db.delete(drugs).where(eq(drugs.id, drugId));

    expect(await listApplicabilityForDrug(db, drugId)).toEqual([]);
  });
});
