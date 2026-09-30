import { describe, it, expect } from 'vitest';
import {
  buildSimulatorReferenceRange,
  buildSimulatorReferenceRangeFromParameters,
} from './referenceConcentrationsOverlay';
import type { ReferenceConcentrationRow } from './referenceConcentrationsApi';

function row(
  partial: Partial<ReferenceConcentrationRow> & {
    scenario: ReferenceConcentrationRow['scenario'];
    matrix: ReferenceConcentrationRow['matrix'];
    unit: ReferenceConcentrationRow['unit'];
  },
  id = 1,
): ReferenceConcentrationRow {
  return {
    id,
    drugId: 1,
    low: null,
    high: null,
    n: null,
    comments: null,
    citationId: null,
    citation: null,
    createdBy: null,
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...partial,
  };
}

describe('buildSimulatorReferenceRange', () => {
  it('buckets scenarios into therapeutic/toxic/lethal', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 10, high: 20 }, 1),
      row({ scenario: 'living_toxic', matrix: 'whole_blood', unit: 'ng/mL', low: 50 }, 2),
      row({ scenario: 'living_dui', matrix: 'whole_blood', unit: 'ng/mL', low: 40 }, 3),
      row({ scenario: 'postmortem_mono_intox', matrix: 'whole_blood', unit: 'ng/mL', low: 500 }, 4),
    ];

    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');

    expect(out.therapeutic).toEqual({ min: 10, max: 20 });
    // living_toxic + living_dui both bucket to toxic, take min of lows
    expect(out.toxic).toEqual({ min: 40 });
    expect(out.lethal).toEqual({ min: 500 });
  });

  it('skips scenarios that do not map to a bucket', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'postmortem_non_intox', matrix: 'whole_blood', unit: 'ng/mL', low: 1, high: 5 }),
      row({ scenario: 'case_report', matrix: 'whole_blood', unit: 'ng/mL', low: 1, high: 5 }, 2),
      row({ scenario: 'case_series', matrix: 'whole_blood', unit: 'ng/mL', low: 1, high: 5 }, 3),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');
    expect(out).toEqual({});
  });

  it('skips rows with non-blood matrices (urine, vitreous, hair)', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'urine', unit: 'ng/mL', low: 10, high: 20 }, 1),
      row({ scenario: 'living_therapeutic', matrix: 'hair', unit: 'ng/mL', low: 10, high: 20 }, 2),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');
    expect(out).toEqual({});
  });

  it('converts serum -> whole blood using bloodPlasmaRatio', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'serum', unit: 'ng/mL', low: 100, high: 200 }),
    ];
    // ratio = 0.5 means blood = 0.5 * serum
    const out = buildSimulatorReferenceRange(
      rows,
      { bloodPlasmaRatio: 0.5 },
      'ng/mL',
    );
    expect(out.therapeutic).toEqual({ min: 50, max: 100 });
  });

  it('defaults bloodPlasmaRatio to 1 when missing', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'serum', unit: 'ng/mL', low: 100 }),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');
    expect(out.therapeutic?.min).toBeCloseTo(100, 10);
  });

  it('converts units to the simulator target (ng/mL -> mg/L)', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 1000, high: 2000 }),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'mg/L');
    // 1000 ng/mL = 1 mg/L
    expect(out.therapeutic?.min).toBeCloseTo(1, 10);
    expect(out.therapeutic?.max).toBeCloseTo(2, 10);
  });

  it('skips molar rows on a drug with no molecular weight', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'nmol/L', low: 10 }),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');
    expect(out).toEqual({});
  });

  it('converts molar -> mass when molecularWeight is present', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'µmol/L', low: 1 }),
    ];
    const out = buildSimulatorReferenceRange(
      rows,
      { molecularWeight: 300 },
      'ng/mL',
    );
    // 1 µmol/L × 300 g/mol = 300 µg/L = 0.3 µg/mL = 300 ng/mL
    expect(out.therapeutic?.min).toBeCloseTo(300, 6);
  });

  it('merges multiple rows per bucket with min(low) / max(high)', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 10, high: 30 }, 1),
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 20, high: 40 }, 2),
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 5 }, 3),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'ng/mL');
    expect(out.therapeutic).toEqual({ min: 5, max: 40 });
  });

  it('uses bloodPlasmaRatio.value when bpr is a NumericRange', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'plasma', unit: 'ng/mL', low: 100 }),
    ];
    const out = buildSimulatorReferenceRange(
      rows,
      { bloodPlasmaRatio: { median: 0.7 } },
      'ng/mL',
    );
    expect(out.therapeutic?.min).toBeCloseTo(70, 10);
  });

  it('returns {} for unknown target units', () => {
    const rows: ReferenceConcentrationRow[] = [
      row({ scenario: 'living_therapeutic', matrix: 'whole_blood', unit: 'ng/mL', low: 10 }),
    ];
    const out = buildSimulatorReferenceRange(rows, {}, 'bogus/unit');
    expect(out).toEqual({});
  });
});

describe('buildSimulatorReferenceRangeFromParameters', () => {
  it('maps reviewed concentration parameters to simulator buckets', () => {
    const out = buildSimulatorReferenceRangeFromParameters(
      {
        therapeuticConcentration: { min: 1000, max: 2000, unit: 'ng/mL' },
        impairmentConcentration: { min: 1500, unit: 'ng/mL' },
        toxicConcentration: { min: 3000, unit: 'ng/mL' },
        fatalConcentration: { median: 10000, unit: 'ng/mL' },
      },
      'mg/L',
    );

    expect(out.therapeutic?.min).toBeCloseTo(1, 10);
    expect(out.therapeutic?.max).toBeCloseTo(2, 10);
    expect(out.toxic?.min).toBeCloseTo(1.5, 10);
    expect(out.lethal?.min).toBeCloseTo(10, 10);
    expect(out.lethal?.max).toBeCloseTo(10, 10);
  });

  it('skips parameter ranges that cannot be converted', () => {
    const out = buildSimulatorReferenceRangeFromParameters(
      {
        therapeuticConcentration: { min: 1, unit: 'nmol/L' },
      },
      'ng/mL',
    );

    expect(out).toEqual({});
  });
});
