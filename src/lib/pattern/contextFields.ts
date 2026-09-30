/**
 * Context fields — the "Saksdata" rows (§7.2).
 *
 * Each entry declares **why** it applies, so a cocaine case gets no genotype row
 * and no hydrolysis row without anyone deciding that, and a tramadol case gets a
 * CYP2D6 row for the same reason diazepam gets a CYP2C19 one.
 */

import type { PatternCitationRef, PatternMeasurandMode } from '../../types/patternCase.js';

export type ContextFieldApplicability =
  /** Always offered (matrix provenance, sampling interval). */
  | { type: 'universal' }
  /** Offered when the module is in scope for the case. */
  | { type: 'module'; moduleId: string }
  /** Offered when the case's lineage routes through this enzyme. */
  | { type: 'enzyme'; enzymeSlug: string }
  /** Offered when an observation declares a measurand mode that makes it material. */
  | { type: 'measurand'; modes: PatternMeasurandMode[] };

/**
 * How an option is expected to move a specific feature. Curated per module,
 * because no table associates an enzyme with an individual metabolite edge and a
 * confidently wrong direction on a feature row is worse than no annotation
 * (§7.5).
 */
export interface PatternModifier {
  featureId: string;
  direction: 'increases' | 'decreases' | 'unclear';
}

export interface PatternContextOption {
  /** Stable value stored in the case; never the display string. */
  value: string;
  labelKey: string;
  /**
   * A label the app did not choose, for an option it did not write.
   *
   * Generated co-medication options carry a substance's own catalog name, which
   * has no message key and should not acquire one: a drug curated today would
   * then render as `pattern.profile.context.comed.karbamazepin` until somebody
   * translated it, and the translation would be a second spelling of a name the
   * catalog already holds. Where this is set the view shows it instead of
   * resolving `labelKey`, which is empty for exactly those options.
   */
  label?: string;
  /**
   * A qualifier the view appends to `label`, as a message key.
   *
   * The catalog records a substance's *role* separately from its name, and the
   * two cannot be concatenated where the label is written: the name comes from
   * the catalog and the role is a word this app owns in each language. A
   * co-medication that both induces and inhibits one enzyme is two options with
   * opposite effects, which the uniqueness key on
   * `(drug_id, bio_entity_id, role)` explicitly allows — rendered on the name
   * alone they are two identical lines, and a curator picking one cannot tell
   * which effect they filed.
   */
  labelSuffixKey?: string;
  /** `known` renders foreground; `assumed` muted; `missing` destructive. */
  state: 'known' | 'assumed' | 'missing';
  isDefault?: boolean;
  modifiers?: PatternModifier[];
  /**
   * What the catalog cites for the claim the option itself makes.
   *
   * A generated co-medication says "this substance moves this enzyme", which is
   * the catalog's statement and not the module's — and it is on screen from the
   * moment the option is offered. The module's own papers say what enzyme
   * activity does to a ratio, which is the next claim along, so the two are
   * collected separately and both belong in the method footer.
   */
  referenceCitations?: PatternCitationRef[];
}

export interface PatternContextFieldDefinition {
  id: string;
  labelKey: string;
  /** Short form used in degradation lines ("CYP2C19-genotype"). */
  shortKey: string;
  applicability: ContextFieldApplicability;
  options: PatternContextOption[];
  generatedOptions?: { type: 'enzyme_modulators'; scope: 'lineage_enzymes' };
  sortOrder: number;
}

/**
 * The three universal fields. Matrix provenance and sampling interval bear on
 * every module because every case has specimens and a chronology.
 */
export const UNIVERSAL_CONTEXT_FIELDS: PatternContextFieldDefinition[] = [
  {
    id: 'bmatrix',
    labelKey: 'pattern.profile.context.bmatrix.label',
    shortKey: 'pattern.profile.context.bmatrix.short',
    applicability: { type: 'universal' },
    sortOrder: 10,
    options: [
      {
        value: 'antemortem_whole_blood',
        labelKey: 'pattern.profile.context.bmatrix.antemortemWholeBlood',
        state: 'known',
      },
      {
        value: 'postmortem_femoral',
        labelKey: 'pattern.profile.context.bmatrix.postmortemFemoral',
        state: 'known',
      },
      {
        value: 'postmortem_cardiac',
        labelKey: 'pattern.profile.context.bmatrix.postmortemCardiac',
        state: 'known',
      },
      {
        value: 'not_stated',
        labelKey: 'pattern.profile.context.notStated',
        state: 'missing',
        isDefault: true,
      },
    ],
  },
  {
    id: 'umatrix',
    labelKey: 'pattern.profile.context.umatrix.label',
    shortKey: 'pattern.profile.context.umatrix.short',
    applicability: { type: 'universal' },
    sortOrder: 20,
    options: [
      { value: 'spot', labelKey: 'pattern.profile.context.umatrix.spot', state: 'known' },
      { value: 'timed', labelKey: 'pattern.profile.context.umatrix.timed', state: 'known' },
      {
        value: 'catheter_postmortem',
        labelKey: 'pattern.profile.context.umatrix.catheterPostmortem',
        state: 'known',
      },
      {
        value: 'not_stated',
        labelKey: 'pattern.profile.context.notStated',
        state: 'missing',
        isDefault: true,
      },
    ],
  },
  {
    id: 'interval',
    labelKey: 'pattern.profile.context.interval.label',
    shortKey: 'pattern.profile.context.interval.short',
    applicability: { type: 'universal' },
    sortOrder: 30,
    options: [
      { value: 'simultaneous', labelKey: 'pattern.profile.context.interval.simultaneous', state: 'known' },
      { value: 'lt_2h', labelKey: 'pattern.profile.context.interval.lt2h', state: 'known' },
      { value: 'gt_2h', labelKey: 'pattern.profile.context.interval.gt2h', state: 'known' },
      {
        value: 'not_stated',
        labelKey: 'pattern.profile.context.notStated',
        state: 'missing',
        isDefault: true,
      },
    ],
  },
];

/**
 * The hydrolysis field, offered whenever a conjugated or total-after-hydrolysis
 * measurand is present.
 *
 * Its default is **"ikke angitt" (`missing`), not "ingen" (`assumed`)** — §3.3's
 * first content change. Defaulting to "no hydrolysis" silently asserts a
 * protocol that changes measured oxazepam and temazepam severalfold and can, by
 * reductive conversion, corrupt five of the six urine-side ratios. An assumption
 * that strong is not a default; it is a missing datum.
 */
export const HYDROLYSIS_CONTEXT_FIELD: PatternContextFieldDefinition = {
  id: 'hydro',
  labelKey: 'pattern.profile.context.hydro.label',
  shortKey: 'pattern.profile.context.hydro.short',
  applicability: {
    type: 'measurand',
    modes: ['direct_conjugate', 'total_after_hydrolysis'],
  },
  sortOrder: 40,
  options: [
    { value: 'none', labelKey: 'pattern.profile.context.hydro.none', state: 'known' },
    { value: 'snail', labelKey: 'pattern.profile.context.hydro.snail', state: 'known' },
    { value: 'recombinant', labelKey: 'pattern.profile.context.hydro.recombinant', state: 'known' },
    {
      value: 'not_stated',
      labelKey: 'pattern.profile.context.notStated',
      state: 'missing',
      isDefault: true,
    },
  ],
};

/**
 * Which fields a case actually offers, given its modules, the measurand modes
 * its observations declare, and the enzymes its lineage routes through.
 */
export function applicableContextFields(
  fields: PatternContextFieldDefinition[],
  scope: {
    moduleIds: string[];
    measurandModes: PatternMeasurandMode[];
    /**
     * The enzymes this case's lineage routes through, from the catalog's own
     * elimination routes. Absent where nothing has asked — an export path, a
     * test about matrix fields — and an absent lineage offers no enzyme row,
     * which is the same answer an uncurated route gives.
     */
    enzymeSlugs?: ReadonlySet<string>;
  },
): PatternContextFieldDefinition[] {
  return fields
    .filter((field) => {
      switch (field.applicability.type) {
        case 'universal':
          return true;
        case 'module':
          return scope.moduleIds.includes(field.applicability.moduleId);
        case 'measurand':
          return field.applicability.modes.some((mode) => scope.measurandModes.includes(mode));
        case 'enzyme':
          // Resolved from the catalog's elimination routes, never guessed: the
          // field appears because this lineage is *recorded* as routing through
          // that enzyme, so a module cannot assert a genotype question its
          // substances' metabolism does not raise (§7.2).
          return scope.enzymeSlugs?.has(field.applicability.enzymeSlug) ?? false;
        default:
          return false;
      }
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The default option's value, or `undefined` where the field declares none. */
export function defaultValue(field: PatternContextFieldDefinition): string | undefined {
  return field.options.find((option) => option.isDefault)?.value;
}

/**
 * Count of fields whose selected option is `missing` or `assumed`. The view
 * shows both counts; a reader deciding how much weight to give the screen needs
 * to know how much of it rests on unstated data.
 */
export function contextSummary(
  fields: PatternContextFieldDefinition[],
  selected: Record<string, string>,
): { missing: number; assumed: number } {
  let missing = 0;
  let assumed = 0;
  for (const field of fields) {
    const value = selected[field.id] ?? defaultValue(field);
    const option = field.options.find((o) => o.value === value);
    // A value no option matches counts as missing, not as nothing. Skipping it
    // would let a case with an obsolete stored value report a clean context
    // summary while the view showed an unknown selection.
    if (!option || option.state === 'missing') missing += 1;
    else if (option.state === 'assumed') assumed += 1;
  }
  return { missing, assumed };
}
