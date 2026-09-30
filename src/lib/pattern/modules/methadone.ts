/**
 * The methadone module — the third substance module (plan §10, Phase 2).
 *
 * Chosen for what neither of the first two has: a lineage whose **enzymes**
 * decide a context field. Methadone is N-demethylated to EDDP, principally by
 * CYP2B6, and that route is recorded in the catalog rather than here — so the
 * co-medication row appears because `drug_elimination_routes` says this lineage
 * runs through CYP2B6, and the substances it offers are whatever
 * `drug_enzyme_interactions` currently says induce or inhibit it. Curating an
 * interaction changes what the screen offers with no edit to this file, which is
 * the acceptance criterion this module exists to demonstrate.
 *
 * EDDP is one of the CIDs `data/substanceClasses.ts` already classifies
 * `metabolite` — "methadone's inactive cyclisation product, measured to confirm
 * methadone compliance" — so the `not_applicable` source status rests on the
 * repository's own judgement rather than on an assumption made here. It is the
 * same bar the cocaine module was checked against, and the same reason: an
 * analyte that is marketed or taken in its own right raises a real source
 * ambiguity, and a module asserting otherwise would suppress a warning that
 * belongs on screen.
 *
 * No reference band. EDDP/methadone ratios are published, but §13.3 declines the
 * casework-derived cohorts that would back one and no admitted publication does
 * yet — so the features carry no band at all rather than a hatched placeholder.
 *
 * Adding this file must not require a change under `src/components/`.
 */

import type { PatternSubstanceModule } from '../substanceModules.js';

/**
 * What this module needs from the catalog, and what it cannot put there.
 *
 * The lineage itself now seeds: `data/components.ts` lists EDDP among
 * methadone's metabolites, so `scripts/seed-drugs.ts` links the two and the
 * graph endpoint returns the edge. The CYP routes were already there, which is
 * what makes the context field appear.
 *
 * What the module cannot supply is any guarantee that the lineage is *whole*.
 * Methadone has metabolites other than EDDP, and whether they are entered is a
 * question about the database on the day it is asked, not about this file — so
 * the source walk reads the edges the catalog holds and the profile carries a
 * standing caveat that an unrecorded metabolite may disturb what it computed
 * (§7.3.2, amended 2026-08-24). A methadone case therefore resolves against the
 * recorded neighbourhood rather than waiting on a curator's assertion that the
 * withdrawn completeness panel was never going to collect.
 */
const METHADONE = { pubchemCid: 4095, slug: 'metadon' };
const EDDP = { pubchemCid: 5352621, slug: 'eddp' };

/**
 * Gadel et al. 2013 and 2015 — EDDP formation tracks CYP2B6 catalytic capacity.
 *
 * Both directions of the effect below rest on the same finding rather than on
 * two: the CYP2B6.6 variant N-demethylates methadone at a third to a fifth of
 * wild-type rates, and the variant ranking in the later paper is the same axis
 * read across more alleles. What moves that capacity — an allele, an inducer, an
 * inhibitor — is not what the papers vary, so citing them for an induction claim
 * is citing the mechanism, and the direction follows from it rather than from a
 * study of the interaction itself.
 */
const GADEL_2013 = { type: 'pmid' as const, identifier: '23298862' };
const GADEL_2015 = { type: 'pmid' as const, identifier: '25897175' };

export const METHADONE_MODULE: PatternSubstanceModule = {
  id: 'methadone',
  version: '1.0.0',
  labelKey: 'pattern.profile.module.methadone',
  assumedParent: METHADONE,

  analytes: [
    {
      analyte: METHADONE,
      labelKey: 'pattern.profile.analyte.methadone.label',
      shortLabelKey: 'pattern.profile.analyte.methadone.short',
    },
    {
      analyte: EDDP,
      labelKey: 'pattern.profile.analyte.eddp.label',
      shortLabelKey: 'pattern.profile.analyte.eddp.short',
    },
  ],

  features: [
    {
      id: 'eddp_mtd_b',
      version: '1.0.0',
      moduleId: 'methadone',
      kind: 'parent_metabolite_ratio',
      labelKey: 'pattern.profile.feature.eddpMtdB.label',
      basisKey: 'pattern.profile.feature.eddpMtdB.basis',
      numerator: { terms: [{ analyte: EDDP, matrix: 'blood' }] },
      denominator: { terms: [{ analyte: METHADONE, matrix: 'blood' }] },
      sortOrder: 10,
    },
    {
      // The compliance question as it is actually asked: a urine sample where
      // methadone is present and EDDP is not is the shape that says the dose
      // reached the cup rather than the patient.
      id: 'eddp_mtd_u',
      version: '1.0.0',
      moduleId: 'methadone',
      kind: 'parent_metabolite_ratio',
      labelKey: 'pattern.profile.feature.eddpMtdU.label',
      basisKey: 'pattern.profile.feature.eddpMtdU.basis',
      numerator: { terms: [{ analyte: EDDP, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: METHADONE, matrix: 'urine' }] },
      sortOrder: 20,
    },
    {
      id: 'eddp_u_b',
      version: '1.0.0',
      moduleId: 'methadone',
      kind: 'matrix_same_analyte',
      labelKey: 'pattern.profile.feature.eddpUB.label',
      basisKey: 'pattern.profile.feature.eddpUB.basis',
      numerator: { terms: [{ analyte: EDDP, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: EDDP, matrix: 'blood' }] },
      sortOrder: 30,
    },
  ],

  /**
   * One field, and it names an enzyme rather than this module.
   *
   * Declared as `enzyme` applicability so it appears for the reason it is true —
   * the catalog routes this lineage through CYP2B6 — and disappears if that
   * routing is ever withdrawn. A `module` applicability would put the row on
   * screen because the module is in scope, which is a different claim and one
   * this file would then be asserting on the catalog's behalf.
   *
   * The options are generated. "None stated" and "no co-medication" are
   * statements about the case that no catalog row can supply, so they are
   * declared here; every substance in between comes from
   * `drug_enzyme_interactions`.
   */
  contextFields: [
    {
      id: 'cyp2b6_comed',
      labelKey: 'pattern.profile.context.cyp2b6Comed.label',
      shortKey: 'pattern.profile.context.cyp2b6Comed.short',
      applicability: { type: 'enzyme', enzymeSlug: 'cyp2b6' },
      generatedOptions: { type: 'enzyme_modulators', scope: 'lineage_enzymes' },
      sortOrder: 60,
      options: [
        {
          value: 'none',
          labelKey: 'pattern.profile.context.cyp2b6Comed.none',
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
  ],

  /**
   * How an induction or inhibition of CYP2B6 is expected to move the blood
   * ratio, curated here because no table associates an enzyme with an individual
   * metabolite edge (§7.5) — and a confidently wrong direction on a feature row
   * is worse than no annotation.
   *
   * Only the blood ratio carries one. Induction raises EDDP relative to
   * methadone where both are measured in the same blood draw; what it does to a
   * urine ratio depends on renal handling, pH and collection interval as much as
   * on the enzyme, and stating a direction there would dress a guess as a
   * finding.
   */
  enzymeEffects: [
    {
      enzymeSlug: 'cyp2b6',
      role: 'inducer',
      featureId: 'eddp_mtd_b',
      direction: 'increases',
      referenceCitations: [GADEL_2013, GADEL_2015],
    },
    {
      enzymeSlug: 'cyp2b6',
      role: 'inhibitor',
      featureId: 'eddp_mtd_b',
      direction: 'decreases',
      referenceCitations: [GADEL_2013, GADEL_2015],
    },
  ],

  // No signal: every signal needs a basis feature with published support for a
  // strength expression, and none of these has one. An empty list is the honest
  // state rather than an omission to fill later.
  signals: [],
  notEstablished: [],
  // No analytical protocol here converts one analyte into another. EDDP is a
  // cyclisation product formed in vivo, not something a hydrolysis step makes.
  artefactRules: [],

  // No axis pin: the axis is computed from the case's own values (§8.3).
};
