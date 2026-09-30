/**
 * The dose-normalized Cmax summary, read from a migrated schema: Cmax entries
 * with their review scores, the drug's molecular weight, and its SOURCED
 * blood:plasma entries (never the cached scalar).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugParameters, parameterEntries } from '../../db/schema.js';
import { getCmaxSummaryForDrug, getCmaxViewForDrug } from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;
let citationId: number;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  drugId = await seedDrug(db, { slug: 'kokain' });
  citationId = await seedAdmissibleCitation(db);
  userId = await seedUser(db);
  await db
    .insert(drugParameters)
    .values({ drugId, parameter: 'molecularWeight', value: 303.35 as never, updatedBy: userId });
});

async function seedCmax(over: Record<string, unknown>) {
  await db.insert(parameterEntries).values({
    drugId,
    parameter: 'cmax',
    unit: 'ng/mL',
    matrix: 'plasma',
    route: 'oral',
    n: 10,
    citationId,
    centralValue: '303.35',
    centralStatistic: 'arithmetic_mean',
    valueBasis: 'concentration',
    doseValue: '2',
    doseUnit: 'mg',
    doseBasis: 'free-base',
    doseRegimen: 'single',
    releaseProfile: 'immediate',
    physicalForm: 'tablet_capsule',
    prandialState: 'fasted',
    coadministrationState: 'monotherapy',
    pkPopulation: 'healthy_adult',
    administeredDrugId: drugId,
    ...over,
  } as never);
}

describe('getCmaxSummaryForDrug', () => {
  it('normalizes and pools one stratum into a single headline', async () => {
    await seedCmax({});
    await seedCmax({ centralValue: '606.7' });
    const summary = await getCmaxSummaryForDrug(drugId);
    expect(summary.headline.kind).toBe('single');
    if (summary.headline.kind !== 'single') return;
    expect(summary.headline.stratum.cohorts).toBe(2);
    expect(summary.headline.stratum.spread!.low).toBeCloseTo(0.5, 6);
    expect(summary.headline.stratum.spread!.high).toBeCloseTo(1, 6);
  });

  it('converts whole blood through a SOURCED ratio, and refuses without one', async () => {
    await seedCmax({ matrix: 'whole_blood', centralValue: '151.675' });
    let summary = await getCmaxSummaryForDrug(drugId);
    expect(summary.outcomes[0]).toMatchObject({ kind: 'ineligible', reason: 'unsourced_matrix_ratio' });

    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      unit: 'ratio',
      median: '0.5',
      citationId,
    } as never);
    summary = await getCmaxSummaryForDrug(drugId);
    // 151.675 ng/mL in blood / 0.5 = 303.35 ng/mL in plasma = 1 µmol/L, per 2 mg.
    expect(summary.outcomes[0]).toMatchObject({ kind: 'poolable' });
    if (summary.headline.kind === 'single') {
      expect(summary.headline.stratum.value).toBeCloseTo(0.5, 6);
    }
  });

  it('keeps an ineligible reading visible with its reason', async () => {
    await seedCmax({ route: null, prandialState: null });
    const summary = await getCmaxSummaryForDrug(drugId);
    expect(summary.headline).toEqual({ kind: 'none' });
    expect(summary.outcomes).toEqual([
      expect.objectContaining({ kind: 'ineligible', reason: 'missing_route' }),
    ]);
  });
});

// Codex P1 on #1387: the rows and the summary are one snapshot, so the per-dose
// view never lists rows the summary did not see (or omits rows it did).
describe('getCmaxViewForDrug', () => {
  it('returns exactly the rows its summary was computed from', async () => {
    await seedCmax({});
    await seedCmax({ centralValue: '606.7' });
    await seedCmax({ route: null });
    const { items, summary } = await getCmaxViewForDrug(drugId);
    const outcomeIds = summary.outcomes
      .map((o) => (o.kind === 'ineligible' ? o.entryId : o.entry.entryId))
      .sort((a, b) => a - b);
    expect(items.map((i) => i.id).sort((a, b) => a - b)).toEqual(outcomeIds);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.parameter === 'cmax')).toBe(true);
  });
});
