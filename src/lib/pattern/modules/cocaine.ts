/**
 * The cocaine module — the second substance module, and the generalisation test
 * (§4.1).
 *
 * Chosen deliberately because it exercises what diazepam does not: no reference
 * band at all, no CYP genotype field (the hydrolysis is esterase-mediated), a
 * single metabolite, and no administrable alternative source. That is what most
 * second modules will look like.
 *
 * Benzoylecgonine is one of the CIDs `data/substanceClasses.ts` already
 * classifies `metabolite` — "cocaine's inactive hydrolysis product, no
 * pharmacological effect and no reason to give it" — so the `not_applicable`
 * branch is exercised against the repository's own judgement rather than an
 * assumption made here. Anything picked for this test must be checked against
 * `substance_class` first: an earlier draft used venlafaxine/O-desmethyl­
 * venlafaxine and tramadol/O-desmethyltramadol, and both were wrong, because
 * ODV *is* marketed desvenlafaxine and O-desmethyltramadol is taken
 * recreationally in its own right. Both would have raised a real source
 * ambiguity and failed the no-warning assertion.
 *
 * Adding this file must not require a change under `src/components/`.
 */

import type { PatternSubstanceModule } from '../substanceModules.js';

const COCAINE = { pubchemCid: 446220, slug: 'kokain' };
const BENZOYLECGONINE = { pubchemCid: 448223, slug: 'benzoylecgonin' };

export const COCAINE_MODULE: PatternSubstanceModule = {
  id: 'cocaine',
  version: '1.0.0',
  labelKey: 'pattern.profile.module.cocaine',
  assumedParent: COCAINE,

  analytes: [
    {
      analyte: COCAINE,
      labelKey: 'pattern.profile.analyte.cocaine.label',
      shortLabelKey: 'pattern.profile.analyte.cocaine.short',
    },
    {
      analyte: BENZOYLECGONINE,
      labelKey: 'pattern.profile.analyte.benzoylecgonine.label',
      shortLabelKey: 'pattern.profile.analyte.benzoylecgonine.short',
    },
  ],

  features: [
    {
      id: 'be_coc',
      version: '1.0.0',
      moduleId: 'cocaine',
      kind: 'parent_metabolite_ratio',
      labelKey: 'pattern.profile.feature.beCoc.label',
      basisKey: 'pattern.profile.feature.beCoc.basis',
      numerator: { terms: [{ analyte: BENZOYLECGONINE, matrix: 'blood' }] },
      denominator: { terms: [{ analyte: COCAINE, matrix: 'blood' }] },
      sortOrder: 10,
      // No band. Not a placeholder, not hatched — absent, because no published
      // cohort backs one and §13.3 declines the casework that would.
    },
    {
      id: 'be_u_b',
      version: '1.0.0',
      moduleId: 'cocaine',
      kind: 'matrix_same_analyte',
      labelKey: 'pattern.profile.feature.beUB.label',
      basisKey: 'pattern.profile.feature.beUB.basis',
      numerator: { terms: [{ analyte: BENZOYLECGONINE, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: BENZOYLECGONINE, matrix: 'blood' }] },
      sortOrder: 20,
    },
  ],

  // No module-scoped context field: the universal three are all that apply. No
  // genotype row appears, and nobody decided that — the genotype field is
  // enzyme-derived and this lineage routes through none.
  contextFields: [],

  // No signal. Every signal needs a basis feature that qualifies, and neither of
  // these carries published support for a strength expression or an established
  // band. An empty list here is the honest state, not an omission to fill later.
  signals: [],
  notEstablished: [],
  enzymeEffects: [],
  // No analytical protocol here converts one analyte into another.
  artefactRules: [],

  // No axis pin: the axis is computed from the case's own values (§8.3).
};
