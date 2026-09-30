/**
 * Substance modules (spec §16.6).
 *
 * A module is everything substance-specific about one drug family: its
 * analytes, its features, the context fields it needs beyond the universal
 * ones, its signals, and the enzyme→feature effects it curates. Adding a family
 * is a data change; nothing under `src/components/modeling/pattern/` may name a
 * substance (§4.1).
 */

import type { PatternDrugRef } from '../../types/patternCase.js';
import { catalogHasMolecularWeight, catalogMolecularWeight } from './catalogAnalytes.js';
import type { PatternArtefactRule } from './artefactRules.js';
import type { PatternContextFieldDefinition } from './contextFields.js';
import type { PatternFeatureDefinition } from './featureRegistry.js';
import type { PatternNotEstablishedDefinition, PatternSignalDefinition } from './signals.js';
import { HYDROLYSIS_CONTEXT_FIELD, UNIVERSAL_CONTEXT_FIELDS } from './contextFields.js';
import { isValidAxisPin } from './profileModel.js';
import { assertSignalWellFormed } from './signals.js';

export interface PatternModuleAnalyte {
  analyte: PatternDrugRef;
  labelKey: string;
  /** Abbreviation used in ratio labels ("NDD"). */
  shortLabelKey: string;
}

/**
 * Enzyme→feature effects, curated per module and keyed by enzyme and role rather
 * than by drug, so one entry covers every inhibitor of that enzyme and the
 * mapping does not grow with the co-medication list (§7.5).
 */
export interface EnzymeFeatureEffect {
  enzymeSlug: string;
  role: 'inhibitor' | 'inducer';
  featureId: string;
  direction: 'increases' | 'decreases' | 'unclear';
  referenceCitations: Array<{ type: 'pmid' | 'doi' | 'url'; identifier: string }>;
}

export interface PatternSubstanceModule {
  id: string;
  version: string;
  labelKey: string;
  /** The substance the profile is framed around. */
  assumedParent: PatternDrugRef;
  analytes: PatternModuleAnalyte[];
  features: PatternFeatureDefinition[];
  /** Module-scoped fields; the universal ones are added by the engine. */
  contextFields: PatternContextFieldDefinition[];
  signals: PatternSignalDefinition[];
  notEstablished: PatternNotEstablishedDefinition[];
  enzymeEffects: EnzymeFeatureEffect[];
  /** Conversions the analytical protocol itself can cause (§7.4). */
  artefactRules: PatternArtefactRule[];
  /**
   * A module may pin the axis for stability across cases (§8.3). The
   * benzodiazepine module pins 0.03–100 to match the approved design; a module
   * that pins nothing gets an axis computed from its own values.
   */
  axisPin?: { lo: number; hi: number };
}

/**
 * Molecular weights come from the catalog, never from the registry — see
 * `catalogAnalytes.ts` for why a second copy is not carried here.
 */
export function molecularWeightLookup(): (analyte: PatternDrugRef) => number | undefined {
  return catalogMolecularWeight;
}

/**
 * Name the owners of a colliding id. Two modules is the case that motivated the
 * check; one module declaring an id twice is the same defect with a shorter
 * story, and it must read as one rather than as "defined by both X and X".
 */
function ownersPhrase(previous: string, next: string): string {
  return previous === next ? `twice by ${next}` : `by both ${previous} and ${next}`;
}

/**
 * Union the features of every module in scope, without duplication. Phase 2's
 * acceptance requires a case spanning two modules to do exactly this.
 */
export function unionFeatures(modules: PatternSubstanceModule[]): PatternFeatureDefinition[] {
  const byId = new Map<string, PatternFeatureDefinition>();
  for (const module of modules) {
    for (const feature of module.features) {
      // First-wins deduplication is the wrong answer for a *conflict*. The
      // discarded definition's signals are still evaluated, and they look their
      // basis up in the shared result map — so the second module's signal binds
      // to the first module's ratio and states a forensic assessment about a
      // quantity it never described. Phase 2 loads two modules at once, which
      // is where the cross-module case would first be reachable.
      //
      // Ownership is the wrong thing to compare, though: a module that declares
      // one id twice carries its own id on both definitions, so an owner check
      // waves it through and drops the later one silently — reachable today,
      // with one module, and invisible because the surviving row looks
      // perfectly ordinary. Identity is what distinguishes a conflict from a
      // harmless repeat: the *same* definition object reaching this loop twice
      // — a shared constant, or one named twice in a module's own array —
      // unions to itself and changes nothing.
      const existing = byId.get(feature.id);
      if (existing && existing !== feature) {
        throw new Error(
          `Feature id ${feature.id} is defined ` +
            `${ownersPhrase(existing.moduleId, feature.moduleId)}; ids are the key signals ` +
            'and results are matched on, so two definitions cannot share one (§7.1)',
        );
      }
      if (!existing) byId.set(feature.id, feature);
    }
  }
  return [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Union the module-scoped context fields, without duplication. */
/**
 * Every id-keyed collection a case flattens across modules, checked for
 * collisions before anything reads them.
 *
 * `unionFeatures` refuses a conflicting feature id, and features are not the
 * only ids that matter: signals are keyed by id into the demoted set, so two
 * modules sharing one send *both* rows to "Ikke etablert" when either qualifies;
 * artefact rules are keyed by id when the method footer decides which citations
 * to print; and every one of them is a React key, so a collision reconciles a
 * row onto the wrong article when applicability changes. None of it is
 * reachable before Phase 2 loads two modules at once, which is exactly why it
 * should be settled now rather than found then.
 */
export function assertModulesCompose(modules: PatternSubstanceModule[]): void {
  // A module list is a set of families in scope, and the same family twice is
  // not a stronger claim about anything. The union helpers deduplicate what
  // they key by id, but the pipeline flattens signals, artefact rules and
  // not-established entries straight out of `modules` — so a repeat delivers
  // every forensic assessment row, caution and demoted entry twice, on
  // duplicate React keys. That is a caller error rather than a registry one,
  // and it is cheaper to refuse than to deduplicate four collections and hope
  // the fifth remembers.
  const seenModules = new Set<string>();
  for (const module of modules) {
    if (seenModules.has(module.id)) {
      throw new Error(
        `Module ${module.id} appears twice in one profile; the modules in scope are a set, ` +
          'and a repeat duplicates every row flattened out of them',
      );
    }
    seenModules.add(module.id);
  }

  interface Entry {
    id: string;
    moduleId: string;
    /** Compared by identity, for the reason given in `unionFeatures`. */
    definition: object;
  }
  const collections: Array<{ what: string; entries: Entry[] }> = [
    {
      what: 'signal',
      entries: modules.flatMap((module) =>
        module.signals.map((signal) => ({
          id: signal.id,
          moduleId: module.id,
          definition: signal,
        })),
      ),
    },
    {
      what: 'artefact rule',
      entries: modules.flatMap((module) =>
        module.artefactRules.map((rule) => ({ id: rule.id, moduleId: module.id, definition: rule })),
      ),
    },
    {
      what: 'not-established entry',
      entries: modules.flatMap((module) =>
        module.notEstablished.map((entry) => ({
          id: entry.id,
          moduleId: module.id,
          definition: entry,
        })),
      ),
    },
  ];

  for (const { what, entries } of collections) {
    const seen = new Map<string, Entry>();
    for (const entry of entries) {
      const previous = seen.get(entry.id);
      if (previous && previous.definition !== entry.definition) {
        throw new Error(
          `${what} id ${entry.id} is defined ` +
            `${ownersPhrase(previous.moduleId, entry.moduleId)}; ids are how rows are matched ` +
            'and keyed, so two definitions cannot share one',
        );
      }
      if (!previous) seen.set(entry.id, entry);
    }
  }
}

export function unionContextFields(
  modules: PatternSubstanceModule[],
): PatternContextFieldDefinition[] {
  const byId = new Map<string, PatternContextFieldDefinition>();
  const owner = new Map<string, string>();
  for (const module of modules) {
    for (const field of module.contextFields) {
      // Two modules may legitimately declare the *same* shared field — that is
      // what a shared field is, and identity is what says so. Two different
      // fields under one id is the collision: a signal's `dependsOn` names an
      // id, so it would degrade on, or read, whichever definition happened to
      // load first. That holds whether the two come from two modules or from
      // one module declaring the id twice, so ownership is not part of the
      // test.
      const existing = byId.get(field.id);
      if (existing && existing !== field) {
        throw new Error(
          `Context field id ${field.id} is given two different definitions ` +
            `${ownersPhrase(owner.get(field.id)!, module.id)}; signals depend on ids, so two ` +
            'definitions cannot share one',
        );
      }
      if (!existing) {
        byId.set(field.id, field);
        owner.set(field.id, module.id);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Validate a module at load. Fails loudly: a registry that half-loads is worse
 * than one that refuses, because the missing half is invisible on screen.
 */
/**
 * Modules already checked, so the production pipeline can validate on every
 * build without re-walking a static registry on every keystroke.
 *
 * Keyed on the module object rather than on its id: two objects claiming the
 * same id are two different registries, and caching by id would let the second
 * inherit the first's clean bill of health.
 */
const VALIDATED = new WeakSet<PatternSubstanceModule>();

/**
 * Validate a module once, and remember that it passed.
 *
 * This is what the pipeline calls. `assertModuleWellFormed` stays exported and
 * uncached for tests that build a fresh invalid module each time and expect it
 * to throw on every call.
 */
export function assertModuleWellFormedOnce(module: PatternSubstanceModule): void {
  if (VALIDATED.has(module)) return;
  assertModuleWellFormed(module);
  VALIDATED.add(module);
}

export function assertModuleWellFormed(module: PatternSubstanceModule): void {
  const analyteCids = new Set(module.analytes.map((a) => a.analyte.pubchemCid));

  for (const entry of module.analytes) {
    // Fails loudly at load: a mass result for an analyte the catalog carries no
    // weight for would otherwise resolve indeterminate at render time, which
    // hides a curation gap behind an empty cell.
    if (!catalogHasMolecularWeight(entry.analyte)) {
      throw new Error(
        `Module ${module.id}: the catalog has no molecular weight for CID ` +
          `${entry.analyte.pubchemCid}; add it to data/components.ts first (spec §16.5)`,
      );
    }
  }

  for (const feature of module.features) {
    const terms = [...feature.numerator.terms, ...feature.denominator.terms];
    for (const term of terms) {
      if (!analyteCids.has(term.analyte.pubchemCid)) {
        throw new Error(
          `Module ${module.id}: feature ${feature.id} names CID ${term.analyte.pubchemCid}, ` +
            'which the module does not declare as an analyte',
        );
      }
    }
    if (feature.status === 'withdrawn' && !feature.withdrawnRationaleKey) {
      throw new Error(
        `Module ${module.id}: withdrawn feature ${feature.id} must state why (§7.1)`,
      );
    }
    // A percentile that is not a positive number has no position on a
    // logarithmic axis — `positionOf` returns NaN and the band renders at
    // `NaN%` — and percentiles out of order draw a band that is collapsed or
    // reversed while the text beside it states the intended bounds. Both are
    // curation errors that reach a reader as a plot rather than as an error.
    const band = feature.provisionalBand;
    if (band) {
      const percentiles = [band.p5, band.p50, band.p95];
      if (!percentiles.every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error(
          `Module ${module.id}: feature ${feature.id} has a band percentile that is not a ` +
            `positive number (p5=${band.p5} p50=${band.p50} p95=${band.p95}); a logarithmic ` +
            'axis has no position for one (§8.3)',
        );
      }
      if (!(band.p5 <= band.p50 && band.p50 <= band.p95)) {
        throw new Error(
          `Module ${module.id}: feature ${feature.id} has band percentiles out of order ` +
            `(p5=${band.p5} p50=${band.p50} p95=${band.p95})`,
        );
      }
    }
  }

  const featureIds = new Set(module.features.map((f) => f.id));
  // Every field a signal could name: the universal ones, the measurand-derived
  // hydrolysis field, and the module's own. Applicability narrows this per case
  // at render time; existence is what a registry can be checked against.
  const builtInFieldIds = new Set([
    ...UNIVERSAL_CONTEXT_FIELDS.map((f) => f.id),
    HYDROLYSIS_CONTEXT_FIELD.id,
  ]);
  // A module field under a built-in id survives composition, because the engine
  // concatenates the built-ins with the module ones and `unionContextFields`
  // only ever sees the module half. Both definitions then reach the view: two
  // controls for one id, on the same React key, and `evaluateSignals` builds an
  // id-keyed map that keeps the later one — so the field the reader answers and
  // the field the signal reads can be different objects with different options.
  // The screen and the calculation disagree, and nothing on it says so.
  for (const field of module.contextFields) {
    if (builtInFieldIds.has(field.id)) {
      throw new Error(
        `Module ${module.id}: context field ${field.id} is already a built-in field; ` +
          'a module cannot redefine one, because both definitions survive composition',
      );
    }
  }
  const knownFieldIds = new Set([...builtInFieldIds, ...module.contextFields.map((f) => f.id)]);
  for (const signal of module.signals) {
    assertSignalWellFormed(signal);
    // Both feature references, not just the basis. A threshold rule names its
    // quantity separately, and the two are ordinarily the same feature — which
    // is exactly why a typo in the second one is easy to miss. Unvalidated, it
    // loads cleanly and then `quantityFor` finds nothing, so the screen reports
    // an indeterminate *case* basis: the registry's defect, blamed on the
    // laboratory's data.
    const references = [
      signal.basis,
      ...(signal.strength.type === 'threshold' ? [signal.strength.quantity] : []),
    ];
    for (const reference of references) {
      if (reference.type === 'feature' && !featureIds.has(reference.featureId)) {
        throw new Error(
          `Module ${module.id}: signal ${signal.id} rests on unknown feature ${reference.featureId}`,
        );
      }
    }

    // Same reasoning as the feature references, on the other kind of id. A
    // misspelled dependency is read at render time as a field the *case* did
    // not answer: the signal degrades, the line naming the missing field has no
    // name to give, and the strength reports not-calculable. The registry's
    // defect, delivered as a gap in the case.
    for (const fieldId of signal.dependsOn) {
      if (!knownFieldIds.has(fieldId)) {
        throw new Error(
          `Module ${module.id}: signal ${signal.id} depends on unknown context field ${fieldId}`,
        );
      }
    }
  }

  // A logarithmic axis has no place for zero or a negative bound, and `lo: 0`
  // is exactly what someone reaches for when pinning an ordinary linear one.
  // Left to the arithmetic it does not render wrongly — it hangs the page in a
  // loop that never advances from `-Infinity`.
  //
  // A pin must also contain parity. `{ lo: 10, hi: 100 }` is a perfectly valid
  // logarithmic span, and pinning it puts the parity line off the track: every
  // ratio on this screen is read against 1, so a plot with no 1 on it shows
  // markers with nothing to be above or below. The axis computed from a case's
  // own values includes 1 unconditionally, and a pin is not a licence to
  // disagree with that.
  if (module.axisPin && !isValidAxisPin(module.axisPin.lo, module.axisPin.hi)) {
    throw new Error(
      `Module ${module.id}: axisPin must be a positive span with hi > lo that contains ` +
        `parity (lo <= 1 <= hi) on a logarithmic axis, got lo=${module.axisPin.lo} ` +
        `hi=${module.axisPin.hi} (§8.3)`,
    );
  }

  for (const effect of module.enzymeEffects) {
    if (!featureIds.has(effect.featureId)) {
      throw new Error(
        `Module ${module.id}: enzyme effect names unknown feature ${effect.featureId}`,
      );
    }
  }
}
