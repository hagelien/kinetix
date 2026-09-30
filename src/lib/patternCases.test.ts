/**
 * Persisting a case (plan §10, Phase 1 acceptance).
 *
 * Two properties, and they are the acceptance criteria rather than incidental:
 * a case round-trips *exactly*, censoring included; and a case saved under one
 * registry and opened under another says so instead of quietly reading
 * differently.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  isPatternCaseData,
  listPatternCases,
  loadPatternCase,
  PATTERN_CASE_PAGE_MAX,
  patternCaseDataSchema,
  registryStaleness,
  patternCaseProblems,
  savePatternCase,
  timeOriginProblems,
} from './patternCases';
import { DIAZEPAM_FIXTURE_CASE } from './pattern/fixtures';
import { BENZODIAZEPINE_MODULE } from './pattern/modules/benzodiazepines';
import type { PatternSubstanceModule } from './pattern/substanceModules';
import type { PatternCaseData } from '@/types/patternCase';

const MODULES = [BENZODIAZEPINE_MODULE];

function moduleAt(version: string): PatternSubstanceModule {
  return { ...BENZODIAZEPINE_MODULE, version };
}

let sent: Array<{ url: string; init?: RequestInit }> = [];
let respond: (url: string) => unknown;

beforeEach(() => {
  sent = [];
  respond = () => ({ id: 1, name: 'sak', caseData: DIAZEPAM_FIXTURE_CASE, createdAt: 'now' });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(respond(url)),
      text: () => Promise.resolve(''),
    } as Response);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('a case survives being written down', () => {
  it('accepts the shipped fixture unchanged', () => {
    // The fixture is the case the whole engine is tested against, so if the
    // schema and it disagree, one of them is wrong about what a case is.
    const parsed = patternCaseDataSchema.safeParse(DIAZEPAM_FIXTURE_CASE);
    expect(parsed.success).toBe(true);
  });

  it('keeps every censoring state distinguishable', () => {
    // A `below_limit` coerced to its limit on the way in would reload as a
    // measurement somebody made rather than one the assay could not, which is
    // the error class §8.2 exists to prevent.
    const censored: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: (
        [
          'quantified',
          'below_limit',
          'above_limit',
          'not_detected',
          'detected_not_quantified',
        ] as const
      ).map((qualifier, index) => ({
        id: `o-${qualifier}`,
        specimenId: DIAZEPAM_FIXTURE_CASE.specimens[0]!.id,
        // The module's own analytes rather than a counted sequence: these rows
        // are stated in ng/mL, and a mass result is only saveable on a
        // substance the catalog can weigh. `3016 + index` walked off the end of
        // the catalog at the fourth row.
        analyte: { pubchemCid: [3016, 2997, 5391, 4616, 3016][index]! },
        qualifier,
        value: qualifier === 'quantified' ? 1.5 : undefined,
        unit: 'ng/mL',
        // Both bounded qualifiers carry their threshold, since that is the
        // half a reload can lose: `resolveObservations` reads `limitRef` and
        // nothing else, so a censored row that arrives back without one
        // resolves indeterminate — present on screen, but bounding nothing.
        limitRef:
          qualifier === 'below_limit'
            ? { label: 'LOQ', value: 5, unit: 'ng/mL', reportedDecimals: 1 }
            : qualifier === 'above_limit'
              ? { label: 'ULOQ', value: 1000, unit: 'ng/mL' }
              : undefined,
      })),
    };

    const parsed = patternCaseDataSchema.parse(censored);
    expect(parsed.observations.map((o) => o.qualifier)).toEqual([
      'quantified',
      'below_limit',
      'above_limit',
      'not_detected',
      'detected_not_quantified',
    ]);
    // The limit travels with the censored row in both directions, or the
    // reloaded case could not say what the result was below or above.
    expect(parsed.observations[1]!.limitRef).toEqual({
      label: 'LOQ',
      value: 5,
      unit: 'ng/mL',
      reportedDecimals: 1,
    });
    expect(parsed.observations[2]!.limitRef).toEqual({
      label: 'ULOQ',
      value: 1000,
      unit: 'ng/mL',
    });
    expect(parsed).toEqual(censored);
  });

  it('keeps what a specimen says about how it was handled', () => {
    // Storage duration and postmortem interval bear on whether a concentration
    // is the one the body had, and neither can be reconstructed from anything
    // else stored.
    const handled: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        {
          id: 's1',
          matrix: 'femoral_blood',
          postmortem: { postmortemIntervalHours: 36, storageDurationHours: 720 },
        },
      ],
      observations: [],
    };

    expect(patternCaseDataSchema.parse(handled)).toEqual(handled);
  });

  it('keeps a declared exposure and when it was taken', () => {
    // What A6.6 asks for: which substance was taken, how firmly that is known,
    // and when relative to the case's time origin. The stated dose and route
    // travel with it — nothing in this release computes from a milligram
    // amount, since a ratio is not a dose reconstruction, but an account is
    // given once and a field that does not exist loses it for good.
    const withExposure: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [
          { drug: { pubchemCid: 3016, slug: 'diazepam' }, certainty: 'reported', timeRelativeHours: -14 },
        ],
      },
    };

    expect(patternCaseDataSchema.parse(withExposure)).toEqual(withExposure);
  });

  it('keeps an intake nobody can place at a point', () => {
    // What a witness statement usually amounts to. Collapsing it to a midpoint
    // would state a precision the account does not have, and dropping it would
    // leave the case with no chronology for the intake at all.
    const window: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'reported', timeRangeHours: [-16, -10] },
        ],
      },
    };

    expect(patternCaseDataSchema.parse(window)).toEqual(window);
  });

  it('refuses an exposure window that contradicts itself', () => {
    const withExposure = (exposure: Record<string, unknown>): PatternCaseData => ({
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported', ...exposure }],
      },
    } as PatternCaseData);

    // Backwards: anything reading it as a duration gets a negative one.
    expect(
      patternCaseProblems(withExposure({ timeRangeHours: [-2, -16] })).map((p) => p.code),
    ).toEqual(['exposure_range_backwards']);

    // Two statements about one instant. Whichever a consumer reads decides the
    // answer, which is the failure mode a stored case cannot recover from.
    expect(
      patternCaseProblems(withExposure({ timeRelativeHours: -20, timeRangeHours: [-16, -10] })).map(
        (p) => p.code,
      ),
    ).toEqual(['exposure_time_outside_range']);

    // A point inside its own window is a narrowing, not a contradiction.
    expect(
      patternCaseProblems(withExposure({ timeRelativeHours: -12, timeRangeHours: [-16, -10] })),
    ).toEqual([]);
  });

  it('refuses a unit the engine cannot convert from', () => {
    // The quiet one: the number is stored, shown, and ignored. Every ratio
    // reading the row disappears while the concentration sits on screen looking
    // like a result — so a case can be filed complete and compute nothing.
    const withUnit = (unit: string): PatternCaseData => ({
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [{ ...DIAZEPAM_FIXTURE_CASE.observations[0]!, unit }],
    });

    expect(patternCaseProblems(withUnit('')).map((p) => p.code)).toEqual(['unit_unreadable']);
    expect(patternCaseProblems(withUnit('bananas per litre')).map((p) => p.code)).toEqual([
      'unit_unreadable',
    ]);

    // Normalised before it is judged: these three spellings are all in use in
    // imported and hand-entered data, and turning them away would refuse
    // ordinary laboratory output.
    for (const unit of ['umol/L', 'μmol/L', 'µmol/L', 'ng/mL']) {
      expect(patternCaseProblems(withUnit(unit))).toEqual([]);
    }
  });

  it('refuses a threshold whose unit says nothing either', () => {
    // Same failure through the censored half: a bound the engine cannot convert
    // is a bound it drops, and the row reopens unbounded rather than censored.
    const censored: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          id: 'obs-1',
          specimenId: DIAZEPAM_FIXTURE_CASE.specimens[0]!.id,
          analyte: { pubchemCid: 3016 },
          qualifier: 'below_limit',
          limitRef: { label: 'LOQ', value: 0.01, unit: '' },
        },
      ],
    };

    expect(patternCaseProblems(censored).map((p) => p.code)).toEqual(['unit_unreadable']);
  });

  it('names every refusal a curator can reach by typing', () => {
    // The screen is Norwegian, and a refusal with no code has nothing to
    // translate — it would put Zod's English in front of a curator
    // (AGENTS.md). Every constraint the entry controls can actually violate
    // therefore carries one.
    const zeroCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [{ id: 's1', matrix: 'urine', urine: { creatinineMmolL: 0 } }],
      observations: [],
    };
    expect(patternCaseProblems(zeroCreatinine).map((p) => p.code)).toEqual([
      'creatinine_not_positive',
    ]);

    const zeroReference: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      normalization: { creatinineReferenceMmolL: 0 },
    };
    expect(patternCaseProblems(zeroReference).map((p) => p.code)).toEqual([
      'creatinine_reference_not_positive',
    ]);

    const zeroLimit: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          id: 'obs-1',
          specimenId: DIAZEPAM_FIXTURE_CASE.specimens[0]!.id,
          analyte: { pubchemCid: 3016 },
          qualifier: 'below_limit',
          limitRef: { label: 'LOQ', value: 0, unit: 'ng/mL' },
        },
      ],
    };
    expect(patternCaseProblems(zeroLimit).map((p) => p.code)).toEqual(['limit_not_positive']);
  });

  it('refuses urine data on a specimen that is not urine', () => {
    // The last void is the sharp end: it anchors the case's axis from a field
    // a blood specimen has no reason to render, so a first-specimen origin
    // could become unsatisfiable with nothing on screen to fix it. Refused
    // rather than dropped when the matrix changes — a creatinine typed by hand
    // is a measurement, and deleting it as a side effect of correcting a
    // dropdown is the loss this schema exists to prevent.
    const moved: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        { id: 's1', matrix: 'whole_blood', relativeTimeHours: 0, urine: { creatinineMmolL: 8 } },
      ],
      observations: [],
    };

    expect(patternCaseProblems(moved).map((p) => p.code)).toEqual(['urine_data_on_other_matrix']);
  });

  it('refuses two declared exposures sharing an id', () => {
    // The screen tells the rows apart by the id, so a repeat means two rows
    // sharing React's idea of which is which — removing one can hand its
    // half-typed dose to the other, and the number on screen stops being the
    // number filed.
    const twinned: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [
          { id: 'exp-1', drug: { pubchemCid: 3016 }, certainty: 'reported' },
          { id: 'exp-1', drug: { pubchemCid: 2519 }, certainty: 'suspected' },
        ],
      },
    };

    expect(patternCaseProblems(twinned).map((p) => p.code)).toEqual(['duplicate_exposure_id']);
  });

  it('refuses a length of time that runs backwards', () => {
    // Zero is kept: a sample analysed the moment it arrived waited no time at
    // all. Below zero is not a shorter duration but an impossible one, and
    // anything asking "was this stored long enough to matter" answers the
    // wrong way round.
    const negative = (postmortem: Record<string, number>): PatternCaseData => ({
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [{ id: 's1', matrix: 'femoral_blood', relativeTimeHours: 0, postmortem }],
      observations: [],
    });

    expect(patternCaseProblems(negative({ postmortemIntervalHours: -36 })).map((p) => p.code)).toEqual(
      ['postmortem_interval_negative'],
    );
    expect(patternCaseProblems(negative({ storageDurationHours: -1 })).map((p) => p.code)).toEqual([
      'storage_duration_negative',
    ]);
    expect(patternCaseProblems(negative({ postmortemIntervalHours: 0 }))).toEqual([]);

    const collection: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        { id: 's1', matrix: 'urine', relativeTimeHours: 0, urine: { collectionDurationHours: -12 } },
      ],
      observations: [],
    };
    expect(patternCaseProblems(collection).map((p) => p.code)).toEqual([
      'collection_duration_negative',
    ]);
  });

  it('keeps where a reporting limit came from', () => {
    // A censored result is only as interpretable as its threshold, and "the
    // laboratory's own LOQ" and "a limit quoted in a paper" are different
    // claims. Absent is its own answer: an imported limit whose provenance
    // nobody recorded must not come back asserting a person typed it.
    const sourced: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          id: 'obs-1',
          specimenId: DIAZEPAM_FIXTURE_CASE.specimens[0]!.id,
          analyte: { pubchemCid: 3016 },
          qualifier: 'below_limit',
          limitRef: {
            label: 'MKK',
            value: 0.01,
            unit: 'µmol/L',
            source: 'method_component',
            column: 'mkk',
          },
        },
      ],
    };

    expect(patternCaseDataSchema.parse(sourced)).toEqual(sourced);
  });

  it('names each refusal by a code a screen can translate', () => {
    // The entry screen asks the schema rather than repeating its rules: a
    // second list of the same refusals drifts, and the half that drifts is the
    // one nothing enforces — so the screen would fall silent about a save the
    // server still refuses. The code is what the two share.
    const broken = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: [],
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, specimenId: 'nowhere' },
      ],
    } as PatternCaseData;

    const problems = patternCaseProblems(broken);
    expect(problems.map((p) => p.code).sort()).toEqual(['dangling_specimen', 'no_module']);
    expect(problems.find((p) => p.code === 'dangling_specimen')?.params).toMatchObject({
      specimenId: 'nowhere',
    });
    expect(patternCaseProblems(DIAZEPAM_FIXTURE_CASE)).toEqual([]);
  });

  it('refuses an observation that belongs to no specimen it carries', () => {
    // The failure this prevents is silent: `resolveObservations` resolves a
    // missing specimen to `matrix: 'other'`, which matches no feature term, so
    // the result disappears from the profile with nothing on screen to say a
    // measured concentration was dropped.
    const orphaned: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          ...DIAZEPAM_FIXTURE_CASE.observations[0]!,
          specimenId: 'a-specimen-that-is-not-here',
        },
      ],
    };

    const parsed = patternCaseDataSchema.safeParse(orphaned);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/vanish from the profile/);
  });

  it('refuses two specimens sharing an id', () => {
    // The lookup is a Map, so the later one wins and every observation naming
    // that id is read against a matrix — and a creatinine — that may belong to
    // the other sample.
    const collided: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        { id: 'same', matrix: 'femoral_blood' },
        { id: 'same', matrix: 'urine', urine: { creatinineMmolL: 8.84 } },
      ],
      observations: [],
    };

    const parsed = patternCaseDataSchema.safeParse(collided);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/share the id/);
  });

  it('refuses two observations sharing an id', () => {
    // An edit is applied by observation id, so correcting one concentration
    // would rewrite both — and the view keys its rows on the same id.
    const collided: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, id: 'same' },
        { ...DIAZEPAM_FIXTURE_CASE.observations[1]!, id: 'same' },
      ],
    };

    const parsed = patternCaseDataSchema.safeParse(collided);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/would rewrite both/);
  });

  it('refuses a case that names no module', () => {
    // The pipeline reads `modules[0].assumedParent` unconditionally, so such a
    // case throws on open rather than rendering empty: it could be filed and
    // never read again.
    const moduleless: PatternCaseData = { ...DIAZEPAM_FIXTURE_CASE, moduleIds: [] };

    const parsed = patternCaseDataSchema.safeParse(moduleless);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/at least one substance module/);
  });

  it('refuses a case naming one module twice', () => {
    // Found by asking the same question of the remaining identifier rather
    // than waiting for it to be asked: `assertModulesCompose` refuses a
    // repeated module outright, so this too could be filed and never reopened.
    const repeated: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['benzodiazepines', 'benzodiazepines'],
    };

    const parsed = patternCaseDataSchema.safeParse(repeated);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/names each substance module once/);
  });

  it('refuses a value or a bound the engine would drop on reopening', () => {
    // Both are values the schema would have stored and the engine refuses, so
    // the case would come back computing less than it did when it was filed.
    const negative: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, qualifier: 'quantified', value: -1 },
      ],
    };
    expect(String(patternCaseDataSchema.safeParse(negative).error)).toMatch(
      /cannot be below zero/,
    );

    const unbounded: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          ...DIAZEPAM_FIXTURE_CASE.observations[0]!,
          qualifier: 'below_limit',
          value: undefined,
          limitRef: { label: 'LOQ', value: 0, unit: 'ng/mL' },
        },
      ],
    };
    expect(patternCaseDataSchema.safeParse(unbounded).success).toBe(false);
  });

  it('refuses a quantified result that quantifies nothing', () => {
    // A laboratory that could not quantify says `below_limit` or
    // `detected_not_quantified`; it does not report a quantified result with
    // no number. Stored, the engine resolves it indeterminate and the case
    // claims a quantification it does not carry.
    const noValue: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          ...DIAZEPAM_FIXTURE_CASE.observations[0]!,
          qualifier: 'quantified',
          value: undefined,
        },
      ],
    };
    expect(String(patternCaseDataSchema.safeParse(noValue).error)).toMatch(/carries no value/);

    const noUnit: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, qualifier: 'quantified', unit: undefined },
      ],
    };
    expect(String(patternCaseDataSchema.safeParse(noUnit).error)).toMatch(/carries no unit/);
  });

  it('refuses a creatinine or a reported-as id that cannot be computed with', () => {
    // Creatinine is a denominator, not a result: `creatinineFactor` returns
    // null at or below zero, so every normalised cross-specimen ratio goes
    // away — while the view renders the number verbatim, showing an impossible
    // measurement and declining to compute from it at once.
    const badCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [{ id: 's1', matrix: 'urine', urine: { creatinineMmolL: -1 } }],
      observations: [],
    };
    expect(patternCaseDataSchema.safeParse(badCreatinine).success).toBe(false);

    // And a catalog id carries the constraint a catalog id has, wherever it
    // appears: the molecular-weight lookup fails on a non-positive one and
    // takes the quantified result with it.
    const badReportedAs: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          ...DIAZEPAM_FIXTURE_CASE.observations[0]!,
          assay: { measurandMode: 'direct', reportedAsDrugId: 0 },
        },
      ],
    };
    expect(patternCaseDataSchema.safeParse(badReportedAs).success).toBe(false);
  });

  it('keeps a quantified zero, which is a real result', () => {
    // §8.1: a ratio can legitimately be zero, so zero is a measurement and not
    // a missing one. Only *below* zero is impossible.
    const zero: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, qualifier: 'quantified', value: 0 },
      ],
    };

    expect(patternCaseDataSchema.safeParse(zero).success).toBe(true);
  });

  it('refuses to file a case it could not read back', () => {
    // Worse than not writing it: the writer believes it is filed.
    const broken = { ...DIAZEPAM_FIXTURE_CASE, specimens: [{ id: 's1', matrix: 'blood' }] } as never;

    return expect(savePatternCase('sak', broken, MODULES)).rejects.toThrow(/malformed/);
  });
});

/**
 * Spec §7.3. Every relative hour in a case is measured from one declared
 * origin, and the whole point of declaring it is that a timeline can otherwise
 * be shifted by a constant with nothing to say so — the reading is wrong, not
 * missing, and it is wrong in the direction the author cannot see.
 */
describe('the declared time origin and the hours in the case agree', () => {
  const timed = (over: Partial<PatternCaseData['context']>, specimens: PatternCaseData['specimens']): PatternCaseData => ({
    ...DIAZEPAM_FIXTURE_CASE,
    specimens,
    observations: [],
    context: { ...DIAZEPAM_FIXTURE_CASE.context, ...over },
  });

  it('accepts a case with no instant anywhere, under any origin', () => {
    // Durations, not instants: a collection lasts twelve hours and a body was
    // dead for thirty-six under every origin there is. Nothing has been placed
    // on the axis, so nothing can be misplaced on it.
    //
    // Each origin still needs its own event to exist, which is a different
    // question — so the postmortem case says somebody died and the
    // declared-exposure case declares an exposure, both without placing an
    // hour anywhere.
    const context = (timeOrigin: PatternCaseData['context']['timeOrigin']) => ({
      timeOrigin,
      postmortem: timeOrigin === 'death',
      knownExposures:
        timeOrigin === 'declared_exposure'
          ? [{ drug: { pubchemCid: 3016 }, certainty: 'reported' as const }]
          : undefined,
    });

    for (const timeOrigin of ['first_specimen_collection', 'declared_exposure', 'death', 'admission'] as const) {
      const undated = timed(context(timeOrigin), [
        {
          id: 's1',
          matrix: 'urine',
          urine: { creatinineMmolL: 8, collectionDurationHours: 12 },
          postmortem: { postmortemIntervalHours: 36, storageDurationHours: 720 },
        },
      ]);
      expect(timeOriginProblems(undated)).toEqual([]);
      expect(patternCaseDataSchema.safeParse(undated).success).toBe(true);
    }
  });

  it('refuses an origin whose own event the case does not contain, timed or not', () => {
    // The carve-out above is about *placement*: nothing can be misplaced
    // against an axis nobody used. It says nothing about an origin naming an
    // event the case denies, and a living case anchored on death is incoherent
    // with no hours in it at all.
    const untimedSpecimens: PatternCaseData['specimens'] = [{ id: 's1', matrix: 'whole_blood' }];

    expect(
      timeOriginProblems(timed({ timeOrigin: 'death', postmortem: false }, untimedSpecimens)).map(
        (p) => p.code,
      ),
    ).toEqual(['time_origin_death_without_postmortem']);

    expect(
      timeOriginProblems(timed({ timeOrigin: 'declared_exposure' }, untimedSpecimens)).map(
        (p) => p.code,
      ),
    ).toEqual(['time_origin_no_exposure']);
  });

  it('refuses specimens that do not start where the origin says they do', () => {
    // The silent one. Nothing is absent and nothing throws: an exposure at 0 is
    // read by the author as "at the first draw" and by the engine as three
    // hours before it, and every elapsed time in the case is off by that much.
    const shifted = timed(
      {
        timeOrigin: 'first_specimen_collection',
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported', timeRelativeHours: 0 }],
      },
      [
        { id: 's1', matrix: 'whole_blood', relativeTimeHours: 3 },
        { id: 's2', matrix: 'urine', relativeTimeHours: 7 },
      ],
    );

    expect(timeOriginProblems(shifted)).toEqual([
      expect.objectContaining({
        path: ['specimens', 0, 'relativeTimeHours'],
        code: 'time_origin_first_specimen_shifted',
        params: { hours: 3 },
        message: expect.stringContaining('3 h'),
      }),
    ]);
    expect(patternCaseDataSchema.safeParse(shifted).success).toBe(false);

    const anchored = timed(shifted.context, [
      { id: 's1', matrix: 'whole_blood', relativeTimeHours: 0 },
      { id: 's2', matrix: 'urine', relativeTimeHours: 4 },
    ]);
    expect(timeOriginProblems(anchored)).toEqual([]);
  });

  it('refuses an origin at the first specimen when no specimen states a time', () => {
    // §7.3's own boundary: an exposure at −2 h is on the timeline whether or
    // not a specimen is, and this origin names a specimen as the zero. Which
    // specimen that is has to be written down, or a second specimen added later
    // silently redefines the case's zero.
    const unanchored = timed(
      {
        timeOrigin: 'first_specimen_collection',
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported', timeRelativeHours: -2 }],
      },
      [{ id: 's1', matrix: 'whole_blood' }],
    );

    expect(timeOriginProblems(unanchored)).toHaveLength(1);
    expect(timeOriginProblems(unanchored)[0]!.path).toEqual(['specimens']);
  });

  it('refuses a death-anchored case that says nobody died', () => {
    // Refused rather than quietly re-anchored: every hour in the case is
    // relative to whichever origin stands, so swapping the origin behind the
    // curator's back would reinterpret the whole timeline. They have to say
    // which of the two statements they meant.
    const living = timed({ timeOrigin: 'death', postmortem: false }, [
      { id: 's1', matrix: 'whole_blood', relativeTimeHours: 0 },
    ]);

    expect(timeOriginProblems(living).map((p) => p.code)).toEqual([
      'time_origin_death_without_postmortem',
    ]);
  });

  it('puts death at zero when the case is anchored on death', () => {
    const specimens: PatternCaseData['specimens'] = [
      { id: 's1', matrix: 'femoral_blood', relativeTimeHours: 36 },
    ];
    const contradictory = timed(
      { timeOrigin: 'death', postmortem: true, deathRelativeHours: -36 },
      specimens,
    );

    expect(timeOriginProblems(contradictory)).toEqual([
      expect.objectContaining({
        path: ['context', 'deathRelativeHours'],
        code: 'time_origin_death_moved',
        message: expect.stringContaining('-36 h'),
      }),
    ]);

    // Absent is fine, and is how most postmortem cases will be written: the
    // origin already says where death is. Only a second, different statement of
    // it is a contradiction.
    expect(timeOriginProblems(timed({ timeOrigin: 'death', postmortem: true }, specimens))).toEqual([]);
    expect(
      timeOriginProblems(timed({ timeOrigin: 'death', postmortem: true, deathRelativeHours: 0 }, specimens)),
    ).toEqual([]);
  });

  it('anchors a declared-exposure case on an exposure that is actually there', () => {
    const specimens: PatternCaseData['specimens'] = [
      { id: 's1', matrix: 'whole_blood', relativeTimeHours: 4 },
    ];

    // Nothing to measure from.
    expect(timeOriginProblems(timed({ timeOrigin: 'declared_exposure' }, specimens))).toEqual([
      expect.objectContaining({
        path: ['context', 'knownExposures'],
        code: 'time_origin_no_exposure',
        message: expect.stringContaining('declares none'),
      }),
    ]);

    // An exposure, but none of them at the zero the origin names — so which of
    // the two the specimen's four hours are counted from is unstated.
    const untimed = timed(
      {
        timeOrigin: 'declared_exposure',
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'reported', timeRelativeHours: -6 },
          { drug: { pubchemCid: 2519 }, certainty: 'suspected' },
        ],
      },
      specimens,
    );
    expect(timeOriginProblems(untimed)).toHaveLength(1);

    const ok = timed(
      {
        timeOrigin: 'declared_exposure',
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'reported', timeRelativeHours: 0 },
          { drug: { pubchemCid: 2519 }, certainty: 'suspected', timeRelativeHours: -6 },
        ],
      },
      specimens,
    );
    expect(timeOriginProblems(ok)).toEqual([]);
    expect(patternCaseDataSchema.safeParse(ok).success).toBe(true);
  });

  it('counts an exposure window as a placement on the axis', () => {
    // A window is where an ordinary reported intake lives, so a case anchored
    // on nothing else is still anchored: reading only points would let it
    // declare an origin its own hours contradict, and skip the check §7.3
    // requires precisely there.
    const windowOnly = timed(
      {
        timeOrigin: 'first_specimen_collection',
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'reported', timeRangeHours: [-16, -10] },
        ],
      },
      [{ id: 's1', matrix: 'whole_blood' }],
    );

    expect(timeOriginProblems(windowOnly).map((p) => p.code)).toEqual([
      'time_origin_first_specimen_untimed',
    ]);

    // And a window does not anchor a declared-exposure case, because it does
    // not say where the axis begins — only that the intake is somewhere on it.
    const noZero = timed(
      { ...windowOnly.context, timeOrigin: 'declared_exposure' },
      [{ id: 's1', matrix: 'whole_blood', relativeTimeHours: 4 }],
    );
    expect(timeOriginProblems(noZero).map((p) => p.code)).toEqual([
      'time_origin_exposure_not_zero',
    ]);
  });

  it('takes a window pinned to the origin as an exposure at the origin', () => {
    // `[0, 0]` says the intake happened at the origin as plainly as a point
    // does, and requiring the same instant to be written twice would refuse a
    // coherent case. A *wider* window containing zero still does not anchor:
    // it places the intake somewhere on the axis without saying where the axis
    // begins.
    const pinned = timed(
      {
        timeOrigin: 'declared_exposure',
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported', timeRangeHours: [0, 0] }],
      },
      [{ id: 's1', matrix: 'whole_blood', relativeTimeHours: 4 }],
    );
    expect(timeOriginProblems(pinned)).toEqual([]);

    const wide = timed(
      {
        timeOrigin: 'declared_exposure',
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported', timeRangeHours: [-2, 2] }],
      },
      [{ id: 's1', matrix: 'whole_blood', relativeTimeHours: 4 }],
    );
    expect(timeOriginProblems(wide).map((p) => p.code)).toEqual(['time_origin_exposure_not_zero']);
  });

  it('counts a last void as an instant on the axis', () => {
    // The trap beside it: `collectionDurationHours` is a duration and does not
    // anchor anything, so a rule reading the whole `urine` object would refuse
    // ordinary cases and one reading neither field would let a placed instant
    // through unchecked.
    const void_ = timed({ timeOrigin: 'first_specimen_collection' }, [
      { id: 's1', matrix: 'urine', urine: { creatinineMmolL: 8, lastVoidRelativeHours: -6 } },
    ]);

    expect(timeOriginProblems(void_)).toHaveLength(1);
  });

  it('keeps the last void through a round trip', () => {
    const stored = timed({ timeOrigin: 'first_specimen_collection' }, [
      {
        id: 's1',
        matrix: 'urine',
        relativeTimeHours: 0,
        urine: { creatinineMmolL: 8, collectionDurationHours: 12, lastVoidRelativeHours: -6 },
      },
    ]);

    expect(patternCaseDataSchema.parse(stored)).toEqual(stored);
  });

  it('refuses a death instant on a living case, whatever the origin', () => {
    // The editor offers the death field only while the case is postmortem, so
    // an imported case carrying both keeps a timestamp the curator can neither
    // see nor clear — while everything reading the axis goes on using it. The
    // anchored version of this contradiction was already refused; this is the
    // one that hides.
    const living = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        postmortem: false,
        timeOrigin: 'admission' as const,
        deathRelativeHours: -12,
      },
    };

    expect(timeOriginProblems(living).map((problem) => problem.code)).toEqual([
      'death_instant_on_living_case',
    ]);
    // A postmortem case placing death on its axis is the ordinary reason the
    // field exists.
    expect(
      timeOriginProblems({
        ...living,
        context: { ...living.context, postmortem: true },
      }),
    ).toEqual([]);
  });

  it('refuses a mass result on a substance the catalog cannot weigh', () => {
    // The weight comes from the embedded catalog, never from the case (§7.2),
    // so a mass result reported on a substance the catalog does not know fails
    // its conversion and reopens indeterminate — with every ratio that read it
    // gone. The entry screen already refuses the pick; an imported case walked
    // in through the half that had no rule.
    const base = DIAZEPAM_FIXTURE_CASE.observations[0]!;
    const unweighable = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        {
          ...base,
          unit: 'ng/mL',
          qualifier: 'quantified' as const,
          value: 100,
          assay: { ...base.assay, reportedAsDrugId: 999_999_999 },
        },
      ],
    };

    expect(patternCaseProblems(unweighable).map((problem) => problem.code)).toEqual([
      'mass_basis_unweighable',
    ]);

    // A molar result on the same basis is untouched: nothing weighs it, so
    // nothing needs the catalog to.
    expect(
      patternCaseProblems({
        ...unweighable,
        observations: [{ ...unweighable.observations[0]!, unit: 'nmol/L' }],
      }),
    ).toEqual([]);
  });

  it('refuses a stated precision no measurement could have', () => {
    // `1e-1000000000` parses to a finite zero and states a billion decimal
    // places. Stored, it is a case that cannot be opened: the count decides how
    // long a rendering is, and writing that one out either throws or takes the
    // tab with it.
    const absurd = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        { ...DIAZEPAM_FIXTURE_CASE.observations[0]!, reportedDecimals: 1_000_000_000 },
      ],
    };

    expect(patternCaseDataSchema.safeParse(absurd).success).toBe(false);
    // A real one is untouched: 21 decimals is past what a decimal rendering can
    // show and well inside what a double can be about.
    expect(
      patternCaseDataSchema.safeParse({
        ...absurd,
        observations: [{ ...DIAZEPAM_FIXTURE_CASE.observations[0]!, reportedDecimals: 21 }],
      }).success,
    ).toBe(true);
  });

  it('keeps a case’s demonstration origin through a round trip', () => {
    // Stripped here, and the fixture's invented concentrations arrive in a
    // curator's case list looking like casework — a screen that reads the
    // marker off the object in hand cannot help, because the saved case is a
    // different object by definition.
    expect(patternCaseDataSchema.parse(DIAZEPAM_FIXTURE_CASE).origin).toBe('example');
    expect(patternCaseDataSchema.parse({ ...DIAZEPAM_FIXTURE_CASE, origin: undefined }).origin).toBe(
      undefined,
    );
  });

  it('refuses to file a case whose timeline contradicts its origin', () => {
    const shifted = timed({ timeOrigin: 'first_specimen_collection' }, [
      { id: 's1', matrix: 'whole_blood', relativeTimeHours: 2 },
    ]);

    return expect(savePatternCase('sak', shifted, MODULES)).rejects.toThrow(/malformed/);
  });
});

describe('a case says which registry produced it', () => {
  it('stamps the modules in scope, and only those', async () => {
    const other: PatternSubstanceModule = { ...BENZODIAZEPINE_MODULE, id: 'cocaine', version: '9' };

    await savePatternCase('sak', DIAZEPAM_FIXTURE_CASE, [BENZODIAZEPINE_MODULE, other]);

    const body = JSON.parse(String(sent[0]!.init!.body)) as { caseData: PatternCaseData };
    // A version bump to a family this case never mentions is not a change to
    // this case.
    expect(body.caseData.moduleVersions).toEqual({
      benzodiazepines: BENZODIAZEPINE_MODULE.version,
    });
  });

  it('keeps the stamp of a module the app no longer ships', async () => {
    // Re-stamping only what resolves would drop it — and a stamp that says
    // nothing about a module compares equal to a registry that has nothing to
    // say about it either, so the next load would read `current`. An ordinary
    // re-save would erase the one statement that this case was computed by a
    // registry this app no longer has.
    const saved: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['benzodiazepines', 'retired-family'],
      moduleVersions: { benzodiazepines: '1.0.0', 'retired-family': '3.2.1' },
    };

    await savePatternCase('sak', saved, MODULES);

    const body = JSON.parse(String(sent[0]!.init!.body)) as { caseData: PatternCaseData };
    expect(body.caseData.moduleVersions).toEqual({
      benzodiazepines: BENZODIAZEPINE_MODULE.version,
      'retired-family': '3.2.1',
    });
    expect(registryStaleness(body.caseData, MODULES)).toEqual({
      kind: 'moved',
      modules: [
        { moduleId: 'retired-family', savedVersion: '3.2.1', currentVersion: null },
      ],
      unknownModules: [],
    });
  });

  it('names a definite move even while another module is unstamped', () => {
    // The precise statement must not be masked by the vague one: a reader can
    // act on "this family's registry moved from 0.9.0 to 1.1.0" and can only
    // note "something else is unrecorded".
    const mixed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['benzodiazepines', 'retired-family'],
      moduleVersions: { benzodiazepines: '0.9.0' },
    };

    expect(registryStaleness(mixed, [moduleAt('1.1.0')])).toEqual({
      kind: 'moved',
      modules: [
        { moduleId: 'benzodiazepines', savedVersion: '0.9.0', currentVersion: '1.1.0' },
      ],
      unknownModules: ['retired-family'],
    });
  });

  it('reads as current while the registry has not moved', () => {
    const saved: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleVersions: { benzodiazepines: BENZODIAZEPINE_MODULE.version },
    };

    expect(registryStaleness(saved, MODULES)).toEqual({ kind: 'current' });
  });

  it('names the module and both versions once it has', () => {
    const saved: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleVersions: { benzodiazepines: '0.9.0' },
    };

    // The profile is recomputed either way — that is what lets a corrected band
    // reach an old case. Saying so is what keeps it from reading as an
    // unexplained change of assessment.
    expect(registryStaleness(saved, [moduleAt('1.1.0')])).toEqual({
      kind: 'moved',
      modules: [
        { moduleId: 'benzodiazepines', savedVersion: '0.9.0', currentVersion: '1.1.0' },
      ],
      unknownModules: [],
    });
  });

  it('counts a module the app no longer ships as moved', () => {
    const saved: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleVersions: { benzodiazepines: '1.0.0' },
    };

    expect(registryStaleness(saved, [])).toEqual({
      kind: 'moved',
      modules: [
        { moduleId: 'benzodiazepines', savedVersion: '1.0.0', currentVersion: null },
      ],
      unknownModules: [],
    });
  });

  it('says unknown when the stamp is silent about a module the case names', () => {
    // Absent from the stamp and absent from the registry are different facts.
    // Reading both as "null" and comparing them is how a case with no
    // provenance for a module comes back as `current` — which is the answer
    // that lifts the warning entirely.
    const partial: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['benzodiazepines', 'retired-family'],
      moduleVersions: { benzodiazepines: BENZODIAZEPINE_MODULE.version },
    };

    expect(registryStaleness(partial, MODULES)).toEqual({
      kind: 'unknown',
      modules: ['retired-family'],
    });
  });

  it('saves an unstamped case naming a vanished module as unknown, not current', () => {
    // Nothing resolves and nothing is retained, so the stamp would be `{}` —
    // present, and therefore read as a claim. It says nothing at all.
    const old: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['retired-family'],
      moduleVersions: undefined,
    };

    return savePatternCase('sak', old, MODULES).then(() => {
      const body = JSON.parse(String(sent[0]!.init!.body)) as { caseData: PatternCaseData };
      expect(registryStaleness(body.caseData, MODULES)).toEqual({
        kind: 'unknown',
        modules: ['retired-family'],
      });
    });
  });

  it('drops a stamp for a module the case no longer names', async () => {
    // Kept, it would go on describing something this case does not compute
    // from, and a later bump to that family would report the case stale over a
    // module it no longer mentions.
    const narrowed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['benzodiazepines'],
      moduleVersions: { benzodiazepines: '1.0.0', 'dropped-family': '2.0.0' },
    };

    await savePatternCase('sak', narrowed, MODULES);

    const body = JSON.parse(String(sent[0]!.init!.body)) as { caseData: PatternCaseData };
    expect(body.caseData.moduleVersions).toEqual({
      benzodiazepines: BENZODIAZEPINE_MODULE.version,
    });
  });

  it('says unknown rather than current for a case saved before versions existed', () => {
    // Silence is not agreement. A case with no stamp says nothing about which
    // registry produced it, and reporting it as current would be the assumption
    // the marker exists to refuse.
    const { moduleVersions: _dropped, ...unstamped } = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleVersions: undefined,
    };
    void _dropped;

    expect(registryStaleness(unstamped as PatternCaseData, MODULES)).toEqual({
      kind: 'unknown',
      modules: ['benzodiazepines'],
    });
  });

  it('treats a module id that names something on Object.prototype as unstamped', () => {
    // Silence again, reached through the lookup rather than through the logic.
    // Module ids come out of a stored case, so `saved['toString']` answers with
    // an inherited function instead of the absence that is the truth — and the
    // registry's own record inherits the same one, so the two compare equal and
    // an unstamped module the app does not ship reports `current`. The
    // provenance warning is lifted by a name.
    const named = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['toString', 'constructor'],
      moduleVersions: undefined,
    } as unknown as PatternCaseData;

    expect(registryStaleness(named, MODULES)).toEqual({
      kind: 'unknown',
      modules: ['constructor', 'toString'],
    });
  });

  it('keeps a stamp under such an id through a re-save', async () => {
    // The same defect one step along, where `in` reads the prototype chain:
    // every id is `in` an empty record, so the stamp this branch exists to
    // carry forward would be the one it dropped — and the case would come back
    // reporting no provenance at all.
    const named = {
      ...DIAZEPAM_FIXTURE_CASE,
      moduleIds: ['toString'],
      moduleVersions: { toString: '0.4.0' },
    } as unknown as PatternCaseData;

    const saved = await savePatternCase('sak', named, MODULES);

    expect(saved.caseData.moduleVersions).toEqual({ toString: '0.4.0' });
    expect(registryStaleness(saved.caseData, MODULES)).toEqual({
      kind: 'moved',
      modules: [{ moduleId: 'toString', savedVersion: '0.4.0', currentVersion: null }],
      unknownModules: [],
    });
  });
});

describe('loading', () => {
  it('returns the case with its staleness decided', async () => {
    respond = () => ({
      id: 7,
      name: 'sak',
      caseData: { ...DIAZEPAM_FIXTURE_CASE, moduleVersions: { benzodiazepines: '0.1.0' } },
      createdAt: 'then',
    });

    const loaded = await loadPatternCase(7, MODULES);

    expect(loaded.id).toBe(7);
    expect(loaded.staleness.kind).toBe('moved');
  });

  it('refuses a row that is some other kind of case', async () => {
    respond = () => ({ id: 7, name: 'x', caseData: { kind: 'kinelab-case' }, createdAt: 'then' });

    await expect(loadPatternCase(7, MODULES)).rejects.toThrow(/not a metabolite ratio profile/);
  });

  it('refuses a row that no longer matches the schema', async () => {
    // Rather than computing a profile from half-understood data, which would
    // render as an ordinary assessment.
    respond = () => ({
      id: 7,
      name: 'x',
      caseData: { ...DIAZEPAM_FIXTURE_CASE, observations: [{ id: 'o1' }] },
      createdAt: 'then',
    });

    await expect(loadPatternCase(7, MODULES)).rejects.toThrow(/does not match the current schema/);
  });

  it('lists only pattern cases, asking the API to filter as well', async () => {
    // The envelope the list endpoint actually answers with. The single-case,
    // create and update paths return the row itself; only the list wraps it,
    // and reading it as a bare array fails silently — every case filtered out
    // as "not a pattern case", so saved work looks like no saved work.
    respond = () => ({
      cases: [
        { id: 1, name: 'a', caseData: DIAZEPAM_FIXTURE_CASE, createdAt: 'x' },
        { id: 2, name: 'b', caseData: { kind: 'kinelab-case' }, createdAt: 'x' },
      ],
    });

    const rows = await listPatternCases();

    expect(sent[0]!.url).toContain('kind=pattern-case');
    expect(rows.map((row) => row.id)).toEqual([1]);
    expect(rows[0]!.caseData).not.toBeNull();
  });

  it('lists a malformed case without claiming it is readable', async () => {
    // The table stores arbitrary JSON, so a row can carry the right `kind` and
    // still be missing specimens or context. Typing that as a whole
    // `PatternCaseData` would have a picker read fields that are not there —
    // and hiding it would look like lost work rather than a case needing
    // attention.
    respond = () => ({
      cases: [
        { id: 3, name: 'halvferdig', caseData: { kind: 'pattern-case' }, createdAt: 'x' },
      ],
    });

    const rows = await listPatternCases();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('halvferdig');
    expect(rows[0]!.caseData).toBeNull();
  });

  it('asks for the page it was told to', async () => {
    // The endpoint pages whether a caller asks or not — fifty rows by default,
    // a hundred at most — so a wrapper with no arguments would look like a
    // complete list and quietly be a first page, losing a curator's older work.
    respond = () => ({ cases: [] });

    await listPatternCases({ limit: PATTERN_CASE_PAGE_MAX, offset: 100 });

    expect(sent[0]!.url).toContain('limit=100');
    expect(sent[0]!.url).toContain('offset=100');
  });

  it('recognises a pattern case by its kind alone', () => {
    expect(isPatternCaseData(DIAZEPAM_FIXTURE_CASE)).toBe(true);
    expect(isPatternCaseData({ kind: 'kinelab-case' })).toBe(false);
    expect(isPatternCaseData(null)).toBe(false);
  });
});
