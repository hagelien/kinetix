/**
 * Feature results → `RatioProfileViewModel` (§9).
 *
 * This is the generalisation boundary. The model carries resolved label keys,
 * formatted values, band geometry as percentages and marker states — and **no
 * substance identity beyond a display string**. A grep of this file and of
 * `src/components/modeling/pattern/` for any analyte name or ratio threshold is
 * one of the two mechanical acceptance tests in §4.1; if it passes, the rest is
 * detail.
 */

import type {
  PatternFeatureResult,
  PatternNumericInterval,
  PatternResultStatus,
  PatternWarning,
} from '../../types/patternCase.js';
import type { ArtefactFlag } from './artefactRules.js';
import type { PatternContextFieldDefinition, PatternModifier } from './contextFields.js';
import { contextSummary, defaultValue } from './contextFields.js';
import { isNotEstablished, type SignalVM } from './evaluateSignals.js';
import {
  RATIO_GROUPS,
  featureGroup,
  isActive,
  type PatternFeatureDefinition,
  type PatternFeatureKind,
  type PatternRatioGroup,
} from './featureRegistry.js';
import { formatForEditing, formatInterval, formatMeasured, formatRatio } from './format.js';
import type { PatternNotEstablishedDefinition } from './signals.js';
import type { SourceAmbiguity } from './sourceAmbiguity.js';
import type { PatternSubstanceModule } from './substanceModules.js';

export interface AxisVM {
  lo: number;
  hi: number;
  ticks: number[];
  /**
   * Where parity sits, as a percentage. A logarithmic axis is not generally
   * symmetric around 1 — on a pinned span it rarely lands at the midpoint — so a
   * line drawn at the centre would put every marker between the two on the
   * wrong side of parity.
   */
  parityPct: number;
}

export interface MarkerVM {
  /** 0–100 along the shared log axis. */
  positionPct: number;
  /**
   * The far endpoint, for a result that spans one. An interval draws between
   * the two; a bound draws a ray from `positionPct` toward the unbounded rim.
   * Collapsing every result to a single tick would let the plot contradict the
   * value cell, which reads `<X`, `>X` or `X–Y` (§8.2).
   */
  endPct?: number;
  /** Which way a censored result is open, if it is. */
  bound: 'lower' | 'upper' | null;
  /** True for a two-sided interval, so the track draws both rims. */
  isInterval: boolean;
  /** Clamped to a rim rather than dropped — never clip, never drop (§8.3). */
  outOfAxis: 'low' | 'high' | null;
  /**
   * The same, for `endPct`. An interval has two endpoints and either can leave
   * the axis independently of the other.
   */
  endOutOfAxis: 'low' | 'high' | null;
  /**
   * A quantified zero is off *every* logarithmic axis, not off the left end of
   * this one, so it renders at the left rim with its own label rather than the
   * out-of-axis wording that would imply a wider view could find it.
   */
  isZero: boolean;
}

export interface BandVM {
  p5Pct: number;
  p50Pct: number;
  p95Pct: number;
  /** Formatted bounds, so the plot's text equivalent can state them (§9.3). */
  p5Text: string;
  p50Text: string;
  p95Text: string;
  /**
   * Always true in this release. A band without provenance is hatched and
   * carries no statistic — the hatching is the entire warning, which is why the
   * flag is on the view model rather than inferred from a missing field.
   */
  provisional: boolean;
}

export interface RatioRowVM {
  featureId: string;
  labelKey: string;
  basisKey?: string;
  kind: PatternFeatureKind;
  /** Derived from `kind`, not authored: a branch product is not a step (§7.1). */
  kindNoteKey?: string;
  status: PatternResultStatus;
  valueText: string;
  normalizedValueText?: string;
  /**
   * Which of the two values the track plots. It follows the band's declared
   * basis, because the plot's only job is to place the value in that
   * distribution — and it is stated so the value cell can name the plotted one
   * rather than leaving the reader to identify it by position.
   */
  plottedBasis: 'raw' | 'normalized';
  /**
   * Set where a feature has a band that cannot be compared with this case's
   * value. Withholding it silently would read as "no reference exists", which is
   * a different and untrue statement.
   */
  bandWithheldNoteKey?: string;
  marker: MarkerVM | null;
  band: BandVM | null;
  warnings: PatternWarning[];
  /** Cautions from the assay artefact rules — shown, never suppressing. */
  artefactNoteKeys: string[];
  /**
   * Which way a selected context option is expected to move this ratio (§7.5).
   *
   * Stated, never applied: a modifier does not adjust a value. What it does is
   * tell a reader that the number in front of them has a declared explanation
   * besides the one the feature is about — a co-medication that induces the
   * enzyme, say — which is the difference between reading a high ratio as fast
   * metabolism and reading it as an interaction.
   *
   * `unclear` where two selected options bear on the same ratio, whatever they
   * each say: that is the case Layer A objected to, where the value gets
   * attributed to whichever explanation the reader thought of first, and naming
   * one direction there would make the pick for them.
   */
  expectedDirection?: 'increases' | 'decreases' | 'unclear';
}

export interface RatioGroupVM {
  group: PatternRatioGroup;
  /** The matrix heading — "Blod", "Urin", "Kryssmatrise". */
  headingKey: string;
  regimeNoteKey: string;
  rows: RatioRowVM[];
  /** Features deliberately not offered, stated rather than left to inference. */
  withdrawnNoteKeys: string[];
}

export interface ContextFieldVM {
  id: string;
  labelKey: string;
  shortKey: string;
  /** The selected option's stored value, so an editor can round-trip it. */
  value: string;
  valueLabelKey: string;
  /**
   * The selected option's own label, where it has one instead of a key —
   * a generated co-medication naming a substance the catalog holds. See
   * `PatternContextOption.label`.
   */
  valueLabel?: string;
  /** See `PatternContextOption.labelSuffixKey`. */
  valueLabelSuffixKey?: string;
  state: 'known' | 'assumed' | 'missing';
  /**
   * Every option an editor may offer, including — when the stored value matches
   * none of the field's own options — a sentinel carrying that value.
   *
   * Without the sentinel a `<select>` bound to `value` finds no match and the
   * browser displays its first option instead, so the screen would show a known
   * answer for a field the engine is treating as missing.
   */
  options: Array<{ value: string; labelKey: string; label?: string; labelSuffixKey?: string }>;
}

/**
 * The source-ambiguity statement. It renders directly under the provisional
 * line, naming each candidate and what it could account for — **not** as a
 * signal, because it is not evidence for a proposition (§7.3).
 */
export interface SourceAmbiguityVM {
  statusKind: 'not_applicable' | 'unresolved' | 'mixed_source';
  candidates: Array<{
    labelKey: string;
    /**
     * Identity, kept even where no loaded module names the substance. The
     * upstream walk exists to reach substances outside the module, so those are
     * the candidates that matter most — rendering several of them as one
     * anonymous line would hide the very finding the walk produced.
     */
    pubchemCid: number;
    slug?: string;
    direction: 'downstream' | 'upstream';
    role: 'sole_capable' | 'contributing';
  }>;
  /**
   * Which sources the case actually declares. `mixed_source` asserts that
   * several administered substances fed the profile, and a reader cannot check
   * that claim against a list of every candidate the graph allows — the two
   * facts are different and are stated separately.
   */
  declared: Array<{
    labelKey: string;
    pubchemCid: number;
    slug?: string;
    certainty: 'confirmed' | 'reported';
  }>;
  /**
   * The parent this assessment is framed on, when the case names more than one
   * module and so has more than one parent it could have been framed on.
   *
   * One assessment per module is what a two-module case actually wants, and it
   * is Phase 2's work. Until then the profile frames the walk on the first
   * module's parent — which is a defensible reading of *that* module's
   * substances and says nothing about the other's. What is not defensible is
   * doing it silently: a case spanning two families would otherwise present a
   * statement framed on one of them, or a `not_applicable` that renders as no
   * statement at all, and a reader has no way to see which substances it was
   * ever about.
   *
   * Null for the ordinary single-module case, where there is nothing to choose
   * between and naming the parent would only add noise.
   */
  framedOn: { labelKey: string; pubchemCid: number; slug?: string } | null;
  /** Which module's lineage this assessment is about. */
  moduleId: string;
}

export interface NotEstablishedVM {
  id: string;
  titleKey: string;
  rationaleKey: string;
}

export interface MethodDisclosureVM {
  /** Every citation the rendered features and signals rest on. */
  citations: Array<{ type: 'pmid' | 'doi' | 'url'; identifier: string }>;
  /**
   * What may honestly be said about normalisation, or absent where nothing may:
   * a case in which no cross-matrix ratio computed has nothing to disclose about
   * a correction that never ran.
   */
  normalizationBasisKey?: string;
  /** Already formatted for the reader's locale. */
  creatinineReferenceText?: string;
}

export interface ObservationRowVM {
  id: string;
  /** The analyte's display name, resolved through the module registry. */
  labelKey: string;
  /**
   * Identity, for the ordinary case of a panel reporting a substance outside
   * every loaded module. The label key is empty there, and falling back to the
   * observation id shows a reader an opaque row identifier where an analyte
   * name belongs — the same failure the source candidates already fixed.
   */
  pubchemCid: number;
  slug?: string;
  specimenLabel: string;
  value?: number;
  /** The precision the source reported, where it differs from the number's. */
  reportedDecimals?: number;
  /**
   * The value formatted for the reader's locale. The raw `value` stays for the
   * editor — `<input type="number">` parses only a dot decimal — but nothing
   * read-only should render it, or a Norwegian screen shows a decimal point in
   * the measurement column beside a decimal comma in every ratio.
   */
  valueText?: string;
  /**
   * The same value with the locale's decimal separator but **no grouping**, for
   * an editable field. `valueText` is right to read and cannot be typed back:
   * the parser rejects Norwegian's non-breaking space and reads English's
   * `1,000` as ambiguous, so an editor bound to it can only be cleared, never
   * corrected.
   */
  editText?: string;
  unit?: string;
  qualifier: string;
  /**
   * The threshold a censored result was reported against, under the source's own
   * label. Without it a `<X` cannot say what X was, and a non-detect renders
   * identically to a measurement nobody entered (spec §9.1).
   */
  limit?: {
    label: string;
    value: number;
    unit: string;
    valueText: string;
    reportedDecimals?: number;
  };
}

/**
 * A quantity of the specimen rather than of an analyte.
 *
 * Creatinine is the one that matters in this release, and it matters a lot: it
 * is the sole input to every normalised value on screen, and until it was shown
 * a reader could see the reference the correction targets and the corrected
 * result without ever seeing the measurement the correction was computed from —
 * so an erroneous specimen value had nowhere to become visible.
 */
export interface SpecimenMetricRowVM {
  specimenId: string;
  specimenLabel: string;
  labelKey: string;
  valueText: string;
  unit: string;
}

export interface RatioProfileViewModel {
  observations: ObservationRowVM[];
  specimenMetrics: SpecimenMetricRowVM[];
  provisional: { anyProvisional: boolean; provisionalCount: number; totalBands: number };
  /**
   * One assessment per module in scope, each framed on that module's own
   * parent. A single-module case has one; a case spanning two has two, because
   * "what else could have produced this pattern" is a question about a lineage
   * and each module brings its own.
   */
  sourceAmbiguities: SourceAmbiguityVM[];
  contextFields: ContextFieldVM[];
  contextSummary: { missing: number; assumed: number };
  ratioGroups: RatioGroupVM[];
  axis: AxisVM;
  signals: SignalVM[];
  notEstablished: NotEstablishedVM[];
  method: MethodDisclosureVM;
}

/** The sub-label a feature kind derives. Only `branch_ratio` carries one today. */
const KIND_NOTE_KEYS: Partial<Record<PatternFeatureKind, string>> = {
  branch_ratio: 'pattern.profile.kind.branchRatio.note',
};

/**
 * The dilution regime each group is read under — one note per group, because
 * the reason a ratio is dilution-free differs by matrix and a shared note would
 * have to be vague enough to cover both.
 */
const GROUP_NOTE_KEYS: Record<PatternRatioGroup, string> = {
  blood: 'pattern.profile.regime.blood',
  urine: 'pattern.profile.regime.urine',
  cross_matrix: 'pattern.profile.regime.crossMatrix',
};

const GROUP_HEADING_KEYS: Record<PatternRatioGroup, string> = {
  blood: 'pattern.profile.group.blood',
  urine: 'pattern.profile.group.urine',
  cross_matrix: 'pattern.profile.group.crossMatrix',
};

/**
 * Compute the shared axis (§8.3).
 *
 * One axis for every group is the invariant that matters: two ratios on one
 * screen scaled differently is the incoherence the design exists to avoid.
 *
 * Zero never enters the extent. §8.1 made a quantified zero a real value, and
 * `log10(0)` is `−Infinity`, so one such value would otherwise collapse the axis
 * for every row sharing it.
 */
export function computeAxis(
  values: number[],
  options: { pin?: { lo: number; hi: number } } = {},
): AxisVM {
  // An invalid pin is ignored rather than obeyed: the axis computed from the
  // case's own values is always drawable, and a blank screen would be a worse
  // answer than a correct axis the module did not ask for. The registry check
  // is what tells the curator; this is what keeps the page alive.
  if (options.pin && isValidAxisPin(options.pin.lo, options.pin.hi)) {
    return {
      ...options.pin,
      ticks: decadeTicks(options.pin.lo, options.pin.hi),
      parityPct: parityPosition(options.pin.lo, options.pin.hi),
    };
  }

  const positives = values.filter((v) => Number.isFinite(v) && v > 0);
  // 1.0 always participates: parity is the reference every ratio is read
  // against, and an axis that excluded it would hide which side of it a value
  // sits on.
  positives.push(1);

  const min = Math.min(...positives);
  const max = Math.max(...positives);

  let loExp = Math.floor(Math.log10(min) - 0.15);
  let hiExp = Math.ceil(Math.log10(max) + 0.15);

  // At least two decades, at most five. A value still outside gets the
  // out-of-axis treatment: four decades from its band is information, not a
  // scaling problem.
  while (hiExp - loExp < 2) {
    hiExp += 1;
    if (hiExp - loExp < 2) loExp -= 1;
  }
  if (hiExp - loExp > 5) {
    const centre = (loExp + hiExp) / 2;
    loExp = Math.round(centre - 2.5);
    hiExp = loExp + 5;

    // Centring the window can push it off parity entirely — a lone value at
    // 1e10 centres on 1e3–1e8, which puts the parity line at a negative
    // percentage and draws it outside the track. 1.0 was added to the extent
    // precisely so it could not be excluded, and the cap must not undo that.
    // A value left outside gets the out-of-axis treatment, which is the
    // documented answer for a value four decades from its band.
    if (loExp > 0) {
      loExp = 0;
      hiExp = 5;
    } else if (hiExp < 0) {
      hiExp = 0;
      loExp = -5;
    }
  }

  const lo = 10 ** loExp;
  const hi = 10 ** hiExp;
  return { lo, hi, ticks: decadeTicks(lo, hi), parityPct: parityPosition(lo, hi) };
}

function parityPosition(lo: number, hi: number): number {
  const span = Math.log10(hi) - Math.log10(lo);
  return ((0 - Math.log10(lo)) / span) * 100;
}

function decadeTicks(lo: number, hi: number): number[] {
  // The first decade at or above `lo`, the last at or below `hi`. Rounding
  // instead would put a tick outside the axis on any pinned span that is not
  // itself a decade — the shipped pin starts below one, and its label landed at
  // a negative percentage, drawn into the neighbouring column.
  const ticks: number[] = [];
  const first = Math.ceil(Math.log10(lo) - 1e-9);
  const last = Math.floor(Math.log10(hi) + 1e-9);
  // `Math.log10(0)` is `-Infinity`, and `-Infinity + 1` is `-Infinity`: the
  // loop below would never advance and the page would freeze rather than render
  // wrongly. `isValidAxisPin` rejects such a span before it reaches here, and
  // this stays as the guard of last resort — an infinite loop is the one
  // failure mode nobody can diagnose from the screen.
  if (!Number.isFinite(first) || !Number.isFinite(last)) return ticks;
  for (let exp = first; exp <= last; exp += 1) ticks.push(10 ** exp);
  return ticks;
}

/**
 * Whether a pair of bounds describes a span a logarithmic axis can draw.
 *
 * Zero and negative numbers have no logarithm, and `lo >= hi` is not a span. A
 * module may legitimately think `lo: 0` is how you start an axis — it is, on a
 * linear one — so this is checked rather than assumed, at registry load where a
 * curator sees it and here where the arithmetic happens.
 */
function isValidLogSpan(lo: number, hi: number): boolean {
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo;
}

/**
 * Whether a module's pin is an axis this view can draw.
 *
 * Drawable is not enough: a pin must also contain parity. Every ratio here is
 * read against 1 — which side of it a value sits on *is* the finding — and the
 * axis computed from a case's own values puts 1 in the window unconditionally
 * for exactly that reason. A pin that excludes it, say `{ lo: 10, hi: 100 }`,
 * is a perfectly valid logarithmic span whose parity line lands at −100%:
 * outside the track, invisible, and every marker on the plot then floats with
 * nothing to be above or below.
 */
export function isValidAxisPin(lo: number, hi: number): boolean {
  return isValidLogSpan(lo, hi) && lo <= 1 && hi >= 1;
}

function positionOf(value: number, axis: AxisVM): { pct: number; outOfAxis: 'low' | 'high' | null } {
  const span = Math.log10(axis.hi) - Math.log10(axis.lo);
  const raw = ((Math.log10(value) - Math.log10(axis.lo)) / span) * 100;
  if (raw < 0) return { pct: 0, outOfAxis: 'low' };
  if (raw > 100) return { pct: 100, outOfAxis: 'high' };
  return { pct: raw, outOfAxis: null };
}

/**
 * An observation as the caller has it, before formatting. The display text is
 * derived here rather than supplied, so the caller cannot pass a locale to
 * `buildRatioProfile` and a differently-formatted string alongside it.
 */
export type ObservationInputRow = Omit<ObservationRowVM, 'valueText' | 'editText' | 'limit'> & {
  limit?: { label: string; value: number; unit: string; reportedDecimals?: number };
};

export interface BuildProfileInput {
  /** The case's observations, so the view can offer the edit §10 requires. */
  observations?: ObservationInputRow[];
  /** Specimen-level quantities the profile computes from, for the same reason. */
  specimenMetrics?: Array<Omit<SpecimenMetricRowVM, 'valueText'> & { value: number }>;
  /** Exposures the case positively declares, for the ambiguity statement. */
  declaredExposures?: Array<{
    pubchemCid: number;
    slug?: string;
    certainty: 'confirmed' | 'reported';
  }>;
  modules: PatternSubstanceModule[];
  features: PatternFeatureDefinition[];
  results: PatternFeatureResult[];
  contextFields: PatternContextFieldDefinition[];
  selectedContext: Record<string, string>;
  signals?: SignalVM[];
  /**
   * The source assessments, by module. The singular `sourceAmbiguity` remains
   * accepted as sugar for a one-module case, which is what most callers and
   * every fixture are.
   */
  sourceAmbiguities?: Array<{
    moduleId: string;
    ambiguity: SourceAmbiguity;
    /**
     * The exposures this assessment's own lineage could account for. Per
     * assessment, because a statement that has just said it speaks for no other
     * module's analytes cannot then list another module's parent as its
     * declared source.
     */
    declaredExposures?: BuildProfileInput['declaredExposures'];
  }>;
  sourceAmbiguity?: SourceAmbiguity | null;
  artefactFlags?: ArtefactFlag[];
  creatinineReferenceMmolL?: number;
  locale?: string;
}

export function buildRatioProfile(input: BuildProfileInput): RatioProfileViewModel {
  const {
    features,
    results,
    contextFields,
    selectedContext,
    signals = [],
    artefactFlags = [],
    locale = 'nb-NO',
  } = input;
  const resultById = new Map(results.map((r) => [r.featureId, r]));

  // A pin, only while one module owns the screen.
  //
  // A pin is a statement about the window *that module's* ratios are read in,
  // and it is made without knowledge of any other. Taking the first available
  // one across several modules decides the shared axis by registry order: a
  // case spanning two families draws the second family's ratios in the window
  // the first one asked for, and two modules that both pin would have one
  // silently overrule the other.
  //
  // So a multi-module profile computes its axis from the case's own values,
  // which is the same answer an invalid pin gets and for the same reason — a
  // drawable axis nobody claimed beats a claimed one that is about something
  // else. One axis for every group stays the invariant either way; what
  // changes is only who gets to name it.
  const pin = input.modules.length === 1 ? input.modules[0]!.axisPin : undefined;
  const axisValues: number[] = [];
  for (const feature of features) {
    const result = resultById.get(feature.id);
    if (!result) continue;
    // Only the quantity this row's track actually draws. A cross-matrix row
    // stores both variants and plots one; letting the unplotted one stretch the
    // axis means an extreme creatinine factor can consume the five-decade
    // window and compress every visible marker toward a rim, on behalf of a
    // number that is nowhere on the plot.
    const interval = plottedIntervalOf(feature, result);
    if (!interval) continue;
    if (interval.low !== null) axisValues.push(interval.low);
    if (interval.high !== null) axisValues.push(interval.high);
  }
  for (const feature of features) {
    const band = feature.provisionalBand;
    // Only a band the case will actually be shown against. A withheld band is
    // invisible and still, through this loop, decided how much room the visible
    // markers got: a wide unstated-basis band could compress every real value
    // toward one rim, on a screen that says no comparable band is shown.
    const result = resultById.get(feature.id);
    if (band && result && bandIsComparable(feature, result)) {
      axisValues.push(band.p5, band.p50, band.p95);
    }
  }
  const axis = computeAxis(axisValues, { pin });

  // What the selected context says about each ratio. Read once here rather than
  // per row: the answer is a property of the selection, and a row asking for it
  // would re-scan every field for every feature.
  const modifiersByFeature = new Map<string, PatternModifier[]>();
  for (const field of contextFields) {
    const value = selectedContext[field.id] ?? defaultValue(field);
    const option = field.options.find((o) => o.value === value);
    for (const modifier of option?.modifiers ?? []) {
      const list = modifiersByFeature.get(modifier.featureId);
      if (list) list.push(modifier);
      else modifiersByFeature.set(modifier.featureId, [modifier]);
    }
  }

  const groups: RatioGroupVM[] = [];
  for (const group of RATIO_GROUPS) {
    const inGroup = features.filter((f) => featureGroup(f) === group);
    const rows = inGroup
      .filter(isActive)
      .map((feature) =>
        toRow(
          feature,
          resultById.get(feature.id),
          axis,
          locale,
          artefactFlags,
          modifiersByFeature.get(feature.id) ?? [],
        ),
      )
      .filter((row): row is RatioRowVM => row !== null);
    const withdrawnNoteKeys = inGroup
      .filter((f) => !isActive(f) && f.withdrawnRationaleKey)
      .map((f) => f.withdrawnRationaleKey!);

    // A group with nothing in it is not a heading. The matrices are derived
    // from what the module ships, so a family with no urine ratio simply has
    // no urine group rather than an empty one.
    if (rows.length === 0 && withdrawnNoteKeys.length === 0) continue;
    // The cross-matrix note promises both bases. That is a statement about
    // what is in the group, not about what the regime means in principle, and
    // on a case whose creatinine is unusable the group holds one of the two.
    // Same correction as the method disclosure, one level down.
    const normalizedShown = rows.some((row) => row.normalizedValueText !== undefined);
    const regimeNoteKey =
      group === 'cross_matrix' && !normalizedShown
        ? 'pattern.profile.regime.crossMatrixRawOnly'
        : GROUP_NOTE_KEYS[group];
    groups.push({
      group,
      headingKey: GROUP_HEADING_KEYS[group],
      regimeNoteKey,
      rows,
      withdrawnNoteKeys,
    });
  }

  // Counted for the provisional note, which is about the bands a reader can
  // see: a withheld one is not on screen to be provisional about.
  const bands = features.filter(isActive).filter((feature) => {
    const result = resultById.get(feature.id);
    return feature.provisionalBand !== undefined && result !== undefined && bandIsComparable(feature, result);
  });
  const demoted = new Set(
    input.modules
      .flatMap((module) => module.signals)
      .filter((definition) => isNotEstablished(definition, false))
      .map((definition) => definition.id),
  );
  // What the selected options cite for themselves. A generated co-medication
  // states a catalog fact — that this substance moves this enzyme — and the
  // method footer answers "who says so" for everything else on the screen.
  const selectedCitations = contextFields.flatMap((field) => {
    const value = selectedContext[field.id] ?? defaultValue(field);
    return field.options.find((o) => o.value === value)?.referenceCitations ?? [];
  });

  const contextVMs = contextFields.map((field) => {
    const value = selectedContext[field.id] ?? defaultValue(field);
    const option = field.options.find((o) => o.value === value);
    // An unrecognised stored value — an option withdrawn since the case was
    // saved, say — degrades to `missing`. Falling back to the first option would
    // assert a known context nobody entered, and it would disagree with
    // `contextSummary`, which counts the same value as neither known nor
    // missing: the profile would claim certainty and report no gap at once.
    const options = field.options.map((o) => ({
      value: o.value,
      labelKey: o.labelKey,
      ...(o.label === undefined ? {} : { label: o.label }),
      ...(o.labelSuffixKey === undefined ? {} : { labelSuffixKey: o.labelSuffixKey }),
    }));
    // The same unrecognised value has to be selectable as well as counted, or an
    // editor bound to it silently displays the first known option instead — the
    // degradation above would be computed correctly and shown as its opposite.
    if (!option) {
      options.push({ value: value ?? '', labelKey: 'pattern.profile.context.unknownValue' });
    }
    return {
      id: field.id,
      labelKey: field.labelKey,
      shortKey: field.shortKey,
      value: value ?? '',
      valueLabelKey: option?.labelKey ?? 'pattern.profile.context.unknownValue',
      ...(option?.label === undefined ? {} : { valueLabel: option.label }),
      ...(option?.labelSuffixKey === undefined
        ? {}
        : { valueLabelSuffixKey: option.labelSuffixKey }),
      state: option?.state ?? 'missing',
      options,
    };
  });

  return {
    observations: (input.observations ?? []).map((observation) => ({
      ...observation,
      valueText:
        observation.value === undefined
          ? undefined
          : formatMeasured(observation.value, locale, observation.reportedDecimals),
      editText:
        observation.value === undefined
          ? undefined
          : formatForEditing(observation.value, locale, observation.reportedDecimals),
      limit: observation.limit
        ? {
            ...observation.limit,
            valueText: formatMeasured(
              observation.limit.value,
              locale,
              observation.limit.reportedDecimals,
            ),
          }
        : undefined,
    })),
    specimenMetrics: (input.specimenMetrics ?? []).map((metric) => ({
      specimenId: metric.specimenId,
      specimenLabel: metric.specimenLabel,
      labelKey: metric.labelKey,
      unit: metric.unit,
      valueText: formatMeasured(metric.value, locale),
    })),
    provisional: {
      anyProvisional: bands.length > 0,
      provisionalCount: bands.length,
      totalBands: bands.length,
    },
    sourceAmbiguities: toAmbiguityVMs(input),
    contextFields: contextVMs,
    contextSummary: contextSummary(contextFields, selectedContext),
    ratioGroups: groups,
    axis,
    // A signal that asserts nothing is moved out of the findings list by the
    // §7.6 rule, not by hand in the registry — so a future module inherits it.
    // No band in this release is established, so `hasEstablishedBand` is false
    // for every feature; Phase 3 passes the real answer.
    signals: signals.filter((signal) => !demoted.has(signal.id)),
    notEstablished: [
      ...input.modules.flatMap((module) =>
        module.notEstablished.map((entry: PatternNotEstablishedDefinition) => ({
          id: entry.id,
          titleKey: entry.titleKey,
          rationaleKey: entry.rationaleKey,
        })),
      ),
      ...signals
        .filter((signal) => demoted.has(signal.id))
        .map((signal) => ({
          id: signal.id,
          titleKey: signal.titleKey,
          rationaleKey:
            signal.strength.kind === 'not_calculable'
              ? signal.strength.reasonKey
              : 'pattern.profile.strength.noValidatedMapping',
        })),
    ],
    method: {
      citations: collectCitations(input, selectedCitations, {
        // A signal demoted to "Ikke etablert" still renders, so it counts as
        // shown; one `appliesToCase` dropped does not appear in `signals` at
        // all.
        featureIds: new Set(groups.flatMap((group) => group.rows.map((row) => row.featureId))),
        signalIds: new Set(signals.map((signal) => signal.id)),
        artefactRuleIds: new Set(artefactFlags.map((flag) => flag.ruleId)),
        // Only the rows that actually state a direction. An enzyme effect
        // nobody selected is not on screen, and citing it would attribute a
        // claim to the profile that the profile did not make — the same error
        // the signal scoping above exists to prevent, one mechanism along.
        directionFeatureIds: new Set(
          groups
            .flatMap((group) => group.rows)
            .filter((row) => row.expectedDirection !== undefined)
            .map((row) => row.featureId),
        ),
      }),
      normalizationBasisKey: normalizationDisclosure(results) ?? undefined,
      // Formatted here, like every other number in the model: interpolating the
      // raw value would print a decimal point into Norwegian prose whose ratios
      // and axis both use a comma.
      //
      // Suppressed along with the sentence it belongs to: where no cross-matrix
      // ratio computed at all, the reference had no part in anything on screen
      // and a line about it would be answering a question nobody asked.
      creatinineReferenceText:
        input.creatinineReferenceMmolL === undefined || normalizationDisclosure(results) === null
          ? undefined
          : formatRatio(input.creatinineReferenceMmolL, locale),
    },
  };
}

/**
 * The candidates are named by the module's own analyte labels where it knows
 * them, and by a generic key where it does not — a substance outside every
 * loaded module still has to be nameable, since the whole point of the upstream
 * walk is that it reaches substances the module never listed.
 */
function toAmbiguityVMs(input: BuildProfileInput): SourceAmbiguityVM[] {
  // The singular input is a one-module case's assessment, which is what every
  // fixture and most callers are. Normalised here so the model has one shape.
  const assessments =
    input.sourceAmbiguities ??
    (input.sourceAmbiguity
      ? [{ moduleId: input.modules[0]?.id ?? '', ambiguity: input.sourceAmbiguity }]
      : []);

  const labelByCid = new Map<number, string>();
  for (const module of input.modules) {
    for (const analyte of module.analytes) {
      labelByCid.set(analyte.analyte.pubchemCid, analyte.labelKey);
    }
  }
  // Empty rather than a fallback key: assigning the generic translation here
  // would make it indistinguishable from a real module label downstream, and the
  // view could no longer tell that it should fall back to the substance's own
  // identity. Naming is the view's job; identity is this model's.
  const label = (cid: number) => labelByCid.get(cid) ?? '';

  return assessments.map(({ moduleId, ambiguity, declaredExposures }) => ({
    statusKind: ambiguity.status.kind,
    candidates: ambiguity.candidates.map((candidate) => ({
      labelKey: label(candidate.drug.pubchemCid),
      pubchemCid: candidate.drug.pubchemCid,
      slug: candidate.drug.slug,
      direction: candidate.direction,
      role: candidate.role,
    })),
    declared: (declaredExposures ?? input.declaredExposures ?? []).map((exposure) => ({
      labelKey: label(exposure.pubchemCid),
      pubchemCid: exposure.pubchemCid,
      slug: exposure.slug,
      certainty: exposure.certainty,
    })),
    // Which parent this assessment is about, where the case has more than one
    // to choose between. A single-module case needs no such line: there is
    // nothing to distinguish it from, and naming the parent would only add
    // noise to the one statement on screen.
    framedOn:
      assessments.length > 1
        ? {
            labelKey: label(ambiguity.assumedParent.pubchemCid),
            pubchemCid: ambiguity.assumedParent.pubchemCid,
            slug: ambiguity.assumedParent.slug,
          }
        : null,
    moduleId,
  }));
}

/**
 * The sources behind what is on this screen — and only what is on it.
 *
 * Two directions to get wrong, and the registry-wide version got both. Citing
 * a signal the case never rendered attributes to the profile an assessment it
 * did not make: a benzodiazepine case with no urine drops the dilution signal
 * and was still citing its creatinine reference. And a `threshold` rule's
 * `thresholdProvenance` is the citation that *licenses* a displayed strength —
 * the one a reader most needs — yet it appeared only if a curator happened to
 * repeat it in `referenceCitations`.
 */
function collectCitations(
  input: BuildProfileInput,
  /** Sources the selected context options carry for their own claims. */
  selected: Array<{ type: 'pmid' | 'doi' | 'url'; identifier: string }>,
  rendered: {
    featureIds: Set<string>;
    signalIds: Set<string>;
    artefactRuleIds: Set<string>;
    /** Rows whose selected context states an expected direction (§7.5). */
    directionFeatureIds?: Set<string>;
  },
) {
  const seen = new Set<string>();
  const out: Array<{ type: 'pmid' | 'doi' | 'url'; identifier: string }> = [];
  const add = (citations?: Array<{ type: 'pmid' | 'doi' | 'url'; identifier: string }>) => {
    for (const citation of citations ?? []) {
      const key = `${citation.type}:${citation.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(citation);
    }
  };

  add(selected);
  for (const feature of input.features) {
    if (rendered.featureIds.has(feature.id)) add(feature.referenceCitations);
  }
  for (const module of input.modules) {
    for (const signal of module.signals) {
      if (!rendered.signalIds.has(signal.id)) continue;
      add(signal.referenceCitations);
      if (signal.strength.type === 'threshold') add(signal.strength.thresholdProvenance);
    }
    for (const rule of module.artefactRules) {
      if (rendered.artefactRuleIds.has(rule.id)) add(rule.referenceCitations);
    }
    // An expected direction on a ratio row is an evidence-backed claim like any
    // other on this screen — "an inducer raises this ratio" — so the works
    // behind it belong in the footer. Scoped to the rows that state one, since
    // an effect nobody selected is not on screen.
    for (const effect of module.enzymeEffects) {
      if (rendered.directionFeatureIds?.has(effect.featureId)) add(effect.referenceCitations);
    }
    // "Ikke etablert" entries are on screen and carry the evidence for their
    // bounded-negative wording, so their sources belong in the footer too.
    for (const entry of module.notEstablished) add(entry.referenceCitations);
  }
  return out;
}

/**
 * What the method section may say about normalisation, or `null` for nothing.
 *
 * Three states, and the middle one is why this is a function. "Shown both raw
 * and normalised" is a claim about the screen. "The creatinine could not be
 * used" is a claim about the specimen — and it must not be made when the real
 * failure was an operand that never resolved, because it would send a reader to
 * check a value that is recorded and fine while saying nothing about what
 * actually went wrong. `normalization_unavailable` is raised only once a urine
 * specimen has resolved, so it is the one signal that distinguishes the two.
 */
function normalizationDisclosure(results: PatternFeatureResult[]): string | null {
  if (results.some((r) => r.normalizedValue !== undefined)) {
    return 'pattern.profile.method.creatinineBasis';
  }
  const creatinineFailed = results.some((r) =>
    r.calculationWarnings.some((w) => w.code === 'normalization_unavailable'),
  );
  return creatinineFailed ? 'pattern.profile.method.creatinineUnavailable' : null;
}

/**
 * Which quantity a row's track draws.
 *
 * A band derived from standardised values describes the normalised ratio, so
 * plotting the raw one against it misstates the position by exactly the
 * normalisation factor — the value cell and the picture would disagree about
 * the same row, and only the picture is read at a glance.
 */
function plotsNormalized(
  feature: PatternFeatureDefinition,
  result: PatternFeatureResult,
): boolean {
  return (
    feature.provisionalBand?.basis === 'creatinine_normalized' &&
    result.normalizedValue !== undefined
  );
}

/** The interval behind that choice, for anything sizing itself to the plot. */
function plottedIntervalOf(
  feature: PatternFeatureDefinition,
  result: PatternFeatureResult,
): PatternNumericInterval | undefined {
  return plotsNormalized(feature, result) ? result.normalizedValue : result.rawValue;
}

/**
 * Whether the case's value can be placed on the band's own basis.
 *
 * `raw` always can. `creatinine_normalized` needs the normalised value, which a
 * case without usable creatinine does not have. `unstated` can only be trusted
 * where the two quantities coincide — that is, where no normalisation was
 * applied; once they differ, a band of unknown basis matches neither, and
 * choosing one would be inventing the provenance the band is missing.
 */
function bandIsComparable(
  feature: PatternFeatureDefinition,
  result: PatternFeatureResult,
): boolean {
  const band = feature.provisionalBand;
  if (!band) return false;
  switch (band.basis) {
    case 'raw':
      return true;
    case 'creatinine_normalized':
      return result.normalizedValue !== undefined;
    case 'unstated':
      // `basis: 'none'`, not `!applied`. The two are different facts and only
      // one of them says the quantities coincide: `applied` is false both when
      // normalisation was unnecessary — the factor cancels within a specimen —
      // and when it was necessary but the creatinine was unusable. In the
      // second case the raw and normalised values still differ; we simply do
      // not know by how much, which is the worst position from which to plot
      // one of them against a band that might describe the other.
      return result.normalization.basis === 'none';
  }
}

function toRow(
  feature: PatternFeatureDefinition,
  result: PatternFeatureResult | undefined,
  axis: AxisVM,
  locale: string,
  artefactFlags: ArtefactFlag[],
  modifiers: PatternModifier[] = [],
): RatioRowVM | null {
  if (!result) return null;

  const raw = result.rawValue ?? { low: null, high: null };
  const plotNormalized = plotsNormalized(feature, result);
  const interval = plotNormalized ? result.normalizedValue! : raw;
  const isZero = result.status === 'point' && interval.low === 0;

  let marker: MarkerVM | null = null;
  if (isZero) {
    marker = {
      positionPct: 0,
      bound: null,
      isInterval: false,
      outOfAxis: null,
      endOutOfAxis: null,
      isZero: true,
    };
  } else if (result.status !== 'indeterminate' && result.status !== 'blocked') {
    // Which endpoint anchors the marker depends on what the result is: an upper
    // bound is anchored at its high end and opens downward, a lower bound the
    // reverse, and an interval draws between both.
    const anchor = result.status === 'upper_bound' ? interval.high : interval.low;
    if (anchor !== null && anchor > 0) {
      const { pct, outOfAxis } = positionOf(anchor, axis);
      // The far endpoint gets clamped on its own terms. Keeping only its
      // percentage loses the one fact the percentage cannot carry: an interval
      // whose top runs off the axis renders at 100 exactly like one that ends
      // there, so the caret and the accessible name would both stay silent
      // about the half of the result that left the view.
      const far =
        result.status === 'interval' && interval.high !== null && interval.high > 0
          ? positionOf(interval.high, axis)
          : undefined;
      marker = {
        positionPct: pct,
        endPct: far?.pct,
        endOutOfAxis: far?.outOfAxis ?? null,
        bound:
          result.status === 'lower_bound'
            ? 'lower'
            : result.status === 'upper_bound'
              ? 'upper'
              : null,
        isInterval: result.status === 'interval',
        outOfAxis,
        isZero: false,
      };
    }
  }

  const comparable = bandIsComparable(feature, result);
  const band =
    feature.provisionalBand && comparable
      ? {
          p5Pct: positionOf(feature.provisionalBand.p5, axis).pct,
          p50Pct: positionOf(feature.provisionalBand.p50, axis).pct,
          p95Pct: positionOf(feature.provisionalBand.p95, axis).pct,
          p5Text: formatRatio(feature.provisionalBand.p5, locale),
          p50Text: formatRatio(feature.provisionalBand.p50, locale),
          p95Text: formatRatio(feature.provisionalBand.p95, locale),
          provisional: true,
        }
      : null;

  return {
    featureId: feature.id,
    labelKey: feature.labelKey,
    basisKey: feature.basisKey,
    kind: feature.kind,
    kindNoteKey: KIND_NOTE_KEYS[feature.kind],
    status: result.status,
    valueText: isZero ? '0' : formatInterval(raw, result.status, locale),
    normalizedValueText: result.normalizedValue
      ? formatInterval(result.normalizedValue, result.status, locale)
      : undefined,
    plottedBasis: plotNormalized ? 'normalized' : 'raw',
    // A band that exists but cannot be aligned with either value is stated as
    // withheld. Rendering nothing would make it indistinguishable from a feature
    // that never had a reference distribution at all.
    // Which of the two reasons, because they send a reader to different places.
    // An unstated basis is a curation gap in the registry; an unusable
    // creatinine is a gap in this case's data, and saying "the band's basis is
    // not stated" about a band whose basis *is* stated both misdescribes the
    // registry and hides the case-data failure.
    bandWithheldNoteKey:
      feature.provisionalBand && !comparable
        ? feature.provisionalBand.basis === 'creatinine_normalized'
          ? 'pattern.profile.band.normalizationUnavailable'
          : 'pattern.profile.band.basisUnstated'
        : undefined,
    marker,
    band,
    warnings: result.calculationWarnings,
    artefactNoteKeys: artefactFlags
      .filter((flag) => flag.featureId === feature.id)
      .map((flag) => flag.noteKey),
    ...(modifiers.length === 0
      ? {}
      : {
          // One selected option bearing on this ratio states its direction; two
          // make it `unclear` whatever they say, because a value with two
          // declared explanations gets attributed to whichever the reader
          // thought of first — and choosing one of them here would make that
          // pick on their behalf. An option that declares `unclear` on its own
          // is already saying so.
          expectedDirection:
            modifiers.length === 1 ? modifiers[0]!.direction : ('unclear' as const),
        }),
  };
}
