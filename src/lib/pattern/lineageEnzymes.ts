/**
 * Which enzymes a case's lineage routes through, and who moves them (§7.2).
 *
 * Two questions the metabolism graph cannot answer, because no table associates
 * an enzyme with an individual metabolite edge (plan §7.5 — per-edge attribution
 * is a schema change with its own review). What the catalog does record is which
 * enzymes a substance is *eliminated through* (`drug_elimination_routes`) and
 * which substances **induce or inhibit** an enzyme
 * (`drug_enzyme_interactions`). Both are read from there, so neither the module
 * nor this file curates a second copy of a fact the registry already holds —
 * which is the whole point of the enzyme-derived field. A module gets its
 * CYP2B6 row because the catalog routes its parent through CYP2B6, and the
 * co-medication options are whatever the catalog currently says moves it.
 *
 * The consequence is that curating a new interaction changes what the screen
 * offers, with no registry edit and no release. That is the acceptance criterion
 * (plan §10 Phase 2) and it is also the risk: an option list assembled from
 * catalog rows is only as good as those rows, so what arrives here is the
 * catalog's own statement — role, strength and the substance's own name — and
 * never a judgement this file invented about a drug it was handed.
 */

import { resolveDrugName } from '../drugNames.js';
import type { PatternCitationRef, PatternDrugRef } from '../../types/patternCase.js';
import type { PatternContextFieldDefinition, PatternContextOption } from './contextFields.js';
import type { EnzymeFeatureEffect } from './substanceModules.js';

/** A substance the catalog eliminates through an enzyme. */
export interface LineageSubstrate {
  /** `bio_entities.slug`, the identity a module's field names. */
  enzymeSlug: string;
  drug: PatternDrugRef;
}

/**
 * A substance the catalog records as moving an enzyme, offered as a
 * co-medication.
 *
 * `names` is the catalog's own, per language, resolved against the reader's
 * locale where the option is built. The options are generated, so there is no
 * message key to render — and inventing one per substance would put a
 * translation layer between the curator's catalog and the screen that shows it,
 * where a drug added today would render as its own key until somebody
 * translated it. The catalog is already the translation.
 */
export interface LineageModulator {
  enzymeSlug: string;
  drug: PatternDrugRef;
  names: Record<string, string>;
  role: 'inducer' | 'inhibitor';
  /** The catalog's coarse magnitude, where it has one. */
  strength?: 'weak' | 'moderate' | 'strong' | null;
  /**
   * What the catalog cites for the interaction itself.
   *
   * A different claim from the module's enzyme effects, which say how enzyme
   * activity moves a ratio. This one says that *this substance* moves *this
   * enzyme*, and the screen states it the moment the option is offered — so a
   * reader asking who says so is owed the catalog's answer and not a paper
   * about the mechanism.
   */
  citations?: PatternCitationRef[];
}

export interface LineageEnzymes {
  substrates: LineageSubstrate[];
  modulators: LineageModulator[];
}

export const EMPTY_LINEAGE_ENZYMES: LineageEnzymes = { substrates: [], modulators: [] };

/** Every enzyme the lineage routes through, as slugs. */
export function lineageEnzymeSlugs(enzymes: LineageEnzymes): Set<string> {
  return new Set(enzymes.substrates.map((substrate) => substrate.enzymeSlug));
}

/**
 * The option value a generated co-medication is stored under.
 *
 * Keyed by identity and role, because the same substance can both induce and
 * inhibit — different enzymes, and sometimes the same one on different
 * timescales — and a case that recorded only the substance could not say which
 * statement was made about it.
 */
export function modulatorValue(modulator: LineageModulator): string {
  return `${modulator.role}:${modulator.drug.pubchemCid}`;
}

/**
 * A field's options with the generated ones added.
 *
 * Generated options are appended to the declared ones rather than replacing
 * them: a field still needs its "none" and its "not stated", and those are
 * statements about the case that no catalog row can supply.
 *
 * Scoped to the enzymes this case's lineage actually routes through. A field
 * offering every inhibitor in the catalog would be a list of a few hundred
 * substances, of which the handful that matter are the ones touching this
 * lineage — and the reader has no way to tell which those are.
 *
 * Each option carries the module's own statement about what selecting it does:
 * `enzymeEffects` says how an induction or an inhibition of that enzyme is
 * expected to move a named feature, and the option is where that reaches the
 * profile. Without the join the effects are validated at load and then inert —
 * a curator picks a strong inducer and no feature row says anything, which is
 * the failure mode of an unexercised mechanism, on the day something finally
 * feeds it.
 */
export function withGeneratedOptions(
  field: PatternContextFieldDefinition,
  enzymes: LineageEnzymes,
  options: {
    /** The reader's locale, for the catalog's own name. */
    locale?: string;
    /** Every module in scope declares how its features answer to an enzyme. */
    effects?: readonly EnzymeFeatureEffect[];
  } = {},
): PatternContextFieldDefinition {
  if (field.generatedOptions?.type !== 'enzyme_modulators') return field;

  // A field about one enzyme offers that enzyme's modulators, not the whole
  // lineage's. A substance is routed through a dozen CYPs in an ordinary
  // catalog entry, and the union of everything that moves any of them is a list
  // of hundreds in which the few that bear on this question are indistinguishable
  // — an option list nobody can read is not an option list. A field that names
  // no enzyme has nothing to narrow by and takes the lineage entire.
  const lineage = lineageEnzymeSlugs(enzymes);
  const slugs =
    field.applicability.type === 'enzyme'
      ? new Set(lineage.has(field.applicability.enzymeSlug) ? [field.applicability.enzymeSlug] : [])
      : lineage;
  const lang = (options.locale ?? 'nb-NO').split('-')[0] as 'nb' | 'en';
  const seen = new Set(field.options.map((option) => option.value));
  const generated: PatternContextOption[] = [];
  for (const modulator of enzymes.modulators) {
    if (!slugs.has(modulator.enzymeSlug)) continue;
    const value = modulatorValue(modulator);
    // One option per substance and role, whatever the catalog holds. A drug
    // recorded as an inhibitor of two lineage enzymes is one thing a curator
    // can state about the case, and offering it twice would make the same
    // answer look like two.
    if (seen.has(value)) continue;
    seen.add(value);
    // What the modules say this selection does. Keyed on the enzyme *and* the
    // role: an inducer and an inhibitor of one enzyme move a feature in
    // opposite directions, and an effect matched on the enzyme alone would
    // annotate both rows with whichever the module happened to declare first.
    const modifiers = (options.effects ?? [])
      .filter(
        (effect) =>
          effect.enzymeSlug === modulator.enzymeSlug && effect.role === modulator.role,
      )
      .map((effect) => ({ featureId: effect.featureId, direction: effect.direction }));
    generated.push({
      value,
      // The catalog's own name, carried rather than keyed — see LineageModulator.
      labelKey: '',
      label: resolveDrugName(modulator.names, lang),
      // The role always, not only where two options would otherwise collide.
      // The option *is* a role claim — "a substance that induces this enzyme
      // was co-administered" — so a list that states it on one line and not the
      // next reads as though the unqualified ones were something else. Where
      // the catalog does record both roles for one substance, this is also the
      // only thing telling two identical names apart.
      labelSuffixKey: `pattern.profile.context.modulator.${modulator.role}`,
      state: 'known',
      ...(modifiers.length === 0 ? {} : { modifiers }),
      ...(modulator.citations && modulator.citations.length > 0
        ? { referenceCitations: modulator.citations }
        : {}),
    });
  }

  // Sorted by the name as shown, because the catalog's order is `sort_order`
  // within one drug's interactions and means nothing across substances. A
  // reader looking for a substance they have in hand is scanning alphabetically
  // — in their own language, which is why this sorts after resolving the name.
  generated.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '', lang));

  const defaultIndex = field.options.findIndex((option) => option.isDefault);
  // The default stays last. It is "not stated", and a list that ends on the
  // answer meaning "nobody said" reads as the fallback it is.
  return defaultIndex === -1
    ? { ...field, options: [...field.options, ...generated] }
    : {
        ...field,
        options: [
          ...field.options.slice(0, defaultIndex),
          ...generated,
          ...field.options.slice(defaultIndex),
        ],
      };
}
