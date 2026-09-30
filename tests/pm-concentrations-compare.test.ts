/**
 * The seeder's "has this row changed?" check.
 *
 * A false negative here is invisible in the data — the row is rewritten with
 * the values it already had — but it destroys the only signal an operator has
 * that a re-run against forensic material changed something. The first real
 * seed reported a sizeable share of its rows updated on every run, forever,
 * and nothing about the stored numbers was wrong.
 *
 * Every row here is synthetic: invented analytes, CIDs and values.
 */
import { describe, expect, it } from 'vitest';
import {
  findAbsentAnalytes,
  samePrinted,
  storedRowMatches,
  type StoredRow,
} from '../scripts/pm-concentrations/compare';
import type { PmConcentrationRow } from '../scripts/pm-concentrations/dataset';

function datasetRow(
  overrides: Partial<PmConcentrationRow> = {},
): PmConcentrationRow {
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
    printed: { p975: '1.0', tcPlasma: '1.50' },
    ...overrides,
  } as PmConcentrationRow;
}

/** What the database hands back for `datasetRow()`. */
function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    analyte: 'Fictazepam',
    n: 1200,
    // `numeric(14,6)` — read back padded, never as written.
    loq: '0.050000',
    mean: '0.300000',
    median: '0.125000',
    p90: '0.500000',
    p95: '0.750000',
    p975: '1.000000',
    tcPlasma: '1.500000',
    medianOverTc: '0.080000',
    anomaly: null,
    undrawable: [],
    reviewNote: null,
    // jsonb key order, which is NOT the order the seeder wrote.
    printed: { p975: '1.0', tcPlasma: '1.50' },
    ...overrides,
  };
}

describe('storedRowMatches', () => {
  it('sees no change in a row it just wrote', () => {
    expect(storedRowMatches(storedRow(), datasetRow())).toBe(true);
  });

  it('ignores jsonb key order in `printed`', () => {
    // Postgres normalizes a jsonb object's keys (shortest first, then
    // bytewise), so the map never comes back in the order it went in. Comparing
    // serializations reported every multi-key row as changed on every run.
    const stored = storedRow({
      printed: { loq: '0.050', p90: '0.50', p95: '0.750', median: '0.1250' },
    });
    const row = datasetRow({
      printed: { loq: '0.050', median: '0.1250', p90: '0.50', p95: '0.750' },
    });
    expect(storedRowMatches(stored, row)).toBe(true);
  });

  it('still sees a changed printed value', () => {
    const stored = storedRow({ printed: { p975: '1.0', tcPlasma: '1.50' } });
    expect(
      storedRowMatches(
        stored,
        datasetRow({ printed: { p975: '1', tcPlasma: '1.50' } }),
      ),
    ).toBe(false);
  });

  it('still sees a printed entry that was added or dropped', () => {
    expect(
      storedRowMatches(storedRow(), datasetRow({ printed: { p975: '1.0' } })),
    ).toBe(false);
    expect(
      storedRowMatches(
        storedRow({ printed: { p975: '1.0' } }),
        datasetRow(),
      ),
    ).toBe(false);
  });

  it('compares numerics as numbers, not as the padded strings they arrive as', () => {
    expect(storedRowMatches(storedRow({ median: '0.125' }), datasetRow())).toBe(
      true,
    );
    expect(
      storedRowMatches(storedRow({ median: '0.126000' }), datasetRow()),
    ).toBe(false);
  });

  it('treats a null and a zero as different', () => {
    expect(
      storedRowMatches(storedRow({ mean: null }), datasetRow({ mean: 0 })),
    ).toBe(false);
  });

  it('sees a corrected transcription', () => {
    expect(storedRowMatches(storedRow(), datasetRow({ p95: 0.76 }))).toBe(false);
    expect(storedRowMatches(storedRow(), datasetRow({ n: 1201 }))).toBe(false);
  });

  it('sees a newly withheld statistic', () => {
    // `undrawable` is what stops a mistyped percentile becoming a chart line;
    // a re-run that adds one must not be reported as "Same".
    expect(
      storedRowMatches(
        storedRow(),
        datasetRow({ anomaly: 'trykkfeil', undrawable: ['p90'] }),
      ),
    ).toBe(false);
  });

  it('keeps array order significant in `undrawable`', () => {
    // Unlike a jsonb object, a jsonb array preserves order — so a differing
    // order is a real difference, not a storage artefact.
    expect(
      storedRowMatches(
        storedRow({ undrawable: ['p90', 'p95'], anomaly: 'x' }),
        datasetRow({ undrawable: ['p95', 'p90'], anomaly: 'x' }),
      ),
    ).toBe(false);
  });
});

describe('findAbsentAnalytes', () => {
  const entries = [
    datasetRow({ analyte: 'Fictazepam', pubchemCid: 990001 }),
    datasetRow({ analyte: 'Placebolol', pubchemCid: 990002 }),
  ];

  it('is silent when the cohort holds every analyte', () => {
    const drugIds = new Map([
      [990001, 11],
      [990002, 22],
    ]);
    expect(findAbsentAnalytes(entries, drugIds, new Set([11, 22]))).toEqual([]);
  });

  it('names an analyte whose row was removed after the write', () => {
    // The first-production-seed case: the row was committed, then a queued
    // drug deletion cascaded it away. Nothing about the write reported a
    // problem.
    const drugIds = new Map([
      [990001, 11],
      [990002, 22],
    ]);
    expect(findAbsentAnalytes(entries, drugIds, new Set([11]))).toEqual([
      'Placebolol (CID 990002)',
    ]);
  });

  it('stays quiet about an analyte that resolved to no drug at all', () => {
    // Reported separately as `missing` under --no-create-drugs. Listing it here
    // too would describe one gap twice and make the run look worse than it is.
    const drugIds = new Map([[990001, 11]]);
    expect(findAbsentAnalytes(entries, drugIds, new Set([11]))).toEqual([]);
  });
});

describe('samePrinted', () => {
  it('treats absent, null and empty as the same', () => {
    expect(samePrinted(null, undefined)).toBe(true);
    expect(samePrinted({}, undefined)).toBe(true);
    expect(samePrinted(null, {})).toBe(true);
  });

  it('does not report a match on key count alone', () => {
    expect(samePrinted({ p90: '1' }, { p95: '1' })).toBe(false);
  });
});
