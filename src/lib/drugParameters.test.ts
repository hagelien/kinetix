import { describe, expect, it } from 'vitest';
import {
  DRUG_PARAMETERS,
  DRUG_PARAMETER_IDS,
  METADATA_PARAMETER_IDS,
  PARAMETER_GROUPS,
  PARAMETER_GROUP_IDS,
  SUMMARIZED_PARAMETER_IDS,
  VISIBLE_PARAMETER_IDS,
  getNonEmptyParameterGroups,
  getParameterSpec,
  getParametersInGroup,
  getRangeSpec,
  isParameterGroupId,
  isRangeSpec,
  parameterIsAlreadyLogarithmic,
  parameterIsMatrixRelevant,
  parameterIsScenarioRelevant,
  parameterIsSummarizable,
  parameterRequiresReference,
} from './drugParameters';
import { DRUG_PARAMETER_IDS as API_DRUG_PARAMETER_IDS } from '../../api/_lib/drugParameterIds';

describe('API parameter id mirror stays in sync', () => {
  // The api/_lib/drugParameterIds.ts mirror is intentionally maintained
  // by hand (kept free of zod/frontend imports) — assert here so a
  // future PR that registers a parameter only on the frontend doesn't
  // silently break /api/drug-parameter validation, pending-edit
  // approval, history/discussion endpoints, or priority flags.
  it('matches the canonical DRUG_PARAMETER_IDS in src/lib', () => {
    expect([...API_DRUG_PARAMETER_IDS]).toEqual([...DRUG_PARAMETER_IDS]);
  });
});

describe('drug metadata parameters', () => {
  it('exposes the editable metadata fields', () => {
    expect(METADATA_PARAMETER_IDS).toEqual([
      'nameNb',
      'nameEn',
      'nameShort',
      'aliases',
      'molecularWeight',
      'pubchemCid',
    ]);
  });

  it('keeps PK params in VISIBLE_PARAMETER_IDS and excludes metadata', () => {
    for (const pid of VISIBLE_PARAMETER_IDS) {
      expect(METADATA_PARAMETER_IDS).not.toContain(pid);
    }
    expect(VISIBLE_PARAMETER_IDS).toContain('halfLife');
    expect(VISIBLE_PARAMETER_IDS).toContain('pKa');
  });

  describe('nameNb (Norwegian, optional)', () => {
    const spec = DRUG_PARAMETERS.nameNb;

    it('accepts empty strings (clearing the field is valid; required-state is enforced against the names jsonb)', () => {
      expect(spec.zod.safeParse('').success).toBe(true);
      expect(spec.zod.safeParse('   ').success).toBe(true);
    });

    it('accepts a normal name and trims whitespace', () => {
      const parsed = spec.zod.safeParse('  Paracetamol  ');
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toBe('Paracetamol');
    });

    it('rejects names longer than 300 characters', () => {
      expect(spec.zod.safeParse('x'.repeat(301)).success).toBe(false);
      expect(spec.zod.safeParse('x'.repeat(300)).success).toBe(true);
    });
  });

  describe('aliases (list)', () => {
    const spec = DRUG_PARAMETERS.aliases;

    it('accepts an empty array and arrays of strings', () => {
      expect(spec.zod.safeParse([]).success).toBe(true);
      expect(spec.zod.safeParse(['Xanax', 'blue football']).success).toBe(true);
    });

    it('rejects arrays with too many entries', () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `alias${i}`);
      expect(spec.zod.safeParse(tooMany).success).toBe(false);
    });

    it('formats as a comma-separated string', () => {
      expect(spec.format(['Xanax', 'Helex'])).toBe('Xanax, Helex');
      expect(spec.format(null)).toBe('');
    });
  });

  describe('nameShort (optional)', () => {
    const spec = DRUG_PARAMETERS.nameShort;

    it('accepts empty strings (clearing the field)', () => {
      expect(spec.zod.safeParse('').success).toBe(true);
    });

    it('rejects values longer than 50 characters', () => {
      expect(spec.zod.safeParse('y'.repeat(51)).success).toBe(false);
    });
  });

  describe('molecularWeight (number)', () => {
    const spec = DRUG_PARAMETERS.molecularWeight;

    it('accepts positive finite numbers within bounds', () => {
      expect(spec.zod.safeParse(151.16).success).toBe(true);
      expect(spec.zod.safeParse(0.5).success).toBe(true);
    });

    it('rejects zero, negatives, and NaN', () => {
      expect(spec.zod.safeParse(0).success).toBe(false);
      expect(spec.zod.safeParse(-1).success).toBe(false);
      expect(spec.zod.safeParse(NaN).success).toBe(false);
    });

    it('formats with the g/mol unit', () => {
      expect(spec.format(151.16)).toBe('151.16 g/mol');
      expect(spec.format(null)).toBe('');
    });
  });

  describe('pubchemCid (integer, unique)', () => {
    const spec = DRUG_PARAMETERS.pubchemCid;

    it('rejects non-integer numbers', () => {
      expect(spec.zod.safeParse(1.5).success).toBe(false);
      expect(spec.zod.safeParse(2244).success).toBe(true);
    });

    it('formats without a trailing unit', () => {
      expect(spec.format(2244)).toBe('2244');
    });
  });

  describe('parameterRequiresReference', () => {
    it('exempts every editable metadata field (names, aliases, MW, PubChem CID)', () => {
      for (const pid of METADATA_PARAMETER_IDS) {
        expect(parameterRequiresReference(pid)).toBe(false);
      }
      // Spot-check the user-facing list explicitly so a future metadata
      // addition can't silently start demanding a citation.
      expect(parameterRequiresReference('nameNb')).toBe(false);
      expect(parameterRequiresReference('nameEn')).toBe(false);
      expect(parameterRequiresReference('nameShort')).toBe(false);
      expect(parameterRequiresReference('aliases')).toBe(false);
      expect(parameterRequiresReference('molecularWeight')).toBe(false);
      expect(parameterRequiresReference('pubchemCid')).toBe(false);
    });

    it('requires a reference for pharmacokinetic parameters', () => {
      expect(parameterRequiresReference('halfLife')).toBe(true);
      expect(parameterRequiresReference('pKa')).toBe(true);
      expect(parameterRequiresReference('clearance')).toBe(true);
      for (const pid of VISIBLE_PARAMETER_IDS) {
        expect(parameterRequiresReference(pid)).toBe(true);
      }
    });

  });

  describe('isRangeSpec / getRangeSpec', () => {
    it('returns true for PK params and false for metadata', () => {
      expect(isRangeSpec(DRUG_PARAMETERS.halfLife)).toBe(true);
      expect(isRangeSpec(DRUG_PARAMETERS.pKa)).toBe(true);
      expect(isRangeSpec(DRUG_PARAMETERS.nameNb)).toBe(false);
      expect(isRangeSpec(DRUG_PARAMETERS.aliases)).toBe(false);
      expect(isRangeSpec(DRUG_PARAMETERS.molecularWeight)).toBe(false);
    });

    it('throws when getRangeSpec is called on a metadata id', () => {
      expect(() => getRangeSpec('molecularWeight')).toThrow();
      expect(() => getRangeSpec('halfLife')).not.toThrow();
    });
  });

  describe('canonical unit leads allowedUnits', () => {
    it('holds for every range parameter that has units', () => {
      // `rangeSchema` reads the canonical unit off the front of the allow-list
      // rather than taking it as a 26th-call-site parameter, and uses it to
      // canonicalize a value before bounding it. If a spec ever listed its
      // units in another order the schema would bound against the wrong unit —
      // silently, and in whichever direction that unit's factor points.
      for (const id of DRUG_PARAMETER_IDS) {
        const spec = DRUG_PARAMETERS[id];
        if (!isRangeSpec(spec) || spec.allowedUnits.length === 0) continue;
        expect(spec.allowedUnits[0], `${id} allowedUnits[0]`).toBe(spec.canonicalUnit);
      }
    });
  });

  describe('bounds are applied in the canonical unit', () => {
    it('rejects a clearance that only fits the bound in its own unit', () => {
      // 0–100 000 is stated in L/h. 99 999 L/min is 5 999 940 L/h — sixty times
      // over — and passed while the number was compared as typed.
      const spec = getRangeSpec('clearance');
      expect(spec.zod.safeParse({ median: 99_999, unit: 'L/min' }).success).toBe(false);
      expect(spec.zod.safeParse({ median: 2, unit: 'L/min' }).success).toBe(true);
      expect(spec.zod.safeParse({ median: 100_000, unit: 'L/h' }).success).toBe(true);
    });

    it('rejects a dose that only fits the bound in grams', () => {
      // The same hole, older: 0–1 000 000 is stated in mg, and 2000 g is 2e6 mg.
      const spec = getRangeSpec('fatalDose');
      expect(spec.zod.safeParse({ median: 2000, unit: 'g' }).success).toBe(false);
      expect(spec.zod.safeParse({ median: 500, unit: 'g' }).success).toBe(true);
    });

    it('still bounds a value whose unit cannot be canonicalized', () => {
      // A molar concentration needs a molecular weight the registry does not
      // hold, and mg/kg needs a body weight; both keep the raw check rather
      // than losing one.
      expect(
        getRangeSpec('toxicConcentration').zod.safeParse({ median: 2e6, unit: 'µmol/L' }).success,
      ).toBe(false);
      expect(
        getRangeSpec('fatalDose').zod.safeParse({ median: 2e6, unit: 'mg/kg' }).success,
      ).toBe(false);
    });

    it('bounds a unitless value against the canonical bounds unchanged', () => {
      expect(getRangeSpec('pKa').zod.safeParse({ median: 8.6 }).success).toBe(true);
      expect(getRangeSpec('pKa').zod.safeParse({ median: 21 }).success).toBe(false);
      expect(getRangeSpec('halfLife').zod.safeParse({ min: 1, max: 10_001 }).success).toBe(false);
    });
  });

  describe('range qualifier validation', () => {
    it('accepts comparison operators as qualifiers', () => {
      const spec = getRangeSpec('toxicConcentration');
      for (const op of ['<', '>', '≤', '≥']) {
        expect(spec.zod.safeParse({ median: 5, unit: 'mg/L', qualifier: op }).success).toBe(true);
      }
    });

    it('rejects free-text qualifiers (no strings in numeric data)', () => {
      const spec = getRangeSpec('toxicConcentration');
      expect(
        spec.zod.safeParse({ median: 5, unit: 'mg/L', qualifier: 'voksen po' }).success,
      ).toBe(false);
      expect(
        spec.zod.safeParse({ median: 5, unit: 'mg/L', qualifier: 'adult oral' }).success,
      ).toBe(false);
    });
  });
});

describe('parameter groups (#302)', () => {
  it('exposes the parameter categories in render order', () => {
    expect(PARAMETER_GROUP_IDS).toEqual([
      'chemistry',
      'pharmacodynamics',
      'pharmacokinetics',
      'dose_exposure',
      'interpretive_concentrations',
      'analytics_detection',
      'postmortem',
    ]);
    expect(PARAMETER_GROUPS.map((g) => g.id)).toEqual([
      ...PARAMETER_GROUP_IDS,
    ]);
  });

  it('isParameterGroupId guards on the canonical set', () => {
    for (const id of PARAMETER_GROUP_IDS) {
      expect(isParameterGroupId(id)).toBe(true);
    }
    expect(isParameterGroupId('viewer')).toBe(false);
    expect(isParameterGroupId('')).toBe(false);
  });

  it('every parameter spec has a group field (groupable or null for metadata)', () => {
    for (const id of DRUG_PARAMETER_IDS) {
      const spec = DRUG_PARAMETERS[id];
      expect(spec).toHaveProperty('group');
      if (spec.group !== null) {
        expect(isParameterGroupId(spec.group)).toBe(true);
      }
    }
  });

  it('groups existing PK params under pharmacokinetics and chemistry properties under chemistry', () => {
    const pk = getParametersInGroup('pharmacokinetics');
    expect(pk).toContain('halfLife');
    expect(pk).toContain('volumeOfDistribution');
    expect(pk).toContain('bioavailability');
    expect(pk).toContain('tmax');
    // Plasma protein binding and the blood:plasma ratio describe drug
    // distribution in vivo, not intrinsic physicochemistry — they belong in
    // the pharmacokinetics box, not chemistry.
    expect(pk).toContain('proteinBinding');
    expect(pk).toContain('bloodPlasmaRatio');

    const chem = getParametersInGroup('chemistry');
    expect(chem).toContain('molecularWeight');
    expect(chem).toContain('pKa');
    expect(chem).not.toContain('proteinBinding');
    expect(chem).not.toContain('bloodPlasmaRatio');
  });

  it('treats name/alias/pubchemCid as metadata (group=null) so they stay outside the grouped sidebar', () => {
    expect(DRUG_PARAMETERS.nameNb.group).toBeNull();
    expect(DRUG_PARAMETERS.nameEn.group).toBeNull();
    expect(DRUG_PARAMETERS.nameShort.group).toBeNull();
    expect(DRUG_PARAMETERS.aliases.group).toBeNull();
    expect(DRUG_PARAMETERS.pubchemCid.group).toBeNull();
  });

  it('getNonEmptyParameterGroups omits pharmacodynamics (mechanisms are modelled as receptor targets, not params)', () => {
    const nonEmpty = getNonEmptyParameterGroups();
    // Pharmacodynamics has no drug-level parameters — its monograph box is
    // driven by the ranked receptor-target relationships instead.
    expect(nonEmpty).toEqual([
      'chemistry',
      'pharmacokinetics',
      'dose_exposure',
      'interpretive_concentrations',
      'analytics_detection',
      'postmortem',
    ]);
    expect(nonEmpty).not.toContain('pharmacodynamics');
  });

  it('groups every #302 P3 parameter into its declared category', () => {
    // Pharmacodynamics carries no drug-level parameters.
    expect(getParametersInGroup('pharmacodynamics')).toEqual([]);
    expect(getParametersInGroup('dose_exposure')).toEqual([
      'therapeuticDose',
      'maxRecommendedDose',
      'nonMedicalDose',
      'overdoseDose',
      'fatalDose',
    ]);
    expect(getParametersInGroup('interpretive_concentrations')).toEqual([
      'therapeuticConcentration',
      'supratherapeuticConcentration',
      'impairmentConcentration',
      'toxicConcentration',
    ]);
    expect(getParametersInGroup('chemistry')).toContain('logP');
    expect(getParametersInGroup('chemistry')).toContain('logD');
    expect(getParametersInGroup('pharmacokinetics')).toContain('clearance');
    expect(getParametersInGroup('analytics_detection')).toEqual([
      'bloodDetectionWindow',
      'oralFluidDetectionWindow',
      'urineDetectionWindow',
      'analyteStability',
    ]);
    // The postmortem box gathers the C/P ratio, the PM/AM ratio and the fatal
    // concentration.
    expect(getParametersInGroup('postmortem')).toEqual([
      'postmortemRedistribution',
      'pmAmRatio',
      'fatalConcentration',
    ]);
  });
});

describe('nullable number parameters (#302 P1, Codex follow-up)', () => {
  it('molecularWeight accepts null so a bad value can be cleared', () => {
    const spec = DRUG_PARAMETERS.molecularWeight;
    expect(spec.kind).toBe('number');
    if (spec.kind !== 'number') throw new Error('unreachable');
    expect(spec.nullable).toBe(true);
    expect(spec.zod.safeParse(null).success).toBe(true);
    expect(spec.zod.safeParse(180).success).toBe(true);
    expect(spec.zod.safeParse(-1).success).toBe(false);
  });

  it('pubchemCid is non-nullable (clearing the unique identifier is not meaningful)', () => {
    const spec = DRUG_PARAMETERS.pubchemCid;
    if (spec.kind !== 'number') throw new Error('unreachable');
    expect(spec.nullable).toBe(false);
    expect(spec.zod.safeParse(null).success).toBe(false);
  });
});

describe('multi-value parameter flags', () => {
  const INTERPRETIVE_CONCENTRATIONS = [
    'therapeuticConcentration',
    'supratherapeuticConcentration',
    'impairmentConcentration',
    'toxicConcentration',
    'fatalConcentration',
  ];

  const EXPECTED_SUMMARIZED = [
    ...INTERPRETIVE_CONCENTRATIONS,
    // Not concentrations, but literature values that vary between papers — the
    // spread across sources IS the range, so they are entry-backed too.
    'halfLife',
    'volumeOfDistribution',
    'bioavailability',
    'proteinBinding',
    'bloodPlasmaRatio',
    'tmax',
    'pKa',
    'logP',
    'logD',
    'clearance',
    'vmax',
    'km',
    'postmortemRedistribution',
    'pmAmRatio',
    'therapeuticDose',
    'maxRecommendedDose',
    'nonMedicalDose',
    'overdoseDose',
    'fatalDose',
    'bloodDetectionWindow',
    'oralFluidDetectionWindow',
    'urineDetectionWindow',
  ];

  it('SUMMARIZED_PARAMETER_IDS covers every between-source-variable parameter', () => {
    expect([...SUMMARIZED_PARAMETER_IDS].sort()).toEqual(
      [...EXPECTED_SUMMARIZED].sort(),
    );
  });

  it('every interpretive concentration is matrix- and scenario-relevant', () => {
    for (const id of INTERPRETIVE_CONCENTRATIONS) {
      expect(parameterIsSummarizable(id as never)).toBe(true);
      expect(parameterIsMatrixRelevant(id as never)).toBe(true);
      expect(parameterIsScenarioRelevant(id as never)).toBe(true);
    }
  });

  it('has retired LOQ and LOD as drug-level parameters', () => {
    // An analytical limit is a property of a validated method in a particular
    // laboratory, not of the substance. The real figures live per analyte per
    // analytical method on `analytical_method_components`; the post-deploy
    // sweep (`npm run retire:loq-lod`) clears the drug-level rows. Nothing may
    // reintroduce them here, or the
    // API would start accepting writes the monograph cannot honestly show.
    for (const id of ['loq', 'lod']) {
      expect(DRUG_PARAMETER_IDS as readonly string[]).not.toContain(id);
      expect(getParameterSpec(id)).toBeNull();
    }
  });

  it('analyte stability stays out of the entry store (matrix-specific)', () => {
    // Degradation in urine and in whole blood are different quantities with no
    // conversion between them, so there is no valid cross-matrix pool.
    expect(parameterIsSummarizable('analyteStability')).toBe(false);
  });

  it('matrix-independent parameters are summarizable without a matrix or scenario', () => {
    for (const id of [
      'halfLife',
      'volumeOfDistribution',
      'pKa',
      'logP',
      'proteinBinding',
      'bloodPlasmaRatio',
      'pmAmRatio',
    ] as const) {
      expect(parameterIsSummarizable(id)).toBe(true);
      expect(parameterIsMatrixRelevant(id)).toBe(false);
      expect(parameterIsScenarioRelevant(id)).toBe(false);
    }
  });

  it('keeps PM/AM separate from C/P and allows the large individual-case ratios', () => {
    // Two different measurements: C/P is a same-time site gradient, PM/AM is a
    // life-to-mortuary change at one site. They share a group, not a parameter.
    const pmAm = DRUG_PARAMETERS.pmAmRatio;
    const cp = DRUG_PARAMETERS.postmortemRedistribution;
    if (pmAm.kind !== 'ratio' || cp.kind !== 'ratio') {
      throw new Error('unreachable');
    }
    expect(pmAm.group).toBe('postmortem');
    expect(pmAm.canonicalUnit).toBe('ratio');
    // Amitriptyline's individual-case PM/AM range tops out at 224 in
    // Mantinieks et al. 2021 — above the C/P parameter's bound.
    expect(cp.bounds.max).toBe(100);
    expect(pmAm.bounds.max).toBe(1000);
    expect(pmAm.zod.safeParse({ median: 2.6, min: 0.37, max: 224, unit: 'ratio' }).success).toBe(true);
    expect(pmAm.zod.safeParse({ median: 2.6, unit: '' }).success).toBe(false);
    expect(pmAm.zod.safeParse({ median: -1, unit: 'ratio' }).success).toBe(false);
  });

  it('flags the parameters whose values are already logarithms', () => {
    // Charts must not apply a second log transform to these.
    for (const id of ['logP', 'logD', 'pKa'] as const) {
      expect(parameterIsAlreadyLogarithmic(id)).toBe(true);
    }
    for (const id of ['halfLife', 'therapeuticConcentration'] as const) {
      expect(parameterIsAlreadyLogarithmic(id)).toBe(false);
    }
  });

  it('metadata parameters are never entry-backed', () => {
    for (const id of METADATA_PARAMETER_IDS) {
      expect(parameterIsSummarizable(id)).toBe(false);
    }
  });
});
