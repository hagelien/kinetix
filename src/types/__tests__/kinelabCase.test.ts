import { describe, it, expect } from 'vitest';
import {
  KINELAB_CASE_KIND,
  isKinelabCaseData,
  kinelabCaseDataSchema,
} from '@/types/kinelabCase';

const VALID_CASE_DATA = {
  kind: KINELAB_CASE_KIND,
  schemaVersion: 1 as const,
  input: {
    modelId: 'ketamine-one-comp-v0',
    analyte: 'ketamine',
    route: 'oral' as const,
    observations: [
      {
        id: 'obs-1',
        analyte: 'ketamine',
        concentration: { value: 0.2, unit: 'mg/L' as const },
        matrix: 'whole_blood' as const,
        sampleTime: '2030-01-01T03:00:00.000Z',
        assay: { uncertaintyCV: 0.15 },
      },
    ],
    priors: {
      dose: { type: 'uniform' as const, min: 20, max: 500 },
      halfLife: { type: 'fixed' as const, value: 2.5 },
      vd: { type: 'fixed' as const, value: 210 },
      f: { type: 'fixed' as const, value: 0.2 },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: '2030-01-01T00:00:00.000Z',
        latestIso: '2030-01-01T02:00:00.000Z',
      },
    },
    defaultAssayCV: 0.15,
    gridResolution: 40,
    drawCount: 4000,
    seed: 42,
  },
};

describe('kinelabCaseDataSchema', () => {
  it('accepts a well-formed case', () => {
    const parsed = kinelabCaseDataSchema.parse(VALID_CASE_DATA);
    expect(parsed.kind).toBe(KINELAB_CASE_KIND);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('rejects a case with the wrong kind discriminator', () => {
    const wrong = { ...VALID_CASE_DATA, kind: 'something-else' };
    expect(() => kinelabCaseDataSchema.parse(wrong)).toThrow();
  });

  it('rejects a case with a future schema version we do not understand', () => {
    const future = { ...VALID_CASE_DATA, schemaVersion: 2 };
    expect(() => kinelabCaseDataSchema.parse(future)).toThrow();
  });

  it('rejects a case with no observations', () => {
    const broken = {
      ...VALID_CASE_DATA,
      input: { ...VALID_CASE_DATA.input, observations: [] },
    };
    expect(() => kinelabCaseDataSchema.parse(broken)).toThrow();
  });

  it('round-trips effectiveSampleSize on the diagnostics object', () => {
    // Regression: PR #232 codex P2. Saved cases need to carry ESS so the
    // diagnostics line stays accurate after reload.
    const withResult = {
      ...VALID_CASE_DATA,
      result: {
        engine: 'lite-browser' as const,
        modelIds: ['ketamine-one-comp-v0'],
        posteriorSummary: { intervals: {} },
        diagnostics: {
          engine: 'lite-browser' as const,
          method: 'monte-carlo-importance-sampling',
          sampleCount: 3870,
          effectiveSampleSize: 1234.5,
          warnings: [],
        },
        assumptions: [],
        limitations: [],
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const parsed = kinelabCaseDataSchema.parse(withResult);
    expect(parsed.result?.diagnostics.effectiveSampleSize).toBeCloseTo(1234.5, 6);
  });

  it('still accepts legacy cases that lack effectiveSampleSize', () => {
    const legacy = {
      ...VALID_CASE_DATA,
      result: {
        engine: 'lite-browser' as const,
        modelIds: ['ketamine-one-comp-v0'],
        posteriorSummary: { intervals: {} },
        diagnostics: {
          engine: 'lite-browser' as const,
          method: 'monte-carlo-importance-sampling',
          sampleCount: 3870,
          warnings: [],
        },
        assumptions: [],
        limitations: [],
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const parsed = kinelabCaseDataSchema.parse(legacy);
    expect(parsed.result?.diagnostics.effectiveSampleSize).toBeUndefined();
  });
});

describe('isKinelabCaseData', () => {
  it('matches an object with the right kind', () => {
    expect(isKinelabCaseData({ kind: KINELAB_CASE_KIND })).toBe(true);
  });
  it('rejects unrelated values', () => {
    expect(isKinelabCaseData(null)).toBe(false);
    expect(isKinelabCaseData(undefined)).toBe(false);
    expect(isKinelabCaseData({ kind: 'forward-sim' })).toBe(false);
    // Drug catalog cases (existing simulator format) must NOT match.
    expect(isKinelabCaseData({ drugs: [], displaySettings: {} })).toBe(false);
  });
});
