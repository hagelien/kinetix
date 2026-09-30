import { describe, expect, it } from 'vitest';
import {
  ABSENT_RECHECK_DAYS,
  CORE_COVERAGE_PARAMETERS,
  DEFAULT_SUBSTANCE_CLASS,
  SUBSTANCE_CLASSES,
  gapSuppressionReason,
  isSubstanceClass,
  nonAdministeredSubstanceClasses,
  normalizeSubstanceClass,
  parameterAppliesToSubstanceClass,
  parametersRequiringAdministration,
  substanceIsAdministered,
} from './parameterApplicability.js';
import { DRUG_PARAMETER_IDS } from './drugParameters.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe('substance class', () => {
  it('treats an unknown or missing class as administered', () => {
    // The safe direction: a spurious gap costs one cycle, a wrongly hidden one
    // hides real missing data indefinitely.
    for (const value of [null, undefined, '', 'prodrug', 42, {}]) {
      expect(normalizeSubstanceClass(value)).toBe(DEFAULT_SUBSTANCE_CLASS);
      expect(substanceIsAdministered(value)).toBe(true);
    }
  });

  it('recognises exactly the declared classes', () => {
    for (const c of SUBSTANCE_CLASSES) expect(isSubstanceClass(c)).toBe(true);
    expect(isSubstanceClass('metabolite ')).toBe(false);
    expect(isSubstanceClass('Metabolite')).toBe(false);
  });

  it('lists the non-administered classes explicitly rather than by negation', () => {
    // The gap SQL filters with `= ANY(<this list>)`. If it instead tested
    // `<> 'drug'`, a class this build has not heard of would silently hide
    // real gaps — the opposite of how normalizeSubstanceClass fails.
    const nonAdministered = nonAdministeredSubstanceClasses();
    expect(nonAdministered).toEqual(['metabolite', 'endogenous']);
    expect(nonAdministered).not.toContain('drug');
  });
});

describe('parameter × substance class', () => {
  it('withholds bioavailability and the dose parameters from a metabolite', () => {
    // Benzoylecgonine's actual case, and the original bug. Absolute
    // bioavailability is a ratio against an intravenous reference dose of the
    // same compound; nobody has ever given benzoylecgonine, so there is no
    // such dose and no study to find. The dose ranges are the dose itself.
    for (const parameter of ['bioavailability', 'fatalDose']) {
      expect(parameterAppliesToSubstanceClass(parameter, 'metabolite')).toBe(
        false,
      );
      expect(parameterAppliesToSubstanceClass(parameter, 'endogenous')).toBe(
        false,
      );
      expect(parameterAppliesToSubstanceClass(parameter, 'drug')).toBe(true);
    }
  });

  it('keeps disposition and chemistry parameters in scope for every class', () => {
    // A metabolite still has a half-life, a volume of distribution and a
    // molecular weight — those are real gaps and must stay in the queue.
    const stillMeaningful = [
      // tmax included deliberately: a metabolite's time to peak is measured
      // after the PARENT is dosed and is a routine published endpoint —
      // benzoylecgonine's after cocaine, 6-MAM's after heroin. Flagging it
      // made that data unwritable and hid the gaps.
      'tmax',
      'halfLife',
      'volumeOfDistribution',
      'proteinBinding',
      'bloodPlasmaRatio',
      'clearance',
      'molecularWeight',
      'pKa',
      'logP',
      'toxicConcentration',
      'urineDetectionWindow',
    ];
    for (const parameter of stillMeaningful) {
      for (const substanceClass of SUBSTANCE_CLASSES) {
        expect(
          parameterAppliesToSubstanceClass(parameter, substanceClass),
        ).toBe(true);
      }
    }
  });

  it('leaves an unknown parameter id in scope', () => {
    expect(parameterAppliesToSubstanceClass('notAParameter', 'metabolite')).toBe(
      true,
    );
  });

  it('flags only what needs a dose OF THIS SUBSTANCE', () => {
    // The narrow test, not "describes absorption". tmax reads like it belongs
    // here and does not: some dose somewhere upstream is enough for it, while
    // bioavailability needs an IV reference dose of the compound itself and
    // the dose ranges *are* the dose. Getting that boundary wrong makes valid
    // published data unwritable and hides the gap, which is the worse
    // direction — so this list is pinned rather than derived by eye.
    expect(parametersRequiringAdministration().sort()).toEqual(
      [
        // The absorption AXIS joins its rate constant behind the same barrier:
        // "how does a dose of this enter the body" has no answer for a
        // substance nobody doses. Its two siblings stay out — a metabolite has
        // a disposition and an elimination just as its parent does, so those
        // remain real gaps for a never-administered analyte.
        'absorptionModel',
        'bioavailability',
        // ka (CV-2c) describes absorption after dosing this substance, so it is
        // undefined for a never-administered analyte — same barrier as F/doses.
        'ka',
        'therapeuticDose',
        'maxRecommendedDose',
        'nonMedicalDose',
        'overdoseDose',
        'fatalDose',
      ].sort(),
    );
  });
});

describe('core coverage set', () => {
  it('names only real parameter ids', () => {
    for (const id of CORE_COVERAGE_PARAMETERS) {
      expect(DRUG_PARAMETER_IDS).toContain(id);
    }
  });

  it('has no duplicates, so a pair cannot be queued twice', () => {
    expect(new Set(CORE_COVERAGE_PARAMETERS).size).toBe(
      CORE_COVERAGE_PARAMETERS.length,
    );
  });

  it('leads with the six the prompt calls mandatory, in its stated order', () => {
    expect(CORE_COVERAGE_PARAMETERS.slice(0, 6)).toEqual([
      'molecularWeight',
      'bloodPlasmaRatio',
      'halfLife',
      'volumeOfDistribution',
      'bioavailability',
      'tmax',
    ]);
  });

  it('excludes postmortemRedistribution from mandatory coverage', () => {
    expect(CORE_COVERAGE_PARAMETERS).not.toContain('postmortemRedistribution');
  });
});

describe('gapSuppressionReason', () => {
  const open = {
    parameter: 'halfLife',
    substanceClass: 'drug',
    now: NOW,
  } as const;

  it('reports nothing for a genuine open gap', () => {
    expect(gapSuppressionReason(open)).toBeNull();
  });

  it('suppresses an explicit marker', () => {
    expect(
      gapSuppressionReason({ ...open, markerStatus: 'not_applicable' }),
    ).toBe('not_applicable_marker');
  });

  it('ignores a marker row with an unrecognised status', () => {
    // Guards against a future status meaning something other than "retired"
    // being read as a retirement by an older build.
    expect(gapSuppressionReason({ ...open, markerStatus: 'under_review' })).toBe(
      null,
    );
  });

  it('suppresses an unadministered substance’s absorption parameter', () => {
    expect(
      gapSuppressionReason({
        parameter: 'bioavailability',
        substanceClass: 'metabolite',
        now: NOW,
      }),
    ).toBe('substance_class');
  });

  it('suppresses a pair searched exhaustively inside the cooldown', () => {
    expect(
      gapSuppressionReason({
        ...open,
        lastAbsentAt: daysAgo(ABSENT_RECHECK_DAYS - 1),
      }),
    ).toBe('absent_cooldown');
  });

  it('reopens the pair once the cooldown has elapsed', () => {
    // The cooldown is a claim about the literature at a point in time, and
    // literature moves — so this must expire rather than retire the pair.
    expect(
      gapSuppressionReason({
        ...open,
        lastAbsentAt: daysAgo(ABSENT_RECHECK_DAYS + 1),
      }),
    ).toBeNull();
  });

  it('treats a future-dated absent row as recently searched', () => {
    expect(
      gapSuppressionReason({ ...open, lastAbsentAt: daysAgo(-30) }),
    ).toBe('absent_cooldown');
  });

  it('ignores an unparseable timestamp instead of suppressing on it', () => {
    expect(
      gapSuppressionReason({ ...open, lastAbsentAt: 'not a date' }),
    ).toBeNull();
    expect(gapSuppressionReason({ ...open, lastAbsentAt: null })).toBeNull();
  });

  it('prefers the durable reason over a cooldown that would expire', () => {
    expect(
      gapSuppressionReason({
        parameter: 'bioavailability',
        substanceClass: 'metabolite',
        markerStatus: 'not_applicable',
        lastAbsentAt: daysAgo(1),
        now: NOW,
      }),
    ).toBe('not_applicable_marker');

    expect(
      gapSuppressionReason({
        parameter: 'bioavailability',
        substanceClass: 'metabolite',
        lastAbsentAt: daysAgo(1),
        now: NOW,
      }),
    ).toBe('substance_class');
  });
});
