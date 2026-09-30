import { describe, expect, it } from 'vitest';
import { metabolismWriteSchema } from '../../api/_lib/schemas';
import { toMetabolismWriteInput } from '../../api/_lib/metabolismStore';

describe('metabolismWriteSchema', () => {
  it('fills defaults for an empty payload', () => {
    const r = metabolismWriteSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.routes).toEqual([]);
      expect(r.data.metabolites).toEqual([]);
      expect(r.data.precursors).toEqual([]);
      expect(r.data.profile).toEqual({});
    }
  });

  it('accepts a full metabolism box', () => {
    const r = metabolismWriteSchema.safeParse({
      profile: { evidenceNote: 'primarily hepatic' },
      routes: [
        { kind: 'enzyme', enzymeId: 9, label: 'CYP3A4', fraction: 0.8 },
        { kind: 'renal_unchanged', fraction: 0.05 },
        { kind: 'other_unchanged', label: 'sweat' },
      ],
      metabolites: [
        {
          metaboliteName: 'Nordiazepam',
          metaboliteDrugId: 42,
          conversionFraction: 0.3,
          activity: 'active',
        },
      ],
      precursors: [{ precursorDrugId: 7, activity: 'unknown' }],
      editSummary: 'add primary metabolite',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.routes[0]?.kind).toBe('enzyme');
      expect(r.data.routes[0]?.enzymeId).toBe(9);
      expect(r.data.metabolites[0]?.activity).toBe('active');
      // activity defaults to 'unknown' when omitted
      const r2 = metabolismWriteSchema.safeParse({
        metabolites: [{ metaboliteName: 'X' }],
      });
      expect(r2.success).toBe(true);
      if (r2.success) expect(r2.data.metabolites[0]?.activity).toBe('unknown');
    }
  });

  it('rejects fractions outside 0–1, bad route kinds, and empty names', () => {
    expect(
      metabolismWriteSchema.safeParse({
        routes: [{ kind: 'renal_unchanged', fraction: 1.5 }],
      }).success,
    ).toBe(false);
    expect(
      metabolismWriteSchema.safeParse({
        routes: [{ kind: 'not_a_kind' }],
      }).success,
    ).toBe(false);
    expect(
      metabolismWriteSchema.safeParse({
        metabolites: [{ metaboliteName: '' }],
      }).success,
    ).toBe(false);
    expect(
      metabolismWriteSchema.safeParse({
        precursors: [{ precursorDrugId: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe('toMetabolismWriteInput', () => {
  it('drops the display-only precursorName when building the write input', () => {
    const parsed = metabolismWriteSchema.parse({
      precursors: [
        { precursorDrugId: 9, precursorName: 'Diazepam', activity: 'active' },
      ],
    });
    const input = toMetabolismWriteInput(parsed);
    expect(input.precursors).toEqual([
      {
        precursorDrugId: 9,
        conversionFraction: undefined,
        activity: 'active',
        evidenceNote: undefined,
        referenceIds: undefined,
      },
    ]);
    expect(
      (input.precursors[0] as Record<string, unknown>).precursorName,
    ).toBeUndefined();
  });

  it('maps elimination routes through unchanged', () => {
    const parsed = metabolismWriteSchema.parse({
      routes: [{ kind: 'enzyme', enzymeId: 3, label: 'ADH', fraction: 0.9 }],
    });
    const input = toMetabolismWriteInput(parsed);
    expect(input.routes).toEqual([
      {
        kind: 'enzyme',
        enzymeId: 3,
        label: 'ADH',
        // A bare scalar becomes the median of a point range.
        fraction: { min: null, median: 0.9, max: null },
        note: undefined,
        referenceIds: undefined,
      },
    ]);
  });
});

describe('metabolism fraction ranges', () => {
  it('accepts a min/median/max range on a metabolite', () => {
    const r = metabolismWriteSchema.safeParse({
      metabolites: [
        {
          metaboliteName: 'Y',
          conversionFraction: { min: 0.3, max: 0.4 },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.metabolites[0]?.conversionFraction).toEqual({
        min: 0.3,
        median: null,
        max: 0.4,
      });
    }
  });

  it('folds a `mean` into `median` when no median is given', () => {
    const r = metabolismWriteSchema.parse({
      routes: [{ kind: 'renal_unchanged', fraction: { mean: 0.2 } }],
    });
    expect(r.routes[0]?.fraction).toEqual({ min: null, median: 0.2, max: null });
  });

  it('normalizes a bare scalar to a point range', () => {
    const r = metabolismWriteSchema.parse({
      metabolites: [{ metaboliteName: 'Y', conversionFraction: 0.25 }],
    });
    expect(r.metabolites[0]?.conversionFraction).toEqual({
      min: null,
      median: 0.25,
      max: null,
    });
  });

  it('rejects an out-of-order range (min > max)', () => {
    expect(
      metabolismWriteSchema.safeParse({
        metabolites: [
          { metaboliteName: 'Y', conversionFraction: { min: 0.5, max: 0.4 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a median outside its bounds', () => {
    expect(
      metabolismWriteSchema.safeParse({
        routes: [
          { kind: 'enzyme', fraction: { min: 0.1, median: 0.9, max: 0.2 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a range bound above 1', () => {
    expect(
      metabolismWriteSchema.safeParse({
        routes: [{ kind: 'enzyme', fraction: { min: 0.5, max: 1.5 } }],
      }).success,
    ).toBe(false);
  });
});
