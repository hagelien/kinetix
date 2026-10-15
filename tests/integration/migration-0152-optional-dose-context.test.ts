/**
 * Formulation, regimen and population scope on the absorption parameters
 * (migration 0152, #12).
 *
 * An extended-release-only Tmax (OPANA ER) used to be storable only as a bare
 * oral Tmax, with its formulation in prose, and would then pool as the drug's
 * oral Tmax. Now the Cmax dose-context columns that say so — release profile,
 * physical form, regimen and interval, population — are open to tmax, ka,
 * bioavailability and absorptionModel: the database stores them there and
 * nowhere else outside Cmax, the store round-trips them, and the pooled
 * summary leaves the non-reference entry out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parameterEntries } from '../../db/schema.js';
import {
  computeParameterSummary,
  getParameterSummariesWithRoutes,
  insertParameterEntry,
  listEntriesForDrug,
} from '../../api/_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../../src/lib/parameterEntries.js';
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

const tmax = (over: Record<string, unknown> = {}) => ({
  drugId,
  parameter: 'tmax',
  unit: 'h',
  route: 'oral',
  low: '4',
  high: '8',
  ...over,
});

describe('migration 0152 — the scope columns on the absorption parameters', () => {
  // Built per test: `drugId` is seeded in beforeEach, after the table is read.
  it.each([
    ['an extended-release twice-daily Tmax', () => tmax({ releaseProfile: 'modified', physicalForm: 'tablet_capsule', doseRegimen: 'multiple', doseIntervalHours: '12' })],
    ['a Tmax in a qualified population', () => tmax({ pkPopulation: 'renal_impairment', populationQualifier: 'CrCl < 30 mL/min' })],
    ['a monthly depot F', () => ({ drugId, parameter: 'bioavailability', unit: 'fraction', route: 'im', low: '0.8', high: '0.9', releaseProfile: 'modified', physicalForm: 'suspension', doseRegimen: 'steady_state', doseIntervalHours: '720' })],
    ['a ka in healthy adults', () => ({ drugId, parameter: 'ka', unit: '1/h', route: 'oral', median: '1.2', pkPopulation: 'healthy_adult' })],
    ['an immediate-release absorption model', () => ({ drugId, parameter: 'absorptionModel', unit: '', route: 'oral', categoricalValue: 'first-order', releaseProfile: 'immediate' })],
  ])('stores %s', async (_label, values) => {
    expect(await insertFails(values())).toBeNull();
  });

  it('still refuses the rest of the dose context on them', async () => {
    expect(await insertFails(tmax({ doseValue: '10', doseUnit: 'mg' }))).toBe(
      'parameter_entries_dose_context_forbidden',
    );
    expect(await insertFails(tmax({ prandialState: 'fed' }))).toBe(
      'parameter_entries_dose_context_forbidden',
    );
    expect(await insertFails(tmax({ valueBasis: 'concentration' }))).toBe(
      'parameter_entries_dose_context_forbidden',
    );
  });

  it('still refuses every dose-context column on any other parameter', async () => {
    expect(
      await insertFails({ drugId, parameter: 'halfLife', unit: 'h', low: '4', high: '6', releaseProfile: 'modified' }),
    ).toBe('parameter_entries_dose_context_forbidden');
    expect(
      await insertFails({ drugId, parameter: 'halfLife', unit: 'h', low: '4', high: '6', pkPopulation: 'elderly' }),
    ).toBe('parameter_entries_dose_context_forbidden');
  });

  it("holds the opened columns to 0129's dependency and vocabulary rules", async () => {
    expect(await insertFails(tmax({ doseRegimen: 'single', doseIntervalHours: '12' }))).toBe(
      'parameter_entries_dose_context_dependencies',
    );
    expect(await insertFails(tmax({ pkPopulation: 'healthy_adult', populationQualifier: 'postop' }))).toBe(
      'parameter_entries_dose_context_dependencies',
    );
    expect(await insertFails(tmax({ releaseProfile: 'extended' }))).toBe(
      'parameter_entries_dose_context_vocabulary',
    );
  });
});

describe('entry store — a scoped Tmax', () => {
  async function seed() {
    const userId = await seedUser(db);
    return { userId };
  }

  it('round-trips the scope and keeps the extended-release entry out of the pool', async () => {
    const { userId } = await seed();
    const ir = await seedAdmissibleCitation(db);
    const er = await seedAdmissibleCitation(db, { identifier: '24500276' });
    for (const [citationId, over] of [
      [ir, { median: 1, releaseProfile: 'immediate' }],
      [er, { median: 8, releaseProfile: 'modified', doseRegimen: 'multiple', doseIntervalHours: 12 }],
    ] as const) {
      await insertParameterEntry(
        { drugId, citationId, parameter: 'tmax', unit: 'h', ...over } as ParameterEntryInput,
        userId,
      );
    }

    const entries = await listEntriesForDrug(drugId, 'tmax');
    expect(entries.map((e) => e.doseContext)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ releaseProfile: 'immediate' }),
        expect.objectContaining({ releaseProfile: 'modified', doseRegimen: 'multiple', doseIntervalHours: 12 }),
      ]),
    );

    const { summaries } = await getParameterSummariesWithRoutes(drugId);
    expect(summaries.tmax?.entryCount).toBe(2);
    expect(summaries.tmax?.pooledCount).toBe(1);
    expect(summaries.tmax?.representative).toBe(1);
    const cached = await computeParameterSummary(drugId, 'tmax');
    expect(cached?.representative).toBe(1);
    expect(cached?.contributingCitationIds).toEqual([ir]);
  });
});
