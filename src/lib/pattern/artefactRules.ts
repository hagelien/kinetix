/**
 * Assay artefact rules (§7.4, Layer A A4).
 *
 * β-glucuronidase hydrolysis can reductively convert oxazepam to nordazepam,
 * corrupting several of the ratios. Modelled generically as a declared
 * conversion keyed to the context option that enables it and scoped to the
 * material the protocol actually touched — the shape recurs as in-source
 * conversion, artefactual deconjugation and matrix-driven degradation, so it is
 * worth the twenty lines it costs.
 */

import type {
  PatternCitationRef,
  PatternDrugRef,
  PatternMatrix,
  PatternMeasurandMode,
  ResolvedObservation,
} from '../../types/patternCase.js';
import type { PatternContextFieldDefinition } from './contextFields.js';
import { defaultValue } from './contextFields.js';
import { isActive, type PatternFeatureDefinition } from './featureRegistry.js';

export interface PatternArtefactRule {
  id: string;
  /** Fires when this context field holds one of these option values. */
  when: { fieldId: string; valueIn: string[] };
  converts: { from: PatternDrugRef; to: PatternDrugRef };
  /**
   * Which material the protocol was applied to. A urine hydrolysis cannot alter
   * a blood operand, so an unscoped rule would warn on rows it does not affect
   * — which erodes the warning everywhere it *is* real.
   */
  appliesTo:
    | { scope: 'matrix'; matrices: PatternMatrix[] }
    | { scope: 'measurand'; modes: PatternMeasurandMode[] };
  noteKey: string;
  referenceCitations: PatternCitationRef[];
}

export interface ArtefactFlag {
  featureId: string;
  ruleId: string;
  noteKey: string;
}

/**
 * Flag every feature with an in-scope operand resolving to **either side of the
 * conversion** — the product, whose value is inflated, and the consumed species,
 * whose value is depleted.
 *
 * Flagging only the product would miss a ratio whose denominator was eaten: for
 * diazepam that is TEM ∶ OXA, where the consumed species sits in the denominator
 * and the product appears nowhere in the feature. Both sides are computed from
 * the resolved operands rather than listed, so a curator cannot miss one and a
 * new feature is covered the day it is added.
 *
 * The flag is a caution on the row, not a suppression: the value is still shown,
 * with its interpretation qualified.
 */
export function evaluateArtefactRules(input: {
  rules: PatternArtefactRule[];
  features: PatternFeatureDefinition[];
  resolved: ResolvedObservation[];
  selectedContext: Record<string, string>;
  /** Needed to resolve a field's declared default — see below. */
  contextFields?: PatternContextFieldDefinition[];
}): ArtefactFlag[] {
  const { rules, features, resolved, selectedContext, contextFields = [] } = input;
  const fieldById = new Map(contextFields.map((f) => [f.id, f]));
  const flags: ArtefactFlag[] = [];

  for (const rule of rules) {
    // An unanswered field is not an absent one: its declared default applies,
    // and for hydrolysis that default is "not stated" — a value this rule
    // deliberately includes, because an unrecorded protocol does not make the
    // conversion less possible (§3.3). Reading the raw record and skipping on
    // `undefined` would suppress the caution on precisely the cases it exists
    // for, which are the ones where nobody wrote the protocol down.
    const field = fieldById.get(rule.when.fieldId);
    const stored = selectedContext[rule.when.fieldId];
    // An unrecognised stored value — an option withdrawn since the case was
    // saved — is not an answer either, and it must not read as one. It resolves
    // to the field's default the same way an absent value does, which for
    // hydrolysis means the caution fires: the protocol is precisely what is
    // unknown in that case.
    const recognised =
      stored !== undefined && (field?.options.some((o) => o.value === stored) ?? true);
    const selected = recognised ? stored : field ? defaultValue(field) : undefined;
    if (selected === undefined || !rule.when.valueIn.includes(selected)) continue;

    // Both ends of the conversion, because a depleted denominator corrupts a
    // ratio exactly as thoroughly as an inflated numerator.
    const affectedCids = new Set([
      rule.converts.from.pubchemCid,
      rule.converts.to.pubchemCid,
    ]);

    // A withdrawn feature renders as a group footnote, never as a row, so it has
    // nowhere to carry a caution. Flagging one would inflate the count the view
    // reports without changing anything a reader can see.
    for (const feature of features.filter(isActive)) {
      // Scope is per *operand*, not per analyte. Nordazepam measured in urine
      // does not make a blood nordazepam operand suspect, and testing the
      // analyte alone would flag NDD ∶ DZP — both operands blood, which a urine
      // hydrolysis cannot reach. That asymmetry is the acceptance criterion.
      const terms = [...feature.numerator.terms, ...feature.denominator.terms];
      const touched = terms.some((term) => {
        if (!affectedCids.has(term.analyte.pubchemCid)) return false;
        return resolved.some(
          (observation) =>
            observation.analyte.pubchemCid === term.analyte.pubchemCid &&
            matrixOf(observation) === term.matrix &&
            // The same restriction `calculateFeatures` applies when it resolves
            // the operand. A case can hold both a free and a hydrolysed result
            // for one analyte in one matrix; a feature term that names the free
            // measurand did not use the hydrolysed one, and warning it about a
            // conversion in an observation it never read attaches a caution to
            // a clean row — which spends the warning where it is not true and
            // erodes it where it is.
            (term.measurandMode === undefined ||
              observation.measurandMode === term.measurandMode) &&
            inScope(rule, observation),
        );
      });

      if (touched) {
        flags.push({ featureId: feature.id, ruleId: rule.id, noteKey: rule.noteKey });
      }
    }
  }

  return flags;
}

/** The operand vocabulary a feature term uses, from a resolved matrix. */
function matrixOf(observation: ResolvedObservation): 'blood' | 'urine' | 'other' {
  if (observation.matrix === 'urine') return 'urine';
  if (
    observation.matrix === 'whole_blood' ||
    observation.matrix === 'femoral_blood' ||
    observation.matrix === 'cardiac_blood' ||
    observation.matrix === 'serum' ||
    observation.matrix === 'plasma'
  ) {
    return 'blood';
  }
  return 'other';
}

function inScope(rule: PatternArtefactRule, observation: ResolvedObservation): boolean {
  if (rule.appliesTo.scope === 'matrix') {
    return rule.appliesTo.matrices.includes(observation.matrix);
  }
  return rule.appliesTo.modes.includes(observation.measurandMode);
}
