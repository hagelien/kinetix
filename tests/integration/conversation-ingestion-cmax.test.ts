/**
 * Conversation ingestion of a Cmax observation (release C, #1341): the
 * structured `doseContext` block reaches the stored entry intact, the
 * administered drug defaults to the target and otherwise resolves like the
 * target does, and an ill-formed context is refused at parse.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parameterEntries } from '../../db/schema.js';
import { parseConversationIngestion } from '../../src/lib/conversationIngestion.js';
import { applyIngestion, planIngestion } from '../../api/_lib/conversationIngestionStore.js';
import { listEntriesForDrug } from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let morphine: number;
let m6g: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db, { email: 'ingest@example.com', username: 'ingester', role: 'admin' });
  morphine = await seedDrug(db, {
    slug: 'morfin',
    names: { nb: 'Morfin', en: 'Morphine' },
    pubchemCid: 5288826,
    searchKey: 'morfin\tmorphine',
  });
  m6g = await seedDrug(db, {
    slug: 'morfin-6-glukuronid',
    names: { nb: 'Morfin-6-glukuronid', en: 'Morphine-6-glucuronide' },
    pubchemCid: 5360621,
    searchKey: 'morfin-6-glukuronid\tmorphine-6-glucuronide',
  });
});

function source(key: string, pmid: string) {
  return {
    key,
    type: 'pmid' as const,
    identifier: pmid,
    metadata: { title: `Paper ${pmid}`, year: 1990 },
    verification: {
      readInFull: true,
      locator: 'Table 1',
      evidenceSummary: 'Cmax etter 10 mg peroral morfin hos friske frivillige.',
      reviewMarkdown: 'Enkeltdosestudie.',
      reviewConfidence: 'medium' as const,
      overallScore: 70,
    },
    pdfRequestNeeded: false,
  };
}

function cmaxItem(over: Record<string, unknown> = {}, dose: Record<string, unknown> = {}) {
  return {
    type: 'parameter_observation',
    target: { drugName: 'Morphine', pubchemCid: 5288826 },
    parameter: 'cmax',
    low: 18,
    high: 30,
    unit: 'ng/mL',
    matrix: 'plasma',
    n: 10,
    sourceKey: 'S1',
    context: { dose: '10 mg morfinsulfat peroralt', derivation: { kind: 'reported' } },
    doseContext: {
      valueBasis: 'concentration',
      centralValue: 24,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
      doseValue: 10,
      doseUnit: 'mg',
      doseBasis: 'salt',
      doseSaltForm: 'sulfate',
      route: 'oral',
      doseRegimen: 'single',
      prandialState: 'fasted',
      coadministrationState: 'monotherapy',
      pkPopulation: 'healthy_adult',
      ...dose,
    },
    editSummary: 'Cmax for morfin etter 10 mg peroralt.',
    ...over,
  };
}

function bundle(items: unknown[]) {
  return {
    schemaVersion: 'kinetix-conversation-ingestion-v1',
    idempotencyKey: 'conv-cmax-01',
    mode: 'parameters',
    conversationDigest: 'b'.repeat(64),
    createdAt: '2026-09-23T09:00:00Z',
    sources: [source('S1', '2719903')],
    items,
  };
}

function parse(raw: unknown) {
  const parsed = parseConversationIngestion(raw);
  if (!parsed.ok) throw new Error(`bundle did not validate: ${parsed.errors.join('; ')}`);
  return parsed.data;
}

describe('conversation ingestion — Cmax with structured dose context', () => {
  it('stores the full context, self-administered by default', async () => {
    const result = await applyIngestion(parse(bundle([cmaxItem()])), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [entry] = await listEntriesForDrug(morphine, 'cmax');
    expect(entry).toMatchObject({ route: 'oral', low: 18, high: 30, n: 10 });
    expect(entry!.doseContext).toMatchObject({
      administeredDrugId: morphine,
      centralValue: 24,
      centralStatistic: 'arithmetic_mean',
      doseValue: 10,
      doseSaltForm: 'sulfate',
      prandialState: 'fasted',
    });
  });

  it('resolves a named administered drug for a metabolite reading', async () => {
    const item = cmaxItem(
      { target: { drugName: 'Morphine-6-glucuronide', pubchemCid: 5360621 } },
      { administeredDrug: { drugName: 'Morphine', pubchemCid: 5288826 } },
    );
    const result = await applyIngestion(parse(bundle([item])), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [entry] = await listEntriesForDrug(m6g, 'cmax');
    expect(entry!.doseContext).toMatchObject({ administeredDrugId: morphine });
  });

  it('refuses an ill-formed context at parse', () => {
    const parsed = parseConversationIngestion(
      bundle([cmaxItem({}, { valueBasis: undefined })]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join('\n')).toMatch(/valueBasis/);
  });

  it('refuses an unknown dose-context field', () => {
    const parsed = parseConversationIngestion(bundle([cmaxItem({}, { doseMg: 10 })]));
    expect(parsed.ok).toBe(false);
  });

  it('refuses a dose context on a parameter without one', async () => {
    const parsed = parseConversationIngestion(
      bundle([
        {
          ...cmaxItem(),
          parameter: 'halfLife',
          unit: 'h',
          matrix: undefined,
          low: 2,
          high: 3,
          doseContext: { valueBasis: 'concentration' },
        },
      ]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join('\n')).toMatch(/takes no dose context/);
    expect(await db.select().from(parameterEntries)).toEqual([]);
  });
});

/**
 * The reported statistic is not dose context: an ordinary parameter's
 * observation says what its number is through the same `doseContext` block,
 * carrying only `centralValue` / `centralStatistic` / `intervalKind`.
 */
describe('conversation ingestion — the reported statistic on an ordinary parameter', () => {
  function halfLifeItem(statistic: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return {
      type: 'parameter_observation',
      target: { drugName: 'Morphine', pubchemCid: 5288826 },
      parameter: 'halfLife',
      low: 2.2,
      high: 3.4,
      unit: 'h',
      n: 10,
      sourceKey: 'S1',
      context: { population: 'friske frivillige', derivation: { kind: 'reported' } },
      doseContext: statistic,
      quote: 'Terminal half-life was 2.8 ± 0.6 h (mean ± SD).',
      editSummary: 'Halveringstid for morfin.',
      ...over,
    };
  }

  it('stores a labelled mean ± SD', async () => {
    const item = halfLifeItem({
      centralValue: 2.8,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
    });
    const result = await applyIngestion(parse(bundle([item])), { userId, accept: [0] });
    expect(result.counts).toMatchObject({ applied: 1, failed: 0 });

    const [entry] = await listEntriesForDrug(morphine, 'halfLife');
    expect(entry).toMatchObject({ low: 2.2, high: 3.4, median: null });
    expect(entry!.doseContext).toMatchObject({
      centralValue: 2.8,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
      administeredDrugId: null,
    });
  });

  // Codex on #1452: the admin gate previews `plan.reading`; a labelled centre
  // must appear there in stored form, or an admin publishes a mean unseen.
  it('previews the labelled centre, statistic and interval kind in stored form', async () => {
    const labelled = await planIngestion(
      parse(bundle([halfLifeItem({ centralValue: 2.8, centralStatistic: 'arithmetic_mean', intervalKind: 'sd' })])),
    );
    expect(labelled.items[0]).toMatchObject({
      reading: { low: 2.2, high: 3.4, centralValue: 2.8, centralStatistic: 'arithmetic_mean', intervalKind: 'sd' },
    });
    const shorthand = await planIngestion(
      parse(bundle([halfLifeItem({ intervalKind: 'range' }, { median: 2.8 })])),
    );
    expect(shorthand.items[0]).toMatchObject({
      reading: { centralValue: 2.8, centralStatistic: 'median', intervalKind: 'range' },
    });
    expect((shorthand.items[0] as { reading: { median?: number } }).reading.median).toBeUndefined();
  });

  it('folds a labelled median shorthand, and a re-run finds the row it wrote', async () => {
    const item = halfLifeItem({ intervalKind: 'range' }, { median: 2.8 });
    const first = await applyIngestion(parse(bundle([item])), { userId, accept: [0] });
    expect(first.counts).toMatchObject({ applied: 1, failed: 0 });
    const second = await applyIngestion(parse(bundle([item])), { userId, accept: [0] });
    expect(second.counts).toMatchObject({ applied: 0, failed: 0 });

    const entries = await listEntriesForDrug(morphine, 'halfLife');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.median).toBeNull();
    expect(entries[0]!.doseContext).toMatchObject({
      centralValue: 2.8,
      centralStatistic: 'median',
      intervalKind: 'range',
    });
  });

  it('still refuses a dose field on it', () => {
    const parsed = parseConversationIngestion(
      bundle([halfLifeItem({ centralValue: 2.8, centralStatistic: 'median', doseValue: 10, doseUnit: 'mg' })]),
    );
    expect(parsed.ok).toBe(false);
  });
});
