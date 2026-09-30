/**
 * Persisting a metabolite ratio profile case (plan §10, Phase 1).
 *
 * Thin wrapper over `/api/simulator/cases`, which stores arbitrary JSONB and
 * discriminates on `caseData.kind`. A pattern case shares that table with the
 * forward simulator's and KineLab's, tagged `pattern-case`, so no migration is
 * needed for the case itself.
 *
 * **The profile is never stored — only the case is.** Everything on screen is
 * recomputed from the observations every time the case is opened, which is what
 * lets a corrected band or a withdrawn threshold rule reach a case filed months
 * ago. The cost of that is the reason `moduleVersions` exists: recomputing
 * silently would let a case read differently from the day it was filed with
 * nothing saying so, and an unexplained change of assessment is worse in a
 * forensic setting than a stated one.
 */
import { z } from 'zod';

import {
  PATTERN_CASE_KIND,
  type PatternCaseData,
} from '@/types/patternCase';
import { catalogHasMolecularWeight } from '@/lib/pattern/catalogAnalytes';
import { MAX_REPORTED_DECIMALS } from '@/lib/pattern/format';
import type { PatternSubstanceModule } from '@/lib/pattern/substanceModules';
import { isConcentrationUnit, isMassUnit, normalizeUnit } from '@/lib/unitConversion';

/**
 * A unit the engine can actually convert from.
 *
 * `resolveObservations` reads the canonical spelling and gives up on anything
 * else, so a stored value in a unit nobody recognises comes back as a number
 * the arithmetic will not touch: the row reopens indeterminate and every ratio
 * it feeds disappears, with the number still on screen. That is the worst of
 * the failure modes here — the case looks complete and computes nothing.
 *
 * Checked after normalisation, not against a literal list: `umol/L`, `μmol/L`
 * (Greek mu) and `ug/L` are all in use in imported and hand-entered data, and
 * refusing them would turn ordinary lab output away.
 */
const concentrationUnit = z
  .string()
  .refine((unit) => isConcentrationUnit(normalizeUnit(unit)), {
    message:
      'Not a concentration unit the engine can convert from; the value would be stored and then ignored by every ratio that reads it',
    params: { code: 'unit_unreadable' },
  });


/**
 * A number every consumer of this schema needs to be above zero, refused with a
 * name a screen can translate.
 *
 * Zod's own `.positive()` would enforce the same thing and report it in
 * English, which is the one thing a Norwegian entry screen must not put in
 * front of a curator (AGENTS.md). Every refusal a curator can reach by typing
 * therefore carries a code, and the untranslatable remainder — a string where a
 * number belongs, an enum with no such option — is unreachable from the
 * screen's own controls and describes imported data rather than input.
 */
function positive(code: string, what: string) {
  return z.number().refine((value) => value > 0, {
    message: `${what} must be greater than zero`,
    params: { code },
  });
}

/**
 * A length of time, which cannot run backwards.
 *
 * Zero is kept: a sample analysed the moment it arrived waited no time at all,
 * and a postmortem interval of zero is a body found at the moment of death.
 * Below zero is not a shorter duration but an impossible one, and anything
 * reading it — "was this sample stored long enough to matter" — answers the
 * wrong way round.
 */
function duration(code: string, what: string) {
  return z
    .number()
    .refine((value) => value >= 0, {
      message: `${what} cannot be negative`,
      params: { code },
    })
    .optional();
}

/** The same, for a catalog identity, which is also a whole number. */
function positiveId(code: string, what: string) {
  return z.number().refine((value) => Number.isInteger(value) && value > 0, {
    message: `${what} must be a positive whole number`,
    params: { code },
  });
}

const drugRefSchema = z.object({
  pubchemCid: positiveId('analyte_invalid', 'A PubChem CID'),
  slug: z.string().optional(),
});

const limitRefSchema = z.object({
  // The threshold's name as the source states it, not mapped to LOD/LOQ — a
  // laboratory's own wording is data, and normalising it here would decide a
  // question the source left open.
  label: z.string(),
  // Strictly positive. `resolveObservations` refuses a bound at or below zero
  // — it states nothing, and an interval of [0, 0] would read as a quantified
  // zero rather than as an absent measurement — so a stored one turns a
  // censored result into an unbounded one on reopening. A reporting limit is a
  // concentration a method can detect; there is no such thing as a
  // non-positive one.
  value: positive('limit_not_positive', 'A reporting limit'),
  unit: concentrationUnit,
  // Where the threshold came from, and which method column it was read out of.
  // A censored result is only as interpretable as its threshold, and "the
  // laboratory's LOQ" and "a limit quoted in a paper" are different claims —
  // stripping them on the way in would leave a reopened case unable to say
  // which it had.
  source: z.enum(['method_component', 'publication', 'manual']).optional(),
  column: z.enum(['lod', 'lor', 'mkk']).optional(),
  // Bounded above, not merely non-negative: the count is used to decide how
  // long a rendering is, and `1e-1000000000` parses to a finite zero while
  // stating a billion decimal places. Past the smallest double there is no
  // value such a claim could be about — and a stored one would be a case that
  // cannot be opened without the tab stopping.
  reportedDecimals: z.number().int().min(0).max(MAX_REPORTED_DECIMALS).optional(),
});

const specimenSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  matrix: z.enum([
    'whole_blood',
    'femoral_blood',
    'cardiac_blood',
    'serum',
    'plasma',
    'urine',
    'vitreous',
    'other',
  ]),
  relativeTimeHours: z.number().optional(),
  urine: z
    .object({
      // Strictly positive, like a reporting limit and unlike a measured
      // concentration. Creatinine here is a *denominator*: `creatinineFactor`
      // returns null at or below zero, so every cross-specimen normalised
      // ratio becomes unavailable — while the view renders the number
      // verbatim, so the screen would show an impossible measurement and
      // decline to compute from it in the same breath. A quantified zero is
      // kept elsewhere because a ratio can be zero; nothing can be divided by
      // one.
      creatinineMmolL: positive('creatinine_not_positive', 'A urine creatinine').optional(),
      specificGravity: z.number().optional(),
      collectionDurationHours: duration('collection_duration_negative', 'A collection'),
      lastVoidRelativeHours: z.number().optional(),
    })
    .optional(),
  // Storage duration and postmortem interval are case data rather than
  // derivations: both bear on whether a concentration is the one the body had
  // (§7.4, A4), and neither can be reconstructed from anything else stored.
  postmortem: z
    .object({
      postmortemIntervalHours: duration('postmortem_interval_negative', 'A postmortem interval'),
      storageDurationHours: duration('storage_duration_negative', 'A storage duration'),
    })
    .optional(),
});

const observationSchema = z.object({
  id: z.string().min(1),
  specimenId: z.string().min(1),
  analyte: drugRefSchema,
  value: z.number().optional(),
  // Bounded above, not merely non-negative: the count is used to decide how
  // long a rendering is, and `1e-1000000000` parses to a finite zero while
  // stating a billion decimal places. Past the smallest double there is no
  // value such a claim could be about — and a stored one would be a case that
  // cannot be opened without the tab stopping.
  reportedDecimals: z.number().int().min(0).max(MAX_REPORTED_DECIMALS).optional(),
  unit: concentrationUnit.optional(),
  // The whole censoring vocabulary, stored as itself. Collapsing
  // `below_limit` to a number on the way in would lose the distinction §8.2
  // exists to keep, and a reloaded case would read as a measurement somebody
  // made rather than one the assay could not.
  qualifier: z.enum([
    'quantified',
    'below_limit',
    'above_limit',
    'not_detected',
    'detected_not_quantified',
  ]),
  limitRef: limitRefSchema.optional(),
  assay: z
    .object({
      measurandMode: z
        .enum([
          'direct',
          'free',
          'direct_conjugate',
          'total_after_hydrolysis',
          'class_response',
          'unknown',
        ])
        .optional(),
      // A catalog identity, so the same constraint the analyte reference
      // carries. `massBasisOf` feeds it to the molecular-weight lookup, which
      // fails on a non-positive id and takes the quantified result down with
      // it — the row reopens indeterminate and its ratios disappear.
      reportedAsDrugId: positiveId('reported_as_invalid', 'A reported-as drug id').optional(),
      limits: z.array(limitRefSchema).optional(),
    })
    .optional(),
  note: z.string().optional(),
});

const knownExposureSchema = z.object({
  id: z.string().min(1).optional(),
  drug: drugRefSchema,
  certainty: z.enum(['confirmed', 'reported', 'suspected']),
  // The account as given: how it was taken, and how much. Read by nothing in
  // this release, which is why it must be *stored* — an account is given once,
  // and the dose interpretation that will want it comes later.
  route: z.string().optional(),
  amount: positive('exposure_amount_not_positive', 'A stated dose').optional(),
  amountUnit: z.string().optional(),
  timeRelativeHours: z.number().optional(),
  // A window, for the intake nobody can place at a point. Stored as stated
  // rather than collapsed to a midpoint, which would claim a precision the
  // account does not have.
  timeRangeHours: z.tuple([z.number(), z.number()]).optional(),
});

const patternCaseFieldsSchema = z.object({
  kind: z.literal(PATTERN_CASE_KIND),
  schemaVersion: z.literal(1),
  specimens: z.array(specimenSchema),
  observations: z.array(observationSchema),
  context: z.object({
    postmortem: z.boolean(),
    timeOrigin: z.enum([
      'first_specimen_collection',
      'declared_exposure',
      'death',
      'admission',
    ]),
    deathRelativeHours: z.number().optional(),
    knownExposures: z.array(knownExposureSchema).optional(),
    fields: z.record(z.string(), z.string()),
  }),
  normalization: z.object({
    creatinineReferenceMmolL: positive(
      'creatinine_reference_not_positive',
      'A creatinine reference',
    ),
  }),
  moduleIds: z.array(z.string()),
  moduleVersions: z.record(z.string(), z.string()).optional(),
  // Kept rather than stripped: a case that began as the demonstration fixture
  // has to be able to say so after it is filed, or the fabricated numbers come
  // back looking like casework. See `PatternCaseData.origin`.
  origin: z.literal('example').optional(),
});

export interface TimeOriginProblem {
  path: Array<string | number>;
  /**
   * A stable name for the refusal, so a screen can say it in the reader's
   * language. The message beside it is English developer prose: useful in a
   * log, and the wrong thing to put in front of a Norwegian curator — but
   * translating it in the view means writing the rules down a second time, and
   * a second statement of a rule drifts from the one that actually refuses the
   * save. The code is what the two share.
   */
  code: string;
  /** Substance-free values for the localised string to interpolate. */
  params?: Record<string, string | number>;
  message: string;
}

const isInstant = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

/**
 * Where a case's relative hours do not agree with the origin it declares
 * (spec §7.3).
 *
 * Exported because the entry screen has to say this while a curator is typing,
 * not only when they press save: the fix is usually a single number, and
 * finding out at submit time which of four fields it is costs more than showing
 * it beside the field.
 *
 * The failure being prevented is a silent shift of the whole timeline. A case
 * declaring the first specimen as its origin while its specimens sit at 3 h and
 * 7 h, and an exposure at 0, reads as "the dose was given at the first draw" to
 * whoever entered it and as "the dose was 3 h before the first draw" to
 * everything that computes from it. Nothing is missing and nothing throws; the
 * elapsed time is just wrong by a constant, in the direction the author cannot
 * see.
 *
 * **Durations are not instants**, and the distinction is the reason this reads
 * four fields and not six. A collection lasting 12 h and a postmortem interval
 * of 36 h mean what they mean under any origin, so a case carrying only those
 * is not on an axis at all and may declare whatever origin it likes — which is
 * also §7.3's own carve-out: nothing can be misplaced when nothing has been
 * placed.
 */
export function timeOriginProblems(caseData: PatternCaseData): TimeOriginProblem[] {
  const specimenTimes = caseData.specimens
    .map((specimen, index) => ({ index, hours: specimen.relativeTimeHours }))
    .filter((entry): entry is { index: number; hours: number } => isInstant(entry.hours));
  const exposures = caseData.context.knownExposures ?? [];
  const exposureTimes = exposures
    .map((exposure, index) => ({ index, hours: exposure.timeRelativeHours }))
    .filter((entry): entry is { index: number; hours: number } => isInstant(entry.hours));
  // A window is a placement too. Counting only points would leave the ordinary
  // reported intake — "some time that evening" — off the axis as far as this
  // function is concerned, so a case anchored entirely on ranges would skip the
  // origin's own check and could then declare an origin its hours contradict.
  const exposureRanges = exposures.filter((exposure) => {
    const range = exposure.timeRangeHours;
    return range !== undefined && isInstant(range[0]) && isInstant(range[1]);
  });
  const lastVoids = caseData.specimens.filter((specimen) =>
    isInstant(specimen.urine?.lastVoidRelativeHours),
  );
  const death = caseData.context.deathRelativeHours;

  // First, whether the origin's own event is in the case at all. This is a
  // different question from whether anything is placed on the axis, and it
  // survives the carve-out below: §7.3 lets an untimed case declare any origin
  // because nothing can be *misplaced* against an axis nobody used — not
  // because an origin may name an event the case denies. A living case
  // anchored on death is incoherent with no hours in it at all.
  if (caseData.context.timeOrigin === 'death' && !caseData.context.postmortem) {
    return [
      {
        path: ['context', 'timeOrigin'],
        code: 'time_origin_death_without_postmortem',
        message:
          'The case is anchored on death but is not a postmortem case; its hours are measured from an event it says did not happen',
      },
    ];
  }
  // The same contradiction without the origin. A living case that places death
  // on its axis is stating an event it denies — and it is worse than the
  // anchored version, because nothing on screen shows it: the editor offers the
  // death instant only while the case is postmortem, so an imported or legacy
  // case carrying both keeps a timestamp the curator can neither see nor
  // clear, while the walk that reads the axis goes on using it.
  if (!caseData.context.postmortem && isInstant(death)) {
    return [
      {
        path: ['context', 'deathRelativeHours'],
        code: 'death_instant_on_living_case',
        message:
          'The case places death on its axis but is not a postmortem case; one of the two statements has to go, and nothing on screen would show the timestamp',
      },
    ];
  }
  if (caseData.context.timeOrigin === 'declared_exposure' && exposures.length === 0) {
    return [
      {
        path: ['context', 'knownExposures'],
        code: 'time_origin_no_exposure',
        message:
          'The case is anchored on a declared exposure but declares none; there is nothing for its relative hours to be measured from',
      },
    ];
  }

  // A case with no instant anywhere is not on the axis, so no origin can
  // contradict it. An exposure alone is enough to put it there, though — "two
  // hours before the first specimen" is a placement whether or not any specimen
  // states a time, and that is the case where the axis exists but the point it
  // is anchored to has never been written down.
  const anchored =
    specimenTimes.length > 0 ||
    exposureTimes.length > 0 ||
    exposureRanges.length > 0 ||
    lastVoids.length > 0 ||
    isInstant(death);
  if (!anchored) return [];

  switch (caseData.context.timeOrigin) {
    case 'death': {
      // Death is the zero, so it cannot also be somewhere else on the axis.
      if (isInstant(death) && death !== 0) {
        return [
          {
            path: ['context', 'deathRelativeHours'],
            code: 'time_origin_death_moved',
            params: { hours: death },
            message: `The case is anchored on death, so death is at 0; it states ${death} h, which puts every other hour in the case that far from where it reads`,
          },
        ];
      }
      return [];
    }
    case 'first_specimen_collection': {
      if (specimenTimes.length === 0) {
        return [
          {
            path: ['specimens'],
            code: 'time_origin_first_specimen_untimed',
            message:
              'The case is anchored on the first specimen collection and places other hours on that axis, but no specimen states a time; the specimen the origin refers to has to be the one at 0',
          },
        ];
      }
      const earliest = specimenTimes.reduce((low, entry) => (entry.hours < low.hours ? entry : low));
      if (earliest.hours !== 0) {
        return [
          {
            path: ['specimens', earliest.index, 'relativeTimeHours'],
            code: 'time_origin_first_specimen_shifted',
            params: { hours: earliest.hours },
            message: `The earliest specimen is at ${earliest.hours} h, and the case is anchored on the first specimen collection; every hour in the case is off by that much from the axis it declares`,
          },
        ];
      }
      return [];
    }
    case 'declared_exposure': {
      // A window pinned to a single instant at zero is an exposure at zero:
      // `[0, 0]` says the intake happened at the origin as plainly as a point
      // does. A *wider* window containing zero does not — it places the intake
      // somewhere on the axis without saying where the axis begins, which is
      // the distinction this check exists for.
      const anchoring =
        exposureTimes.some((entry) => entry.hours === 0) ||
        exposureRanges.some(
          (exposure) =>
            exposure.timeRangeHours![0] === 0 && exposure.timeRangeHours![1] === 0,
        );
      if (!anchoring) {
        return [
          {
            path: ['context', 'knownExposures'],
            code: 'time_origin_exposure_not_zero',
            message:
              'The case is anchored on a declared exposure, so the exposure it is anchored to is the one at 0; none of the declared exposures states 0 — a window places an intake on the axis but does not say where the axis begins',
          },
        ];
      }
      return [];
    }
    // `admission` anchors on an event the case does not otherwise record, so
    // there is no second statement of it to disagree with. Listed rather than
    // defaulted, so a fifth origin added later fails to compile here instead of
    // silently arriving unchecked.
    case 'admission':
      return [];
  }
}

/**
 * A case whose observations all belong to a specimen it carries.
 *
 * Both of these fail silently rather than loudly, which is why they are worth
 * refusing at the boundary. `resolveObservations` reads
 * `specimenById.get(id)?.matrix ?? 'other'`, so an observation pointing at a
 * specimen that is not there becomes an `other`-matrix result — matching no
 * feature term, which name blood and urine — and disappears from the profile
 * altogether. A measured concentration is simply absent, with nothing on
 * screen to say a row was dropped.
 *
 * Duplicate specimen ids are the same failure one step earlier: the lookup is
 * a Map, so the later specimen wins and every observation naming that id is
 * read against a matrix and a creatinine that may belong to the other sample.
 *
 * Unlike a censored result with no stated threshold, neither of these
 * describes anything a laboratory can produce — an analysis belongs to a
 * sample — so refusing them turns away no real case.
 */
export const patternCaseDataSchema = patternCaseFieldsSchema.superRefine((caseData, ctx) => {
  const seen = new Set<string>();
  for (const [index, specimen] of caseData.specimens.entries()) {
    if (seen.has(specimen.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['specimens', index, 'id'],
        params: { code: 'duplicate_specimen_id', id: specimen.id },
        message: `Two specimens share the id ${specimen.id}; observations name a specimen by id, so one of them would be read against the other's matrix`,
      });
    }
    seen.add(specimen.id);
  }

  // A quantified concentration cannot be negative. `resolveObservations`
  // refuses one — it would otherwise travel as a real value, producing negative
  // ratios and a marker with no logarithm — so a stored one silently stops
  // computing when the case is reopened. Zero is kept: §8.1 makes a quantified
  // zero a real result, and a ratio can legitimately be one.
  for (const [index, observation] of caseData.observations.entries()) {
    // `quantified` means a number was reported. Without one — or without the
    // unit it was reported in — the engine resolves the row indeterminate, so
    // the case would claim a quantification it does not carry. A laboratory
    // that could not quantify says `below_limit` or `detected_not_quantified`;
    // it does not report a quantified result with no value.
    if (
      observation.qualifier === 'quantified' &&
      (observation.value === undefined || observation.unit === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['observations', index],
        params: {
          code: observation.value === undefined ? 'quantified_without_value' : 'quantified_without_unit',
          id: observation.id,
        },
        message: `Observation ${observation.id} is quantified but carries no ${observation.value === undefined ? 'value' : 'unit'}; the engine cannot compute from it, and a result that could not be quantified has its own qualifiers`,
      });
    }
    if (
      observation.qualifier === 'quantified' &&
      observation.value !== undefined &&
      observation.value < 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['observations', index, 'value'],
        params: { code: 'negative_value', id: observation.id },
        message: `Observation ${observation.id} states a negative concentration; a measurement cannot be below zero, and the engine would drop it on reopening`,
      });
    }

    // A mass result is converted with a molecular weight, and the weight comes
    // from the embedded catalog rather than from the case or the database
    // (§7.2 — one copy, not two). Where the catalog cannot weigh the substance
    // the result is reported on, the conversion fails and the row reopens
    // indeterminate, taking every ratio that reads it with it.
    //
    // The entry screen already refuses such a pick, with the reason on screen.
    // The schema did not, which is the drift this file exists to prevent: an
    // imported or legacy case walked in through the half with no rule, and the
    // screen that would have explained it never saw the substance chosen.
    //
    // Only where a mass unit is actually in play. A molar result needs no
    // weight, so a substance the catalog cannot weigh is no obstacle to it —
    // refusing there would reject cases that compute perfectly.
    // And only where there is a number to convert. A row carrying a unit and
    // no value converts nothing — `not_detected` with no printed threshold is
    // the ordinary case — so the weight is never asked for and its absence
    // costs the case nothing.
    const massBasis = observation.assay?.reportedAsDrugId ?? observation.analyte.pubchemCid;
    const inMass = (value: number | undefined, unit: string | undefined) => {
      if (value === undefined || unit === undefined) return false;
      const normalized = normalizeUnit(unit);
      return isConcentrationUnit(normalized) && isMassUnit(normalized);
    };
    const statedInMass =
      inMass(observation.value, observation.unit) ||
      inMass(observation.limitRef?.value, observation.limitRef?.unit);
    if (statedInMass && !catalogHasMolecularWeight({ pubchemCid: massBasis })) {
      ctx.addIssue({
        code: 'custom',
        path:
          observation.assay?.reportedAsDrugId === undefined
            ? ['observations', index, 'analyte']
            : ['observations', index, 'assay', 'reportedAsDrugId'],
        params: { code: 'mass_basis_unweighable', id: observation.id, cid: massBasis },
        message: `Observation ${observation.id} is reported in a mass unit on a substance the catalog cannot weigh (CID ${massBasis}); the conversion to molar fails, so the row would reopen indeterminate and its ratios would disappear`,
      });
    }
  }

  // Observation ids are the key an edit is applied by — `buildProfile` looks
  // an override up by id and rewrites every observation that answers to it —
  // and they are React keys in the view. Two rows sharing one means correcting
  // a single concentration silently changes both.
  const observationIds = new Set<string>();
  for (const [index, observation] of caseData.observations.entries()) {
    if (observationIds.has(observation.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['observations', index, 'id'],
        params: { code: 'duplicate_observation_id', id: observation.id },
        message: `Two observations share the id ${observation.id}; an edit is applied by id, so correcting one of them would rewrite both`,
      });
    }
    observationIds.add(observation.id);
  }

  // A profile is framed around a module's assumed parent, and the pipeline
  // reads `modules[0]` for it unconditionally. A case naming no module cannot
  // be opened at all — it throws rather than rendering empty — so a saved one
  // would be a case that can be filed and never read again.
  if (caseData.moduleIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['moduleIds'],
      params: { code: 'no_module' },
      message:
        'A case must name at least one substance module; the profile is framed around a module’s assumed parent, and a case without one cannot be reopened',
    });
  }
  // And name each one once. `assertModulesCompose` refuses a repeated module
  // outright — the modules in scope are a set, and a repeat would deliver every
  // signal, caution and demoted entry twice — so a case naming one twice is
  // another that can be filed and never reopened.
  if (new Set(caseData.moduleIds).size !== caseData.moduleIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['moduleIds'],
      params: { code: 'duplicate_module' },
      message:
        'A case names each substance module once; the modules in scope are a set, and the pipeline refuses a repeat rather than rendering it twice',
    });
  }

  // Urine metadata on a specimen that is not urine. Creatinine and a
  // collection duration describe nothing on a blood sample — and the last void
  // is worse than meaningless, because it anchors the case's axis from a field
  // the screen has no reason to show. Refused rather than dropped on the
  // matrix change: a creatinine entered by hand is a measurement, and deleting
  // it as a side effect of correcting a dropdown is the silent loss this
  // schema exists to prevent.
  for (const [index, specimen] of caseData.specimens.entries()) {
    if (specimen.matrix !== 'urine' && specimen.urine !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['specimens', index, 'urine'],
        params: { code: 'urine_data_on_other_matrix', id: specimen.id, matrix: specimen.matrix },
        message: `Specimen ${specimen.id} is ${specimen.matrix} but carries urine data; a creatinine describes nothing here, and a last void would still anchor the case's axis`,
      });
    }
  }

  // Exposure ids, where they are stated, name one row each. The screen tells
  // the rows apart by them — a repeat means two rows sharing React's idea of
  // which is which, so removing one can hand its half-typed dose to the other
  // and leave the number on screen different from the one filed.
  const exposureIds = new Set<string>();
  for (const [index, exposure] of (caseData.context.knownExposures ?? []).entries()) {
    if (exposure.id === undefined) continue;
    if (exposureIds.has(exposure.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'knownExposures', index, 'id'],
        params: { code: 'duplicate_exposure_id', id: exposure.id },
        message: `Two declared exposures share the id ${exposure.id}; the rows are told apart by it, so one row's entry can end up on the other`,
      });
    }
    exposureIds.add(exposure.id);
  }

  // An exposure window that runs backwards is not a window: anything reading
  // it as a duration gets a negative one, and "was the sample drawn after the
  // intake" answers both ways depending on which end it reads. A stated point
  // outside its own window is the same defect with two fields — two statements
  // about one instant, and whichever a consumer happens to read decides the
  // answer.
  for (const [index, exposure] of (caseData.context.knownExposures ?? []).entries()) {
    const range = exposure.timeRangeHours;
    if (range === undefined) continue;
    const [earliest, latest] = range;
    if (earliest > latest) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'knownExposures', index, 'timeRangeHours'],
        params: { code: 'exposure_range_backwards', earliest, latest },
        message: `An exposure window runs from ${earliest} h to ${latest} h, which is backwards; a window has to contain the hours it claims to`,
      });
      continue;
    }
    const point = exposure.timeRelativeHours;
    if (isInstant(point) && (point < earliest || point > latest)) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'knownExposures', index, 'timeRelativeHours'],
        params: { code: 'exposure_time_outside_range', hours: point, earliest, latest },
        message: `An exposure states ${point} h and a window of ${earliest}–${latest} h, which do not agree; the case says one instant twice and whichever is read decides the answer`,
      });
    }
  }

  // Spec §7.3 says the schema enforces these, and it is the right place: the
  // contradiction is between fields, so no single field's own type can hold it,
  // and a case saved past it computes wrong elapsed times rather than none.
  for (const problem of timeOriginProblems(caseData)) {
    ctx.addIssue({
      code: 'custom',
      path: problem.path,
      params: { code: problem.code, ...problem.params },
      message: problem.message,
    });
  }

  for (const [index, observation] of caseData.observations.entries()) {
    if (!seen.has(observation.specimenId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['observations', index, 'specimenId'],
        params: { code: 'dangling_specimen', id: observation.id, specimenId: observation.specimenId },
        message: `Observation ${observation.id} names specimen ${observation.specimenId}, which the case does not carry; it would resolve to no matrix and vanish from the profile`,
      });
    }
  }
});

export interface PatternCaseProblem {
  path: Array<string | number>;
  /**
   * Absent where the refusal comes from a field's own type rather than from a
   * rule written here — a unit that is not a string, an enum with no such
   * option. Those are unreachable from the entry screen's own controls, and a
   * screen showing one is looking at imported data, where the developer prose
   * is the more useful of the two anyway.
   */
  code?: string;
  params?: Record<string, string | number>;
  /** English. For logs, and as the fallback for a code with no string yet. */
  message: string;
}

/**
 * Everything standing between this case and being filed, as the schema sees it.
 *
 * The entry screen asks the schema rather than repeating its rules, because a
 * second list of the same refusals is a second thing to keep in step — and the
 * half that drifts is always the one that is not enforced, so the screen would
 * fall silent about a save the server still refuses.
 */
export function patternCaseProblems(caseData: unknown): PatternCaseProblem[] {
  const parsed = patternCaseDataSchema.safeParse(caseData);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const params = (issue as { params?: Record<string, unknown> }).params ?? {};
    const { code, ...rest } = params;
    return {
      path: [...issue.path] as Array<string | number>,
      code: typeof code === 'string' ? code : undefined,
      params: rest as Record<string, string | number>,
      message: issue.message,
    };
  });
}

/**
 * The schema and the type are two statements about one shape, so they are
 * checked against each other here rather than trusted to stay in step — in
 * **both** directions, because each catches a different mistake and neither
 * catches the other's.
 *
 * Schema-to-type catches a schema that accepts what the engine cannot read. It
 * is the one that fired first, on two fields typed as bare strings where the
 * case has closed vocabularies.
 *
 * Type-to-schema catches a field added to the interface and forgotten here.
 * Structural assignability is happy to ignore that, and the consequence is
 * quiet: the parser strips what it does not know, so the case would round-trip
 * *almost* exactly. This direction was missing, and it was already being
 * violated — the schema carried a `collectedAt` and a `hydrolysisApplied` that
 * exist nowhere in the domain, invented while writing it and never noticed
 * because nothing checked this way round.
 */
//
// Two `extends` checks are not enough for the second direction, because
// `{ a: string }` and `{ a: string; b?: string }` each extend the other: an
// extra optional property is assignable in both directions. So an optional
// field added to the interface alone would leave a mutual-assignability check
// green while `parse()` stripped it on save — the exact round-trip this guard
// advertises, broken by the addition it was meant to catch. Optional is also
// the shape most future case fields will take, `moduleVersions` included.
//
// The conditional-type identity trick below distinguishes optionality, where
// assignability does not.
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;
const _schemaMatchesType: Identical<z.infer<typeof patternCaseDataSchema>, PatternCaseData> = true;
void _schemaMatchesType;

export function isPatternCaseData(value: unknown): value is PatternCaseData {
  if (!value || typeof value !== 'object') return false;
  return (value as { kind?: unknown }).kind === PATTERN_CASE_KIND;
}

/**
 * A row as a list can honestly describe it: either a case that parses, or one
 * that does not and says so. The table stores arbitrary JSON under an
 * unconstrained `kind`, so "it claims to be a pattern case" and "it is one" are
 * different facts, and only the second may be typed as `PatternCaseData`.
 */
export type PatternCaseListEntry =
  | (Omit<PatternCaseRow, 'caseData'> & { caseData: PatternCaseData })
  | (Omit<PatternCaseRow, 'caseData'> & { caseData: null; problem: string });

export interface PatternCaseRow {
  id: number;
  name: string;
  caseData: PatternCaseData;
  createdAt: string;
  updatedAt?: string;
}

/**
 * How the registry a case was saved under compares with the one loading it.
 *
 * `unknown` is its own state and not a synonym for `current`: a case saved
 * before versions were recorded says nothing about which registry produced it,
 * and treating silence as agreement is exactly the assumption the marker
 * exists to refuse.
 */
export type RegistryStaleness =
  | { kind: 'current' }
  /** Nothing definite is known to have moved, and these modules cannot say. */
  | { kind: 'unknown'; modules: string[] }
  | {
      kind: 'moved';
      modules: Array<{ moduleId: string; savedVersion: string | null; currentVersion: string | null }>;
      /**
       * Modules the stamp is silent about, carried alongside rather than
       * instead of the known moves. A case can be both — one module bumped and
       * another never stamped — and the reader needs the precise half without
       * losing the vague one.
       */
      unknownModules: string[];
    };

export function moduleVersionsOf(
  modules: readonly PatternSubstanceModule[],
): Record<string, string> {
  return Object.fromEntries(modules.map((module) => [module.id, module.version]));
}

/**
 * Compare the versions a case was saved under with the ones loading it.
 *
 * Only the modules the case actually names are considered. A stamp left over
 * from a module since removed from `moduleIds` describes nothing this case
 * computes from, and letting it move the answer would report a case as stale
 * over a family it no longer mentions.
 *
 * A module that has since disappeared counts as moved, with a null current
 * version: the case names a family the app no longer ships, and whatever it
 * renders now is not what it rendered then.
 *
 * A module the stamp says nothing about is `unknown` rather than either. Absent
 * from the stamp and absent from the registry are different facts, and reading
 * them as agreement — both "null" — is how a case with no provenance at all
 * comes back as `current`.
 */
export function registryStaleness(
  caseData: PatternCaseData,
  modules: readonly PatternSubstanceModule[],
): RegistryStaleness {
  const ids = [...new Set(caseData.moduleIds)].sort();
  // Maps, not the records themselves. The ids come out of a stored case, so
  // `saved['toString']` answers with a function inherited from
  // `Object.prototype` rather than with the absence that is the truth — and
  // both sides inherit the same one, so an unstamped module the app does not
  // ship would compare equal to itself and read `current`. That is the exact
  // reading this function exists to refuse, reached through the lookup rather
  // than through the logic. `Object.entries` copies own keys only.
  const saved = new Map(Object.entries(caseData.moduleVersions ?? {}));
  const current = new Map(Object.entries(moduleVersionsOf(modules)));

  const unknownModules = ids.filter((id) => !saved.has(id));
  // Computed before the unknowns are answered, so a definite move is never
  // masked by a silence elsewhere. A case can be both — one module bumped, and
  // another the stamp never covered — and reporting only the vaguer of the two
  // would withhold the precise statement the reader can act on.
  const moved = ids
    .filter((id) => saved.has(id) && saved.get(id) !== current.get(id))
    .map((id) => ({
      moduleId: id,
      savedVersion: saved.get(id) ?? null,
      currentVersion: current.get(id) ?? null,
    }));

  if (moved.length > 0) return { kind: 'moved', modules: moved, unknownModules };
  return unknownModules.length > 0
    ? { kind: 'unknown', modules: unknownModules }
    : { kind: 'current' };
}

/**
 * Why a case could not be written down or read back, as a name rather than as
 * a sentence.
 *
 * The screen is Norwegian, and a store that carries English prose leaves a
 * React boundary with nothing to translate — the same rule that put codes on
 * every schema refusal (AGENTS.md). The prose travels with the code for logs
 * and for a developer reading a stack trace; the code is what reaches a reader.
 */
export type PatternCaseErrorCode =
  /** The case itself is not filable: the schema refused it. */
  | 'save_refused'
  /** The request failed — network, session, server. */
  | 'request_failed'
  /** The row exists and is some other kind of saved case. */
  | 'not_pattern_case'
  /** The row is a pattern case the current schema cannot read. */
  | 'schema_mismatch';

export class PatternCaseError extends Error {
  constructor(
    readonly code: PatternCaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PatternCaseError';
  }
}

async function casesFetch(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new PatternCaseError(
      'request_failed',
      `Pattern case request failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

/**
 * Save, stamping the registry the case was computed under.
 *
 * The stamp is taken here rather than by the caller so it cannot be forgotten,
 * and it records the modules *in scope for this case* rather than every module
 * the app ships — a version bump to a family this case never mentions is not a
 * change to this case.
 */
export async function savePatternCase(
  name: string,
  caseData: PatternCaseData,
  modules: readonly PatternSubstanceModule[],
  caseId?: number,
): Promise<PatternCaseRow> {
  const inScope = modules.filter((module) => caseData.moduleIds.includes(module.id));
  const resolved = moduleVersionsOf(inScope);
  // A module the app no longer ships keeps the version it was stamped with.
  // Re-stamping only what resolves would drop it, and a stamp that says nothing
  // about a module compares equal to a registry that has nothing to say about
  // it either — so the next load would read `current`, and an ordinary re-save
  // would erase the one statement that this case was computed by a registry
  // this app no longer has.
  //
  // Only for modules the case still names, though: a stamp kept for a module
  // dropped from `moduleIds` would go on describing something this case no
  // longer computes from, and a later version bump to that family would report
  // the case stale over a module it does not mention.
  //
  // An own-property test rather than `in`, which answers for the whole
  // prototype chain: a module id of `toString` is `in` every object there is,
  // so the stamp this branch exists to keep would be the one it dropped.
  // (`Object.hasOwn` would say it plainer, but it needs the ES2022 lib and this
  // project targets ES2020.)
  const retained = Object.fromEntries(
    Object.entries(caseData.moduleVersions ?? {}).filter(
      ([id]) =>
        !Object.prototype.hasOwnProperty.call(resolved, id) && caseData.moduleIds.includes(id),
    ),
  );
  const stamped: PatternCaseData = {
    ...caseData,
    moduleVersions: { ...retained, ...resolved },
  };
  const parsed = patternCaseDataSchema.safeParse(stamped);
  if (!parsed.success) {
    // Refused before it reaches the database rather than after: a case that
    // cannot be read back is worse than one that was never written, because
    // the writer believes it is filed.
    throw new PatternCaseError(
      'save_refused',
      `Refusing to save a malformed pattern case: ${parsed.error.message}`,
    );
  }

  // What is stored is what was validated, not what was handed in. With the
  // parity check above holding the two shapes together, the parsed value cannot
  // be missing anything the case carries — and sending it means a field the
  // schema does not know about cannot reach the database unexamined.
  const validated = parsed.data as PatternCaseData;
  const row = (await casesFetch(
    caseId ? `/api/simulator/cases?id=${caseId}` : '/api/simulator/cases',
    {
      method: caseId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, caseData: validated }),
    },
  )) as PatternCaseRow;
  return { ...row, caseData: validated };
}

export interface LoadedPatternCase extends PatternCaseRow {
  staleness: RegistryStaleness;
}

export async function loadPatternCase(
  id: number,
  modules: readonly PatternSubstanceModule[],
): Promise<LoadedPatternCase> {
  const row = (await casesFetch(`/api/simulator/cases?id=${id}`)) as {
    id: number;
    name: string;
    caseData: unknown;
    createdAt: string;
    updatedAt?: string;
  };
  if (!isPatternCaseData(row.caseData)) {
    throw new PatternCaseError(
      'not_pattern_case',
      'That saved case is not a metabolite ratio profile case',
    );
  }
  // Validated on the way out as well as in. A row can predate a schema change,
  // or have been written by something else entirely, and a profile computed
  // from half-understood data would render as an ordinary assessment.
  const parsed = patternCaseDataSchema.safeParse(row.caseData);
  if (!parsed.success) {
    throw new PatternCaseError(
      'schema_mismatch',
      `Saved case does not match the current schema: ${parsed.error.message}`,
    );
  }

  const caseData = row.caseData;
  return {
    id: row.id,
    name: row.name,
    caseData,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    staleness: registryStaleness(caseData, modules),
  };
}

/**
 * One page of saved cases, newest first.
 *
 * Paged rather than "all of them", because the endpoint pages whether a caller
 * asks or not: it defaults to fifty rows and caps at a hundred. A wrapper
 * taking no arguments would look like a complete list and quietly be a first
 * page, so a picker built on it would lose a curator's older work with nothing
 * to indicate it. The endpoint reports no total, so a full page is the signal
 * that another may exist.
 */
export async function listPatternCases(
  page: { limit?: number; offset?: number } = {},
): Promise<PatternCaseListEntry[]> {
  const params = new URLSearchParams({ kind: PATTERN_CASE_KIND });
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  if (page.offset !== undefined) params.set('offset', String(page.offset));

  // The list endpoint answers `{ cases: [...] }` while the single-case, create
  // and update paths answer the row itself. Reading the list as a bare array
  // fails silently — every case filtered out as "not a pattern case", so a
  // curator with saved work sees an empty list rather than an error.
  const body = (await casesFetch(`/api/simulator/cases?${params}`)) as { cases?: unknown };
  const rows = Array.isArray(body?.cases) ? (body.cases as Array<Record<string, unknown>>) : [];

  return rows
    .filter((row) => isPatternCaseData(row?.caseData))
    .map((row) => {
      const base = {
        id: Number(row.id),
        name: String(row.name ?? ''),
        createdAt: String(row.createdAt ?? ''),
        updatedAt: row.updatedAt === undefined ? undefined : String(row.updatedAt),
      };
      // Validated before its type says it is valid. The table stores arbitrary
      // JSON, so a row can carry the right `kind` and still be missing
      // specimens or context — and a picker told that is a whole
      // `PatternCaseData` would read fields that are not there.
      const parsed = patternCaseDataSchema.safeParse(row.caseData);
      return parsed.success
        ? { ...base, caseData: parsed.data as PatternCaseData }
        : // Listed rather than hidden: the case exists, the curator saved it,
          // and a picker that silently omitted it would look like lost work
          // instead of a case that needs attention.
          { ...base, caseData: null, problem: parsed.error.message };
    });
}

/** The endpoint's own ceiling, so a caller asking for a full page can say so. */
export const PATTERN_CASE_PAGE_MAX = 100;
