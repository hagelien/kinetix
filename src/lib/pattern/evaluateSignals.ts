/**
 * Signals, degradation and caveats (§7.6).
 *
 * A signal states a proposition pair and how much its basis quantity supports
 * one side. Nearly all of the work here is deciding when it may *not* state
 * that: a dependency the case never recorded, a source that could be something
 * other than the assumed parent, a basis that did not compute, or a threshold
 * rule whose published support does not resolve. Each of those produces a
 * visible line rather than a silently weaker claim.
 */

import type { PatternFeatureResult } from '../../types/patternCase.js';
import type { PatternContextFieldDefinition, PatternModifier } from './contextFields.js';
import { defaultValue } from './contextFields.js';
import {
  thresholdProvenanceResolves,
  type PatternSignalDefinition,
  type PatternSpecimenMetric,
} from './signals.js';
import type { SourceAmbiguity } from './sourceAmbiguity.js';
import { DEGRADATION_KEYS, NOT_CALCULABLE_KEYS, strengthKey } from './wording.js';

export interface SignalDegradation {
  kind: 'field' | 'source';
  /**
   * Whether the field was left unanswered or answered by assumption. Both
   * degrade — §7.6 puts them on the same line — and they are different things
   * to tell a reader, so the wording keeps them apart.
   */
  state?: 'missing' | 'assumed';
  /** The short form named in the line: "CYP2C19-genotype". */
  shortKey?: string;
}

export type SignalStrengthVM =
  | { kind: 'stated'; strengthKey: string; side: 'Hp' | 'Hd'; caveatKey?: string }
  | { kind: 'not_calculable'; reasonKey: string };

export interface SignalVM {
  id: string;
  titleKey: string;
  grade: 'exploratory' | 'suggestive' | 'validated';
  propositionHpKey: string;
  propositionHdKey: string;
  basisKey: string;
  strength: SignalStrengthVM;
  degradations: SignalDegradation[];
  /**
   * Fires when two or more modifiers bear on one basis feature: with several
   * explanations in play, attributing the value to any one of them is the
   * over-attribution Layer A objected to.
   */
  attributionCaveat: boolean;
}

/**
 * A signal that makes no claim: exploratory, with no computable strength and no
 * established band behind it.
 *
 * §7.6 states this as a *rule* rather than a property of one entry, so it is
 * derived here rather than moved in the registry. `single_vs_repeated` is a
 * signal definition — it has propositions and a basis — and demoting it by hand
 * would leave the next module's author to remember the rule. A row that reads
 * like a finding but asserts nothing is the thing being prevented.
 */
export function isNotEstablished(
  signal: PatternSignalDefinition,
  hasEstablishedBand: boolean,
): boolean {
  return (
    signal.grade === 'exploratory' &&
    signal.strength.type === 'not_calculable' &&
    !hasEstablishedBand
  );
}

export interface EvaluateSignalsInput {
  signals: PatternSignalDefinition[];
  results: PatternFeatureResult[];
  contextFields: PatternContextFieldDefinition[];
  selectedContext: Record<string, string>;
  /**
   * The source assessment for the signal's **own** module, by module id.
   *
   * Per module, because a case can span two families and each is framed on its
   * own parent: a benzodiazepine signal degrades because the benzodiazepine
   * source is unresolved, and a cocaine assessment has nothing to say about it.
   * One shared assessment made the answer depend on which module the registry
   * happened to list first.
   */
  sourceAmbiguityByModule: ReadonlyMap<string, SourceAmbiguity>;
  /** Urine creatinine, where the case has one, for specimen-metric bases. */
  urineCreatinineMmolL?: number;
  /**
   * Which specimen metrics the case *could* supply — that is, for which a
   * specimen of the required kind exists at all.
   *
   * Required rather than optional, and deliberately: an optional filter is one
   * a caller forgets, and the production pipeline forgetting a guard is exactly
   * how the provenance gate came to protect only its own test. Absence of a
   * metric's specimen is the specimen-metric analogue of a feature no module
   * defines, and it is a different fact from a specimen whose metric did not
   * resolve — see `appliesToCase`.
   */
  presentSpecimenMetrics: ReadonlySet<PatternSpecimenMetric>;
  /**
   * Whether a threshold rule's published support resolves.
   *
   * Optional, but its *absence* is not permission to skip the gate: the default
   * below still has to succeed. Phase 1 passes a resolver that checks the
   * citation store — that a handle exists, and that the work it names is of a
   * published kind (§13.3) — which is strictly more than Phase 0 can check
   * without one.
   */
  provenanceResolves?: (signal: PatternSignalDefinition) => boolean;
}

export function evaluateSignals(input: EvaluateSignalsInput): SignalVM[] {
  const { signals, results, contextFields, selectedContext, sourceAmbiguityByModule } = input;
  const resultById = new Map(results.map((r) => [r.featureId, r]));
  const fieldById = new Map(contextFields.map((f) => [f.id, f]));

  return signals
    .filter((signal) => appliesToCase(signal, resultById, input.presentSpecimenMetrics))
    .map((signal) => {
    const degradations: SignalDegradation[] = [];

    for (const fieldId of signal.dependsOn) {
      const field = fieldById.get(fieldId);
      // A dependency on a field the case does not even offer is itself a gap:
      // the signal was written expecting an answer that this case cannot give.
      if (!field) {
        degradations.push({ kind: 'field', state: 'missing' });
        continue;
      }
      const value = selectedContext[fieldId] ?? defaultValue(field);
      const option = field.options.find((o) => o.value === value);
      // `assumed` degrades too (§7.6). An assumption is the registry's answer,
      // not the case's, and a verbal strength computed from one would rest on a
      // fact nobody established — the same objection as an unstated field, one
      // step less obvious because the screen shows a value.
      if (!option || option.state === 'missing') {
        degradations.push({ kind: 'field', state: 'missing', shortKey: field.shortKey });
      } else if (option.state === 'assumed') {
        degradations.push({ kind: 'field', state: 'assumed', shortKey: field.shortKey });
      }
    }

    // Every state except `not_applicable` degrades. The distinction between them
    // changes no gating — only what the view says — which is exactly why it has
    // to be right: unresolved and mixed_source are different statements about
    // the evidence.
    // A module with no assessment at all degrades too: the absence is not a
    // clearance, and `not_applicable` is the only status that lifts this.
    if (
      signal.dependsOnSourceResolution &&
      sourceAmbiguityByModule.get(signal.moduleId)?.status.kind !== 'not_applicable'
    ) {
      degradations.push({ kind: 'source' });
    }

    return {
      id: signal.id,
      titleKey: signal.titleKey,
      grade: signal.grade,
      propositionHpKey: signal.propositionHpKey,
      propositionHdKey: signal.propositionHdKey,
      basisKey: signal.basisKey,
      strength: computeStrength(signal, input, resultById, degradations),
      degradations,
      attributionCaveat: countModifiers(signal, contextFields, selectedContext) >= 2,
    };
  });
}

/**
 * Whether a signal has anything to say about this case at all.
 *
 * The distinction is between a basis that is *absent* and one that is *present
 * but indeterminate*, and only the first is silence-worthy. A feature no module
 * in scope defines was never applicable here, so proposition rows about it are
 * noise. A feature that exists and failed to compute is different: the analysis
 * was attempted and the reason is worth stating, which is what the
 * `basisIndeterminate` wording is for. Dropping that row would hide a gap rather
 * than report it.
 */
function appliesToCase(
  signal: PatternSignalDefinition,
  resultById: Map<string, PatternFeatureResult>,
  presentSpecimenMetrics: ReadonlySet<PatternSpecimenMetric>,
): boolean {
  // The same distinction, on the other kind of basis: a case with no urine
  // specimen never offered the metric, so a dilution row there is not an
  // analysis that failed — it is a proposition pair about a specimen nobody
  // collected. A urine specimen whose creatinine is missing or ambiguous is the
  // other case, and it keeps its row with `basisIndeterminate`.
  if (signal.basis.type === 'specimen_metric') {
    return presentSpecimenMetrics.has(signal.basis.metric);
  }
  return resultById.has(signal.basis.featureId);
}

function computeStrength(
  signal: PatternSignalDefinition,
  input: EvaluateSignalsInput,
  resultById: Map<string, PatternFeatureResult>,
  degradations: SignalDegradation[],
): SignalStrengthVM {
  if (signal.strength.type === 'not_calculable') {
    return { kind: 'not_calculable', reasonKey: signal.strength.reasonKey };
  }

  // A rule whose published support does not resolve degrades rather than
  // computing. Ungated, a threshold rule would let any curator emit ENFSI
  // wording from a number they picked — the failure the band-provenance gate
  // exists to prevent, arriving by the other door.
  //
  // The gate is unconditional. An earlier version ran it only when a caller
  // supplied a resolver, which meant the production pipeline — which supplied
  // none — computed every threshold rule ungated, and the guard protected only
  // the test that passed one. A missing resolver now falls back to the registry
  // check rather than to permission.
  const resolves = input.provenanceResolves ?? thresholdProvenanceResolves;
  if (!resolves(signal)) {
    return { kind: 'not_calculable', reasonKey: NOT_CALCULABLE_KEYS.provenanceUnresolved };
  }

  // A degraded dependency is not a weaker number, it is no number. Saying
  // "moderate support" from a basis whose context is unstated would be a claim
  // the case does not license.
  // An unanswered field is reported ahead of an assumed one where a signal has
  // both: it is the larger gap, and the reason line names one thing.
  if (degradations.some((d) => d.kind === 'field' && d.state === 'missing')) {
    return { kind: 'not_calculable', reasonKey: NOT_CALCULABLE_KEYS.missingContext };
  }
  if (degradations.some((d) => d.kind === 'field' && d.state === 'assumed')) {
    return { kind: 'not_calculable', reasonKey: NOT_CALCULABLE_KEYS.assumedContext };
  }
  if (degradations.some((d) => d.kind === 'source')) {
    return { kind: 'not_calculable', reasonKey: NOT_CALCULABLE_KEYS.unresolvedSource };
  }

  const quantity = quantityFor(signal.strength.quantity, input, resultById);
  if (quantity === null) {
    return { kind: 'not_calculable', reasonKey: NOT_CALCULABLE_KEYS.basisIndeterminate };
  }

  // Band order is significant: the first match wins, so a registry listing
  // `lt: 2` after `between: [4, 20]` would read differently. The registry test
  // pins that order.
  for (const band of signal.strength.bands) {
    if (matchesBand(quantity, band)) {
      return {
        kind: 'stated',
        strengthKey: strengthKey(band.strength),
        side: band.side,
        caveatKey: band.caveatKey,
      };
    }
  }

  return {
    kind: 'stated',
    strengthKey: strengthKey(signal.strength.fallback.strength),
    side: signal.strength.fallback.side,
  };
}

function matchesBand(
  value: number,
  band: { lt?: number; gt?: number; between?: [number, number] },
): boolean {
  if (band.lt !== undefined) return value < band.lt;
  if (band.gt !== undefined) return value > band.gt;
  if (band.between) return value >= band.between[0] && value <= band.between[1];
  return false;
}

function quantityFor(
  basis: PatternSignalDefinition['basis'],
  input: EvaluateSignalsInput,
  resultById: Map<string, PatternFeatureResult>,
): number | null {
  if (basis.type === 'specimen_metric') {
    return input.urineCreatinineMmolL ?? null;
  }
  const result = resultById.get(basis.featureId);
  if (!result || result.status !== 'point') return null;
  return result.rawValue?.low ?? null;
}

/**
 * How many selected options declare a modifier on this signal's basis feature.
 *
 * Counted rather than applied: a modifier never adjusts a value. Two of them
 * bearing on one quantity is the case Layer A objected to — the value gets
 * attributed to whichever explanation the reader thought of first.
 */
function countModifiers(
  signal: PatternSignalDefinition,
  contextFields: PatternContextFieldDefinition[],
  selectedContext: Record<string, string>,
): number {
  if (signal.basis.type !== 'feature') return 0;
  const featureId = signal.basis.featureId;

  let count = 0;
  for (const field of contextFields) {
    const value = selectedContext[field.id] ?? defaultValue(field);
    const option = field.options.find((o) => o.value === value);
    const modifiers: PatternModifier[] = option?.modifiers ?? [];
    count += modifiers.filter((m) => m.featureId === featureId).length;
  }
  return count;
}

export { DEGRADATION_KEYS };
