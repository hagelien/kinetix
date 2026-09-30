/**
 * Case Pattern Explorer — case data and derived result types.
 *
 * Transcribed from `docs/plans/2026-08-10-case-pattern-explorer.md` §7 and §17,
 * narrowed to what Phase 0 of the metabolite ratio profile actually computes
 * (`docs/plans/2026-08-11-metabolite-ratio-profile.md` §10). Fields the later
 * phases own — persistence markers, analysis snapshots, expert overrides — are
 * deliberately absent rather than stubbed: Phase 0 renders from an in-memory
 * fixture, and a field nothing writes is a field nothing can be trusted to
 * round-trip.
 *
 * Identity is `drugs.pubchem_cid` throughout, never a slug: `applyParameterChange`
 * regenerates a slug whenever the name it derives from changes, so keying on one
 * would unresolve a registry entry over ordinary curation (spec §16.5).
 */

export const PATTERN_CASE_KIND = 'pattern-case' as const;

/** Catalog identity of a substance. `slug` is a diagnostic hint, never a key. */
export interface PatternDrugRef {
  pubchemCid: number;
  slug?: string;
}

/**
 * A citation by resolvable handle. `freetext` is excluded: it identifies nothing,
 * so it cannot serve as a registry key (spec §16.5).
 */
export interface PatternCitationRef {
  type: 'pmid' | 'doi' | 'url';
  identifier: string;
}

export type PatternMatrix =
  | 'whole_blood'
  | 'femoral_blood'
  | 'cardiac_blood'
  | 'serum'
  | 'plasma'
  | 'urine'
  | 'vitreous'
  | 'other';

/**
 * What the laboratory actually measured. A result entered as "total oxazepam
 * after hydrolysis" has to stay distinguishable from "intact oxazepam
 * glucuronide" even though both land on the same lineage (spec §7.2), because
 * §7.4's artefact rules and Phase 3's band matching both key on it.
 */
export type PatternMeasurandMode =
  | 'direct'
  | 'free'
  | 'direct_conjugate'
  | 'total_after_hydrolysis'
  | 'class_response'
  | 'unknown';

/**
 * How the result relates to the method's reporting limit. Censoring is modelled
 * from the first release because a real case is full of it (§8.2) — and because
 * a `<LOQ` silently coerced to a number is the error class this screen exists to
 * prevent.
 */
export type PatternObservationQualifier =
  | 'quantified'
  | 'below_limit'
  | 'above_limit'
  | 'detected_not_quantified'
  | 'not_detected';

export interface PatternLimitRef {
  /** The threshold's name *as the source states it* — not mapped to LOD/LOQ. */
  label: string;
  value: number;
  unit: string;
  /**
   * Where the label came from, so a laboratory's own threshold and one read off
   * a paper stay distinguishable (spec §7.2).
   *
   * Optional, where the spec has it required, and the difference is deliberate:
   * an imported or legacy limit whose provenance nobody recorded has to be
   * representable as *unstated*. The alternative is defaulting it, and the only
   * plausible default is `manual` — which would assert that a person typed a
   * threshold that in fact arrived in a file. A screen where a person does type
   * it says `manual` because that is then true.
   */
  source?: 'method_component' | 'publication' | 'manual';
  /** The method column this came from, when it came from one. */
  column?: 'lod' | 'lor' | 'mkk';
  /** See `PatternObservation.reportedDecimals`. */
  reportedDecimals?: number;
}

export interface PatternSpecimen {
  id: string;
  label?: string;
  matrix: PatternMatrix;
  /** Hours from the case's declared time origin; negative before it. */
  relativeTimeHours?: number;
  urine?: {
    creatinineMmolL?: number;
    specificGravity?: number;
    /** A *duration*, not an instant: it is not measured from the origin. */
    collectionDurationHours?: number;
    /** An instant, on the case's axis like every other relative hour (§7.3). */
    lastVoidRelativeHours?: number;
  };
  postmortem?: {
    /** Death to collection. A duration, so the origin does not move it. */
    postmortemIntervalHours?: number;
    storageDurationHours?: number;
  };
}

export interface PatternAssayOverride {
  measurandMode?: PatternMeasurandMode;
  /** Species whose MW defines the laboratory's reported mass basis. */
  reportedAsDrugId?: number;
  limits?: PatternLimitRef[];
}

export interface PatternObservation {
  id: string;
  specimenId: string;
  /** Catalog identity of the analyte, by PubChem CID. */
  analyte: PatternDrugRef;
  value?: number;
  /**
   * How many decimals the source reported, where that differs from what the
   * number carries.
   *
   * A concentration reported as `1.50` is a statement about the assay's
   * precision, and `Number('1.50')` is `1.5` — so reconstructing the display
   * from the number silently drops the laboratory's last significant digit.
   * JavaScript cannot hold the distinction, so it is recorded beside the value
   * rather than inferred from it, and it travels to report output the same way.
   */
  reportedDecimals?: number;
  unit?: string;
  qualifier: PatternObservationQualifier;
  /**
   * Required whenever the qualifier is censored: without it a saved `<X` cannot
   * say what X was (spec §9.1).
   */
  limitRef?: PatternLimitRef;
  assay?: PatternAssayOverride;
  note?: string;
}

export interface PatternKnownExposure {
  /**
   * A stable identity for the row, as specimens and observations have.
   *
   * The list is edited in place, and without one a row is only its position:
   * removing the first exposure slides the second into its index, where the
   * screen hands it the state of the row that just went. Optional because an
   * imported account has no such id and inventing one on read would make the
   * same case parse differently each time.
   */
  id?: string;
  drug: PatternDrugRef;
  certainty: 'confirmed' | 'reported' | 'suspected';
  /**
   * How it was taken and how much, as the account states it (spec §7.1, A6.6).
   *
   * Nothing in this release computes from a milligram amount — a ratio is not
   * a dose reconstruction — and that was the reason these were left out. It
   * was the wrong reason: the plan asks Phase 1 for the *stated dose and time
   * of intake*, and an account given once is not given again. A field nothing
   * reads yet is a field a curator can still fill; a field that does not exist
   * loses the evidence for good.
   */
  route?: string;
  amount?: number;
  amountUnit?: string;
  timeRelativeHours?: number;
  /**
   * `[earliest, latest]`, both on the case's axis (spec §7.3), for the ordinary
   * case where an intake is placed in a window rather than at a point — "some
   * time that evening" is what a witness statement usually amounts to, and
   * flattening it to a midpoint would state a precision nobody has.
   *
   * It anchors the case exactly as a point does: a window is a placement, so a
   * case carrying only ranges is on the axis and gets the origin's own check.
   */
  timeRangeHours?: [number, number];
}

export interface PatternCaseContext {
  postmortem: boolean;
  /**
   * The one zero every relative hour in this case is measured from (§7.3).
   *
   * Without it the same chronology encodes three incompatible ways — anchored
   * on dose, on death, on admission — and a time-conditioned comparison would
   * put two timelines on one axis that never shared a point.
   */
  timeOrigin: 'first_specimen_collection' | 'declared_exposure' | 'death' | 'admission';
  /**
   * When death falls on the case's axis, where a case is anchored on something
   * else. An instant, and the reason `timeOrigin: 'death'` is checkable at all:
   * the postmortem interval beside a specimen is a duration and says nothing
   * about where the origin sits.
   */
  deathRelativeHours?: number;
  knownExposures?: PatternKnownExposure[];
  /** Context field id → option **value**, never a label (§7.2). */
  fields: Record<string, string>;
}

export interface PatternNormalizationConfig {
  /**
   * One convention per case, spec §11.3's default. Recorded in the manifest so a
   * cohort standardised at another reference cannot score this case (§8.1).
   */
  creatinineReferenceMmolL: number;
}

export interface PatternCaseData {
  kind: typeof PATTERN_CASE_KIND;
  schemaVersion: 1;
  specimens: PatternSpecimen[];
  observations: PatternObservation[];
  context: PatternCaseContext;
  normalization: PatternNormalizationConfig;
  /** Modules in scope. Phase 2 unions several without duplication (§10). */
  moduleIds: string[];
  /**
   * The registry version each module was at when the case was saved.
   *
   * A profile is not stored — it is recomputed from the case every time it is
   * opened, which is right, because a corrected band or a withdrawn threshold
   * rule should reach an old case. But recomputing *silently* means a case can
   * read differently from the day it was filed with nothing on screen saying
   * so, and in a forensic setting that is the difference between a corrected
   * assessment and an unexplained one. Recording the versions is what lets the
   * view say the registry moved.
   *
   * Optional because cases written before this existed have no answer, and
   * "saved under an unknown version" is a different statement from "saved under
   * this one" — it is stated rather than assumed current.
   */
  moduleVersions?: Record<string, string>;
  /**
   * That this case began as the demonstration fixture, kept with the case.
   *
   * The screen marks such a case in red, and until now it knew from the object
   * in hand — which lasts exactly as long as the working copy does. File the
   * example under a name and the saved case comes back a different object,
   * so the demonstration's fabricated concentrations would sit in a case list
   * presenting as ordinary casework. That is the one moment the warning is
   * worth most.
   *
   * It survives editing on purpose. A case built by changing a few values of
   * the fixture is not thereby real: whatever was not overwritten is still
   * invented, and a reader has no way to tell which half is which. Losing the
   * marker at the first keystroke would make the warning easiest to shed by
   * exactly the action that makes it matter.
   *
   * Absent on an ordinary case rather than `'manual'`: this says where a case
   * came from only where something is known about it, and cases filed before
   * this existed have no answer.
   */
  origin?: 'example';
}

/**
 * A closed or half-open interval. `null` means unbounded on that side, which is
 * how a censored operand survives the arithmetic instead of being flattened to
 * its limit — the whole reason §8.2 exists.
 */
export interface PatternNumericInterval {
  low: number | null;
  high: number | null;
}

export type PatternResultStatus =
  | 'point'
  | 'interval'
  | 'lower_bound'
  | 'upper_bound'
  | 'indeterminate'
  | 'blocked';

/** An observation resolved to canonical µmol/L, censoring preserved. */
export interface ResolvedObservation {
  observationId: string;
  specimenId: string;
  analyte: PatternDrugRef;
  matrix: PatternMatrix;
  measurandMode: PatternMeasurandMode;
  status: PatternResultStatus;
  /** µmol/L. Unbounded sides stay null; see PatternNumericInterval. */
  micromolarPerL: PatternNumericInterval;
  qualifier: PatternObservationQualifier;
}

export interface PatternWarning {
  code: string;
  /** Substance-free: the view resolves this through the locale files. */
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface PatternNormalizationDescriptor {
  /** True only where operands crossed specimens and `k` did not cancel (§8.1). */
  applied: boolean;
  basis: 'creatinine' | 'none';
  referenceMmolL?: number;
  factor?: number;
}

export interface PatternFeatureResult {
  featureId: string;
  featureVersion: string;
  status: PatternResultStatus;
  /** The raw fold ratio. Always available alongside the log coordinate. */
  rawValue?: PatternNumericInterval;
  /** Creatinine-normalised variant, present only on cross-matrix features. */
  normalizedValue?: PatternNumericInterval;
  log10Value?: PatternNumericInterval;
  normalization: PatternNormalizationDescriptor;
  calculationWarnings: PatternWarning[];
}
