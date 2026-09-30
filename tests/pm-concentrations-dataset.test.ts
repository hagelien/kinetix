/**
 * The PM concentration dataset validator, exercised against a SYNTHETIC
 * fixture. The real dataset is unpublished and kept outside the repository;
 * every analyte, CID, number and citation in
 * `tests/fixtures/pm-concentrations-synthetic.json` is invented, shaped like a
 * real transcription so the same rules are tested on the same kinds of rows.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadPmConcentrationDataset,
  parsePmConcentrationDataset,
  type PmConcentrationRow,
} from '../scripts/pm-concentrations/dataset';
import { PM_STATISTIC_IDS } from '../src/lib/pmConcentrations';

const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures/pm-concentrations-synthetic.json',
);

const dataset = loadPmConcentrationDataset(FIXTURE_PATH);

/** A well-formed synthetic row, for the negative cases to deviate from. */
function row(overrides: Partial<PmConcentrationRow> = {}): PmConcentrationRow {
  return {
    analyte: 'Fictazepam',
    pubchemCid: 990001,
    pubchemName: 'Fictazepam',
    molecularWeight: 250,
    n: 1200,
    loq: 0.05,
    mean: 0.3,
    median: 0.125,
    p90: 0.5,
    p95: 0.75,
    p975: 1,
    tcPlasma: 1.5,
    medianOverTc: 0.08,
    ...overrides,
  } as PmConcentrationRow;
}

function withEntries(entries: PmConcentrationRow[]) {
  return { ...dataset, entries };
}

describe('loading a dataset file', () => {
  it('has no default path: the dataset is kept outside the repository', () => {
    expect(() => loadPmConcentrationDataset('')).toThrow(
      /No PM concentration dataset file given/,
    );
  });
});

describe('the synthetic fixture dataset', () => {
  it('holds all 5 analytes with a resolved CID each', () => {
    expect(dataset.entries).toHaveLength(5);
    for (const entry of dataset.entries) {
      expect(entry.pubchemCid).toBeGreaterThan(0);
      expect(entry.pubchemName.length).toBeGreaterThan(0);
    }
  });

  it('maps each analyte to a distinct substance', () => {
    const cids = dataset.entries.map((e) => e.pubchemCid);
    expect(new Set(cids).size).toBe(cids.length);
  });

  it('is postmortem whole blood in mg/L, under the source\'s own heading', () => {
    // The heading is what stops a percentile being read as a lethal
    // threshold, and it is rendered verbatim wherever the numbers appear.
    expect(dataset.study.heading).toBe('Syntetiske postmortale testdata');
    expect(dataset.study.unit).toBe('mg/L');
    expect(dataset.study.matrix).toBe('postmortem_femoral_blood');
  });

  it('carries the source citation verbatim', () => {
    expect(dataset.source.citation).toBe(
      'Syntetisk testkohort, oppdiktede tall (kun for tester)',
    );
    expect(dataset.source.published).toBe(false);
  });

  it('carries the printed anomalies rather than corrected numbers', () => {
    const placebolol = dataset.entries.find(
      (e) => e.analyte === 'Placebolol',
    )!;
    // The printed value stands; only its use as a chart line is withheld.
    expect(placebolol.p90).toBe(12);
    expect(placebolol.undrawable).toEqual(['p90']);
    expect(placebolol.anomaly).toMatch(/trykkfeil/);

    const examplezine = dataset.entries.find(
      (e) => e.analyte === 'Examplezine',
    )!;
    expect(examplezine.mean).toBe(0);
    expect(examplezine.undrawable).toEqual(['mean']);
  });

  it('leaves TC blank where the source printed no comparison value', () => {
    const nullacid = dataset.entries.find((e) =>
      e.analyte.startsWith('Nullacid'),
    )!;
    expect(nullacid.tcPlasma).toBeNull();
    expect(nullacid.medianOverTc).toBeNull();
    // The percentiles are still there — a missing TC is not a missing row.
    expect(nullacid.p95).toBeGreaterThan(0);
  });

  it('keeps printed strings, a blank LOQ and review notes as transcribed', () => {
    const mockamine = dataset.entries.find((e) =>
      e.analyte.startsWith('Mockamine'),
    )!;
    // `0.20` parses to 0.2; the printed form keeps the source's precision.
    expect(mockamine.p975).toBe(0.2);
    expect(mockamine.printed).toEqual({ p975: '0.20' });
    expect(mockamine.loq).toBeNull();
    expect(mockamine.displayName).toBe('Hydroxymockamine');
    expect(mockamine.reviewNote).toMatch(/ubekreftet/);
  });

  it('keeps every undrawable id inside the statistic registry', () => {
    for (const entry of dataset.entries) {
      for (const stat of entry.undrawable ?? []) {
        expect(PM_STATISTIC_IDS).toContain(stat);
      }
    }
  });
});

describe('dataset validation', () => {
  it('rejects a percentile ladder that runs backwards', () => {
    // The one automatic check that catches a mistyped digit in a long table.
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([row({ p90: 5, p95: 0.75, p975: 1 })]),
      ),
    ).toThrow(/p90 \(5\) exceeds p95/);
  });

  it('accepts an out-of-order ladder that declares itself', () => {
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([
          row({
            p90: 5,
            anomaly: 'trykkfeil i kildetabellen',
            undrawable: ['p90'],
          }),
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an unrelated statistic standing in for the offending one', () => {
    // `undrawable: ['mean']` says nothing about a reversed p90/p95 pair. If
    // this passed, the mistyped reference line would still be drawn.
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([
          row({
            p90: 5,
            mean: 0,
            anomaly: 'gjennomsnittet er avrundet til null',
            undrawable: ['mean'],
          }),
        ]),
      ),
    ).toThrow(/list p90 or p95 in `undrawable`/);
  });

  it('accepts withholding either side of the offending comparison', () => {
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([
          row({ p90: 5, anomaly: 'trykkfeil', undrawable: ['p95'] }),
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects `undrawable` with no explanation', () => {
    expect(() =>
      parsePmConcentrationDataset(withEntries([row({ undrawable: ['p90'] })])),
    ).toThrow(/needs an `anomaly`/);
  });

  it('rejects `undrawable` naming a statistic the row does not have', () => {
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([
          row({ p95: null, anomaly: 'noe', undrawable: ['p95'] }),
        ]),
      ),
    ).toThrow(/which has no value/);
  });

  it('rejects an undeclared zero', () => {
    // A printed 0.00 is a rounded reading. Left undeclared it would become a
    // chart line at the axis floor and a "0" in the table with no explanation.
    expect(() =>
      parsePmConcentrationDataset(withEntries([row({ mean: 0 })])),
    ).toThrow(/is 0\. A printed 0 is a rounded reading/);
  });

  it('rejects two rows for the same substance', () => {
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([row(), row({ analyte: 'Fictazepam (again)' })]),
      ),
    ).toThrow(/Duplicate pubchemCid/);
  });

  it('rejects a duplicate analyte name', () => {
    expect(() =>
      parsePmConcentrationDataset(
        withEntries([row(), row({ pubchemCid: 990099 })]),
      ),
    ).toThrow(/Duplicate analyte/);
  });

  it('rejects a negative measurement', () => {
    expect(() =>
      parsePmConcentrationDataset(withEntries([row({ median: -1 })])),
    ).toThrow();
  });
});
