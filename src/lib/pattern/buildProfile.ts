/**
 * The whole pipeline, in one call.
 *
 * `PatternCaseData` → resolved observations → features → signals and artefact
 * flags → `RatioProfileViewModel`. The page and the tests both go through here,
 * so a test cannot pass against a pipeline the screen does not actually run.
 *
 * Phase 1 replaces the graph argument with the module-scoped endpoint and the
 * case argument with a stored row. Neither changes this function's shape, which
 * is the point of writing it now.
 */

import type { PatternCaseData, PatternObservation } from '../../types/patternCase.js';
import { evaluateArtefactRules } from './artefactRules.js';
import { calculateFeatures } from './calculateFeatures.js';
import {
  HYDROLYSIS_CONTEXT_FIELD,
  UNIVERSAL_CONTEXT_FIELDS,
  applicableContextFields,
} from './contextFields.js';
import {
  EMPTY_LINEAGE_ENZYMES,
  lineageEnzymeSlugs,
  withGeneratedOptions,
  type LineageEnzymes,
} from './lineageEnzymes.js';
import { evaluateSignals } from './evaluateSignals.js';
import { buildRatioProfile, type RatioProfileViewModel } from './profileModel.js';
import { resolveObservations } from './resolveObservations.js';
import type { PatternSignalDefinition, PatternSpecimenMetric } from './signals.js';
import { evaluateSourceAmbiguity, type MetabolismGraph } from './sourceAmbiguity.js';
import {
  assertModuleWellFormedOnce,
  assertModulesCompose,
  molecularWeightLookup,
  unionContextFields,
  unionFeatures,
  type PatternSubstanceModule,
} from './substanceModules.js';

/** An edited measurement, with the precision it was entered to. */
export interface ObservationEdit {
  value: number;
  /** Absent where the reader's text states nothing beyond what the number holds. */
  reportedDecimals?: number;
}

export interface BuildFromCaseInput {
  caseData: PatternCaseData;
  modules: PatternSubstanceModule[];
  graph: MetabolismGraph;
  /**
   * The enzymes the case's lineage routes through, and what the catalog says
   * moves them (§7.2). Optional, and its absence is the honest answer for a
   * case whose modules declare no enzyme-derived field: an empty lineage offers
   * no such row, which is exactly what an uncurated elimination route should
   * also produce.
   */
  enzymes?: LineageEnzymes;
  /** Overrides the case's stored context, for live editing without a save. */
  contextOverrides?: Record<string, string>;
  /**
   * Observation values being edited, by observation id, in the observation's own
   * unit. The case stays authoritative — §7's raw observations are the record —
   * so an edit is an overlay rather than a mutation until something saves it.
   *
   * The precision travels with the value because it cannot be recovered from
   * it: `1,50` and `1,5` parse to the same number and are different statements
   * about the assay.
   */
  observationOverrides?: Record<string, ObservationEdit>;
  /**
   * Formats every value in the model. It belongs here rather than in the view
   * because the same strings go to report output in Phase 4, where there is no
   * React context to read a language from.
   */
  locale?: string;
  /**
   * Resolves a threshold rule's published support against the citation store.
   *
   * Phase 1 supplies it. Omitting it does not open the gate — `evaluateSignals`
   * falls back to the registry-level handle check, which still has to pass
   * before any ENFSI wording is stated.
   */
  provenanceResolves?: (signal: PatternSignalDefinition) => boolean;
}

/**
 * The creatinine a dilution signal may rest on, or `undefined` where the case
 * offers more than one.
 *
 * Taking the first would let specimen order decide whether the stated support
 * lands on Hp or Hd — the same failure as the operand matching, on the metric
 * rather than the analyte. Phase 1 binds the signal to the specimen its basis
 * observation came from; until a case can express that, several candidates mean
 * the signal is not calculable.
 */
function unambiguousUrineCreatinine(caseData: PatternCaseData): number | undefined {
  // Count the specimens, then read the measurement — not the other way round.
  // Filtering to the ones that carry a creatinine first would let a case with
  // two urine collections, only one of them measured, look unambiguous: the
  // signal is not bound to a specimen yet, so the unmeasured collection is
  // still a competing candidate for what "the urine sample" refers to, and its
  // silence is not consent.
  const urines = caseData.specimens.filter((s) => s.matrix === 'urine');
  if (urines.length !== 1) return undefined;
  const measured = urines[0]!.urine?.creatinineMmolL;
  return typeof measured === 'number' && measured > 0 ? measured : undefined;
}

/**
 * Whether an observation establishes that the analyte was present.
 *
 * Read from the raw observation rather than the resolved one: a quantified
 * result whose unit conversion failed for want of a molecular weight is still a
 * laboratory finding of presence, and letting a curation gap retract it would
 * make the source statement depend on the catalog rather than on the case.
 *
 * A quantified zero is a measurement of absence, not of presence, so it does not
 * qualify — §8.1 keeps it a real result, and this is one of the few places where
 * what it is a real result *of* matters.
 */
function establishesPresence(observation: PatternObservation): boolean {
  switch (observation.qualifier) {
    case 'quantified':
      return observation.value !== undefined && observation.value > 0;
    case 'above_limit':
    case 'detected_not_quantified':
      return true;
    default:
      return false;
  }
}

export function buildProfileFromCase(input: BuildFromCaseInput): RatioProfileViewModel {
  const {
    caseData,
    modules,
    graph,
    enzymes = EMPTY_LINEAGE_ENZYMES,
    contextOverrides,
    observationOverrides,
    locale,
  } = input;

  // A Map, because observation ids come out of a stored case and the overrides
  // are an ordinary object: `observationOverrides['toString']` answers with an
  // inherited function instead of the absence that is the truth, and this
  // branch would then "apply" an edit nobody made — replacing a quantified
  // value with `undefined`, so the row and every ratio it feeds reopen
  // indeterminate. `Object.entries` copies own keys only.
  const edits = new Map(Object.entries(observationOverrides ?? {}));
  const edited = observationOverrides
    ? {
        ...caseData,
        observations: caseData.observations.map((observation) => {
          const edit = edits.get(observation.id);
          return edit === undefined
            ? observation
            : { ...observation, value: edit.value, reportedDecimals: edit.reportedDecimals };
        }),
      }
    : caseData;

  // Before anything reads them. The validator exists to turn a curation error
  // into a load failure a curator can act on, and until now it was called only
  // from a unit test — so in the pipeline a module with, say, an analyte the
  // catalog has no weight for produced empty cells instead of an error, which
  // is the failure it was written to prevent. Same shape as the provenance
  // gate two rounds ago: a guard that protected only its own test.
  for (const module of modules) assertModuleWellFormedOnce(module);
  // And that they compose: a module can be well formed on its own and still
  // collide with another over an id the case flattens.
  assertModulesCompose(modules);

  const features = unionFeatures(modules);
  const resolved = resolveObservations(edited, {
    molecularWeightOf: molecularWeightLookup(),
  });

  const contextFields = applicableContextFields(
    [...UNIVERSAL_CONTEXT_FIELDS, HYDROLYSIS_CONTEXT_FIELD, ...unionContextFields(modules)],
    {
      moduleIds: caseData.moduleIds,
      measurandModes: resolved.map((r) => r.measurandMode),
      enzymeSlugs: lineageEnzymeSlugs(enzymes),
    },
    // The options a field generates rather than declares. Applied here, where
    // the lineage is known, so a module can say "offer the co-medications that
    // move this enzyme" without naming a single substance — which is what lets
    // a curated interaction reach the screen with no registry edit.
  ).map((field) =>
    withGeneratedOptions(field, enzymes, {
      locale,
      // Every module in scope, not just the one that declared the field: a case
      // spanning two families is one profile, and an effect on a feature is a
      // statement about that feature whichever module contributed it.
      effects: modules.flatMap((module) => module.enzymeEffects),
    }),
  );
  // Only the fields this case actually offers. A selection outlives the
  // question that made it applicable: change the last conjugate result to a
  // direct one and the hydrolysis control disappears, while a `snail` still
  // sitting in the case goes on producing hydrolysis artefact warnings for
  // results no hydrolysis was performed on — with nothing on screen to clear.
  //
  // Filtered here rather than deleted from the case: the answer should depend
  // on what applies now, and the selection is still true of the case it was
  // made about. Restore the conjugate result and the protocol is still
  // recorded, which is what a curator correcting a mistyped mode expects.
  const applicableIds = new Set(contextFields.map((field) => field.id));
  const selectedContext = Object.fromEntries(
    Object.entries({ ...caseData.context.fields, ...contextOverrides }).filter(([id]) =>
      applicableIds.has(id),
    ),
  );

  const results = calculateFeatures(edited, resolved, features);

  const presentAnalytes = edited.observations.filter(establishesPresence).map((o) => o.analyte);

  /**
   * One assessment per module, each framed on that module's own parent.
   *
   * A single assessment across a two-module case answered by registry order:
   * the walk was framed on whichever module came first and handed the other
   * module's detections as evidence, so a methadone result was read as a
   * possible source of a benzodiazepine panel — and the answer changed if the
   * modules were listed the other way round. Each walk now sees its own
   * module's parent and its own module's analytes, which is the only scoping
   * under which the question ("what else could have produced *this* pattern")
   * means anything.
   */
  const sourceAmbiguities = modules.map((module) => ({
    moduleId: module.id,
    ambiguity: evaluateSourceAmbiguity({
      graph,
      assumedParent: module.assumedParent,
    // Source inference reasons from presence: an analyte was found, so
    // something produced it. Only qualifiers that positively establish
    // detection may seed it.
    //
    // `not_detected` asserts absence. `below_limit` is `<X` — an interval that
    // includes zero, and so no detection statement at all; an earlier version
    // kept it on the grounds that it is not a claim of absence, which is true
    // and beside the point. Either one would let a negative panel result
    // introduce precursor candidates for a substance nobody found, or demote a
    // candidate from sole-capable to contributing for failing to account for
    // one. `detected_not_quantified` is the qualifier that does assert presence
    // without a number, and it stays.
    //
    // The second filter is scope. The graph is module-scoped, so an unrelated
    // positive — an ethanol result on a diazepam panel — has no node in it, and
    // passing one in downgrades coverage: no module lineage accounts for a
    // substance that was never this profile's business, so a candidate that
    // explains the whole benzodiazepine panel is demoted from sole-capable to
    // contributing on evidence about something else.
    //
      // Scoped to *this* module's declared analytes rather than to the graph's
      // nodes: an analyte a module claims and the graph does not know is still an
      // observation this assessment has to account for, and dropping it would let
      // a candidate that covers the rest read as sole-capable.
      observedAnalytes: presentAnalytes.filter((analyte) =>
        module.analytes.some((a) => a.analyte.pubchemCid === analyte.pubchemCid),
      ),
      knownExposures: caseData.context.knownExposures ?? [],
    }),
  }));

  const analyteLabels = new Map(
    modules.flatMap((m) => m.analytes.map((a) => [a.analyte.pubchemCid, a.labelKey])),
  );

  // The substances that could actually have fed this profile: the assumed
  // parent and everything the walk reached from it. `resolveStatus` decides
  // `mixed_source` against exactly this set, and the statement under it has to
  // name the same substances — otherwise an unrelated co-medication is listed
  // as a declared source of the metabolite pattern, and a genuine mixed-source
  // case names substances that had nothing to do with establishing it.
  // Per assessment, not across the case. A declared exposure is listed under
  // the statement it bears on, and the union would put methadone under a
  // cocaine statement that has just said it speaks for no other module's
  // analytes — a disclosure that contradicts itself in two consecutive lines.
  const declaredFor = (ambiguity: (typeof sourceAmbiguities)[number]['ambiguity']) => {
    const candidateCids = new Set([
      ambiguity.assumedParent.pubchemCid,
      ...ambiguity.candidates.map((c) => c.drug.pubchemCid),
    ]);
    // Only positively declared exposures, and only those that are candidate
    // sources of *this* lineage. A `suspected` one is not a statement that the
    // substance was taken, and listing either it or an unrelated exposure
    // beside the confirmed pair would make the mixed-source claim look broader
    // than the case supports.
    return (caseData.context.knownExposures ?? []).flatMap((exposure) =>
      (exposure.certainty === 'confirmed' || exposure.certainty === 'reported') &&
      candidateCids.has(exposure.drug.pubchemCid)
        ? [
            {
              pubchemCid: exposure.drug.pubchemCid,
              slug: exposure.drug.slug,
              certainty: exposure.certainty,
            },
          ]
        : [],
    );
  };

  return buildRatioProfile({
    observations: edited.observations.map((observation) => ({
      id: observation.id,
      labelKey: analyteLabels.get(observation.analyte.pubchemCid) ?? '',
      pubchemCid: observation.analyte.pubchemCid,
      slug: observation.analyte.slug,
      specimenLabel:
        edited.specimens.find((s) => s.id === observation.specimenId)?.label ??
        observation.specimenId,
      // Only for a quantified result. The type permits a censored observation
      // to carry a `value` and an import can produce one, but the engine reads
      // the limit rather than the value for a censored qualifier — so a model
      // carrying that number invites the view to show it, and a number the
      // arithmetic ignores is worse than no number: it hides the qualifier and
      // the threshold that are the actual result.
      value: observation.qualifier === 'quantified' ? observation.value : undefined,
      reportedDecimals:
        observation.qualifier === 'quantified' ? observation.reportedDecimals : undefined,
      unit: observation.unit,
      qualifier: observation.qualifier,
      limit: observation.limitRef
        ? {
            label: observation.limitRef.label,
            value: observation.limitRef.value,
            unit: observation.limitRef.unit,
            reportedDecimals: observation.limitRef.reportedDecimals,
          }
        : undefined,
    })),
    // The measurement every normalised value on screen is computed from. The
    // method line already discloses the reference it is corrected *to*; without
    // this the reader could check neither the correction nor the specimen value
    // behind it.
    specimenMetrics: edited.specimens.flatMap((specimen) =>
      typeof specimen.urine?.creatinineMmolL === 'number'
        ? [
            {
              specimenId: specimen.id,
              specimenLabel: specimen.label ?? specimen.id,
              labelKey: 'pattern.profile.observations.creatinine',
              value: specimen.urine.creatinineMmolL,
              unit: 'mmol/L',
            },
          ]
        : [],
    ),
    modules,
    features,
    results,
    contextFields,
    selectedContext,
    sourceAmbiguities: sourceAmbiguities.map((assessment) => ({
      ...assessment,
      declaredExposures: declaredFor(assessment.ambiguity),
    })),
    artefactFlags: evaluateArtefactRules({
      rules: modules.flatMap((m) => m.artefactRules),
      features,
      resolved,
      selectedContext,
      contextFields,
    }),
    signals: evaluateSignals({
      signals: modules.flatMap((m) => m.signals),
      results,
      contextFields,
      selectedContext,
      sourceAmbiguityByModule: new Map(
        sourceAmbiguities.map(({ moduleId, ambiguity }) => [moduleId, ambiguity]),
      ),
      urineCreatinineMmolL: unambiguousUrineCreatinine(caseData),
      // Presence of the specimen, not of the measurement. A urine specimen with
      // no creatinine keeps the dilution row and says the basis is
      // indeterminate; a case with no urine at all never offered the metric, so
      // the row would be a proposition pair about a specimen nobody collected.
      presentSpecimenMetrics: new Set<PatternSpecimenMetric>(
        caseData.specimens.some((s) => s.matrix === 'urine') ? ['urine_creatinine'] : [],
      ),
      provenanceResolves: input.provenanceResolves,
    }),
    creatinineReferenceMmolL: caseData.normalization.creatinineReferenceMmolL,
    locale,
  });
}
