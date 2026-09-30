/**
 * The benzodiazepine (diazepam) module — the first substance module.
 *
 * Every substance-specific fact on the handoff's screen lives here as data. The
 * four content changes from the Layer A scientific review of 2026-08-11 (§3.3)
 * are applied at source rather than as a later rewrite:
 *
 *  1. the hydrolysis field defaults to "not stated", not "none" — in
 *     `contextFields.ts`, since the field is measurand-derived and universal in
 *     shape;
 *  2. `tem_oxa`'s basis line states what the quantity *is* and drops the causal
 *     attribution to "CYP3A4- og CYP2C19-avhengige trinn" (A3: over-attributed);
 *  3. `ndd_dwn` and the single-vs-repeated signal carry the accumulation
 *     rationale as citations, recorded as the reason the signal stays
 *     not-calculable rather than as support for a claim;
 *  4. "Etterlevelse av forskrivning" is a `notEstablished` entry, not a signal.
 *
 * CIDs and molecular weights are the catalog's own (`data/components.ts`). Note
 * temazepam is catalogued as "3-OH Diazepam" (CID 5391) — the very conflation
 * Layer A's A1 finding is about. The registry names the substance correctly and
 * types the ratio as a `branch_ratio`, which derives the warning that a branch
 * product is not a sequential step.
 */

import type { PatternSubstanceModule } from '../substanceModules.js';

const DIAZEPAM = { pubchemCid: 3016, slug: 'diazepam' };
const NORDAZEPAM = { pubchemCid: 2997, slug: 'n-desmetyldiazepam' };
const TEMAZEPAM = { pubchemCid: 5391, slug: 'temazepam' };
const OXAZEPAM = { pubchemCid: 4616, slug: 'oxazepam' };

/** Luk et al. 2014 — urinary fractions, and the CYP2C19/CYP3A4 effect directions. */
const LUK_2014 = { type: 'pmid' as const, identifier: '24500275' };
/** Wang et al. 2020 and Jones & Holmgren 2012 — time since last intake. */
const WANG_2020 = { type: 'pmid' as const, identifier: '32219697' };
const JONES_2012 = { type: 'pmid' as const, identifier: '22797834' };
/**
 * Fu et al. 2010 — β-glucuronidase reductively converts oxazepam to nordiazepam.
 * This is the source for Layer A's A4 artefact, and it is the paper PMID
 * 20529458 actually names.
 */
const FU_2010 = { type: 'pmid' as const, identifier: '20529458' };
/**
 * Cone et al. 2009 — creatinine and specific-gravity normalisation of urinary
 * drug concentrations.
 *
 * It supports normalisation as a way of handling dilute specimens. It does
 * **not** publish a mapping from creatinine concentration onto ENFSI verbal
 * strength steps, which is why the dilution signal states no strength: see the
 * signal itself.
 */
const CONE_2009 = { type: 'pmid' as const, identifier: '19161663' };

export const BENZODIAZEPINE_MODULE: PatternSubstanceModule = {
  id: 'benzodiazepines',
  version: '1.0.0',
  labelKey: 'pattern.profile.module.benzodiazepines',
  assumedParent: DIAZEPAM,

  analytes: [
    {
      analyte: DIAZEPAM,
      labelKey: 'pattern.profile.analyte.diazepam.label',
      shortLabelKey: 'pattern.profile.analyte.diazepam.short',
    },
    {
      analyte: NORDAZEPAM,
      labelKey: 'pattern.profile.analyte.nordazepam.label',
      shortLabelKey: 'pattern.profile.analyte.nordazepam.short',
    },
    {
      analyte: TEMAZEPAM,
      labelKey: 'pattern.profile.analyte.temazepam.label',
      shortLabelKey: 'pattern.profile.analyte.temazepam.short',
    },
    {
      analyte: OXAZEPAM,
      labelKey: 'pattern.profile.analyte.oxazepam.label',
      shortLabelKey: 'pattern.profile.analyte.oxazepam.short',
    },
  ],

  features: [
    {
      id: 'ndd_dzp',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'parent_metabolite_ratio',
      labelKey: 'pattern.profile.feature.nddDzp.label',
      basisKey: 'pattern.profile.feature.nddDzp.basis',
      numerator: { terms: [{ analyte: NORDAZEPAM, matrix: 'blood' }] },
      denominator: { terms: [{ analyte: DIAZEPAM, matrix: 'blood' }] },
      sortOrder: 10,
      provisionalBand: { p5: 0.4, p50: 1.2, p95: 4.0, provenance: null, basis: 'raw' },
      referenceCitations: [WANG_2020, JONES_2012],
    },
    {
      id: 'oxa_ndd',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'parent_metabolite_ratio',
      labelKey: 'pattern.profile.feature.oxaNdd.label',
      basisKey: 'pattern.profile.feature.oxaNdd.basis',
      numerator: { terms: [{ analyte: OXAZEPAM, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: NORDAZEPAM, matrix: 'urine' }] },
      sortOrder: 20,
      provisionalBand: { p5: 0.5, p50: 1.8, p95: 6.0, provenance: null, basis: 'raw' },
      referenceCitations: [LUK_2014],
    },
    {
      id: 'tem_oxa',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'branch_ratio',
      labelKey: 'pattern.profile.feature.temOxa.label',
      // §3.3 change 2: states what the quantity is — the share of flux through
      // the 3-hydroxy branch against the convergent end-product — and does not
      // attribute the balance to named CYP steps. The standing caveat that a
      // position in a distribution cannot separate interaction, genotype and
      // timing is attached by the wording layer, not repeated per feature.
      basisKey: 'pattern.profile.feature.temOxa.basis',
      numerator: { terms: [{ analyte: TEMAZEPAM, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: OXAZEPAM, matrix: 'urine' }] },
      sortOrder: 30,
      provisionalBand: { p5: 0.05, p50: 0.2, p95: 0.8, provenance: null, basis: 'raw' },
      referenceCitations: [LUK_2014],
    },
    {
      id: 'ndd_dwn',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'lineage_burden',
      labelKey: 'pattern.profile.feature.nddDwn.label',
      basisKey: 'pattern.profile.feature.nddDwn.basis',
      numerator: { terms: [{ analyte: NORDAZEPAM, matrix: 'urine' }] },
      // A lineage burden expressed as a sum, which is why the operand type takes
      // several terms rather than one analyte.
      denominator: {
        terms: [
          { analyte: OXAZEPAM, matrix: 'urine' },
          { analyte: TEMAZEPAM, matrix: 'urine' },
        ],
      },
      sortOrder: 40,
      provisionalBand: { p5: 0.1, p50: 0.45, p95: 1.5, provenance: null, basis: 'raw' },
      // §3.3 change 3: the accumulation evidence is recorded as the documented
      // reason the single-vs-repeated signal stays not-calculable — nordazepam
      // t½ >120 h, steady state ~3 weeks — not as support for a claim.
      referenceCitations: [LUK_2014, WANG_2020],
    },
    {
      id: 'ndd_u_b',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'matrix_same_analyte',
      labelKey: 'pattern.profile.feature.nddUB.label',
      basisKey: 'pattern.profile.feature.nddUB.basis',
      numerator: { terms: [{ analyte: NORDAZEPAM, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: NORDAZEPAM, matrix: 'blood' }] },
      sortOrder: 50,
      // `unstated`, and deliberately not `raw`: nobody has established whether
      // these percentiles describe raw or creatinine-standardised urine:blood
      // ratios, and writing `raw` to make the band render would be asserting the
      // answer. Where a case normalises, the model withholds the band rather
      // than plotting a value against a distribution it may not belong to.
      provisionalBand: { p5: 0.8, p50: 3.5, p95: 15.0, provenance: null, basis: 'unstated' },
      referenceCitations: [LUK_2014],
    },
    {
      id: 'oxa_u_ndd_b',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'matrix_matched_lineage',
      labelKey: 'pattern.profile.feature.oxaUNddB.label',
      basisKey: 'pattern.profile.feature.oxaUNddB.basis',
      numerator: { terms: [{ analyte: OXAZEPAM, matrix: 'urine' }] },
      denominator: { terms: [{ analyte: NORDAZEPAM, matrix: 'blood' }] },
      sortOrder: 60,
      provisionalBand: { p5: 1.0, p50: 6.0, p95: 30.0, provenance: null, basis: 'unstated' },
      referenceCitations: [LUK_2014],
    },
    {
      // A ratio a reader expects to see, whose absence must be stated rather
      // than inferred. It renders as a group footnote, never as a row.
      id: 'sum_u_b',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      kind: 'matrix_matched_lineage',
      labelKey: 'pattern.profile.feature.sumUB.label',
      numerator: {
        terms: [
          { analyte: NORDAZEPAM, matrix: 'urine' },
          { analyte: OXAZEPAM, matrix: 'urine' },
          { analyte: TEMAZEPAM, matrix: 'urine' },
        ],
      },
      denominator: {
        terms: [
          { analyte: DIAZEPAM, matrix: 'blood' },
          { analyte: NORDAZEPAM, matrix: 'blood' },
        ],
      },
      sortOrder: 70,
      status: 'withdrawn',
      withdrawnRationaleKey: 'pattern.profile.feature.sumUB.withdrawn',
    },
  ],

  // `history` is the one module-scoped context field. Prescription history that
  // bears on *source* is not here — it is multi-valued and lives in the case's
  // exposure set (§7.3), because a single-valued field could record only one
  // answer and would read as resolving an ambiguity it cannot resolve.
  contextFields: [
    {
      id: 'history',
      labelKey: 'pattern.profile.context.history.label',
      shortKey: 'pattern.profile.context.history.short',
      applicability: { type: 'module', moduleId: 'benzodiazepines' },
      sortOrder: 50,
      options: [
        { value: 'single_dose', labelKey: 'pattern.profile.context.history.singleDose', state: 'known' },
        { value: 'repeated', labelKey: 'pattern.profile.context.history.repeated', state: 'known' },
        { value: 'chronic', labelKey: 'pattern.profile.context.history.chronic', state: 'known' },
        {
          value: 'not_stated',
          labelKey: 'pattern.profile.context.notStated',
          state: 'missing',
          isDefault: true,
        },
      ],
    },
  ],

  signals: [
    {
      id: 'time_since_intake',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      titleKey: 'pattern.profile.signal.timeSinceIntake.title',
      grade: 'suggestive',
      propositionHpKey: 'pattern.profile.signal.timeSinceIntake.hp',
      propositionHdKey: 'pattern.profile.signal.timeSinceIntake.hd',
      basisKey: 'pattern.profile.signal.timeSinceIntake.basis',
      basis: { type: 'feature', featureId: 'ndd_dzp' },
      dependsOn: ['interval', 'bmatrix'],
      dependsOnSourceResolution: true,
      // No published cut-off maps this ratio onto the ENFSI scale, so it states
      // no strength. The citations document the quantity, not a strength.
      strength: {
        type: 'not_calculable',
        reasonKey: 'pattern.profile.strength.noValidatedMapping',
      },
      referenceCitations: [WANG_2020, JONES_2012],
    },
    {
      id: 'single_vs_repeated',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      titleKey: 'pattern.profile.signal.singleVsRepeated.title',
      grade: 'exploratory',
      propositionHpKey: 'pattern.profile.signal.singleVsRepeated.hp',
      propositionHdKey: 'pattern.profile.signal.singleVsRepeated.hd',
      basisKey: 'pattern.profile.signal.singleVsRepeated.basis',
      basis: { type: 'feature', featureId: 'ndd_dwn' },
      dependsOn: ['history', 'interval'],
      dependsOnSourceResolution: true,
      // §3.3 change 3: the accumulation evidence is the documented reason this
      // stays not-calculable — nordazepam's >120 h half-life means steady state
      // takes ~3 weeks, so the distributions overlap heavily.
      strength: {
        type: 'not_calculable',
        reasonKey: 'pattern.profile.strength.overlappingDistributions',
      },
      referenceCitations: [LUK_2014, WANG_2020],
    },
    {
      id: 'sample_dilution',
      version: '1.0.0',
      moduleId: 'benzodiazepines',
      titleKey: 'pattern.profile.signal.sampleDilution.title',
      // No longer 'validated': the quantity is a recognised dilution indicator,
      // but the mapping onto verbal strength that the grade implied does not
      // exist in any registered source.
      grade: 'suggestive',
      propositionHpKey: 'pattern.profile.signal.sampleDilution.hp',
      propositionHdKey: 'pattern.profile.signal.sampleDilution.hd',
      basisKey: 'pattern.profile.signal.sampleDilution.basis',
      basis: { type: 'specimen_metric', metric: 'urine_creatinine' },
      dependsOn: ['umatrix'],
      // This carried the module's only ENFSI strength expression, on cut-offs
      // attributed to Cone et al. 2009. Verifying the handle against the source
      // record showed two things. The identifier was wrong — PMID 20529458 is
      // Fu et al. 2010 on enzymatic-hydrolysis artefacts, now cited where it
      // belongs — and the paper actually meant (PMID 19161663) evaluates
      // creatinine and specific-gravity *normalisation*; it publishes no mapping
      // from a creatinine concentration onto the ENFSI scale.
      //
      // So the cut-offs had no published support, and the rule that would have
      // computed from them is withdrawn rather than re-pointed at a citation
      // that does not say it. Creatinine still renders as a dilution indicator
      // and Cone 2009 still documents the normalisation; what is gone is the
      // verbal strength nobody had established.
      strength: {
        type: 'not_calculable',
        reasonKey: 'pattern.profile.strength.noPublishedCutoffs',
      },
      referenceCitations: [CONE_2009],
    },
  ],

  // §3.3 change 4: demoted from a signal. It makes no claim, so it does not
  // occupy a claim-shaped row; the bounded-negative wording is kept verbatim.
  notEstablished: [
    {
      id: 'prescription_adherence',
      moduleId: 'benzodiazepines',
      titleKey: 'pattern.profile.notEstablished.adherence.title',
      rationaleKey: 'pattern.profile.notEstablished.adherence.rationale',
      referenceCitations: [],
    },
  ],

  // Layer A supplies these directions: CYP3A4 inhibition raised urinary
  // temazepam and oxazepam fractions; CYP2C19 inhibition raised the nordazepam
  // fraction (Luk et al. 2014). Keyed by enzyme and role, so one entry covers
  // every inhibitor of that enzyme.
  enzymeEffects: [
    {
      enzymeSlug: 'cyp3a4',
      role: 'inhibitor',
      featureId: 'tem_oxa',
      direction: 'increases',
      referenceCitations: [LUK_2014],
    },
    {
      enzymeSlug: 'cyp2c19',
      role: 'inhibitor',
      featureId: 'oxa_ndd',
      direction: 'decreases',
      referenceCitations: [LUK_2014],
    },
    {
      enzymeSlug: 'cyp2c19',
      role: 'inhibitor',
      featureId: 'ndd_dwn',
      direction: 'increases',
      referenceCitations: [LUK_2014],
    },
  ],

  // Layer A's A4 artefact: β-glucuronidase can reductively convert oxazepam to
  // nordazepam. Scoped to urine, because a urine hydrolysis cannot alter a blood
  // operand and an unscoped rule would warn on rows it does not affect — which
  // erodes the warning everywhere it is real.
  //
  // It fires on `not_stated` as well as `snail`: the protocol being unrecorded
  // does not make the conversion less possible, and §3.3's first content change
  // exists precisely so that absence stops reading as "none".
  artefactRules: [
    {
      id: 'glucuronidase_oxa_to_ndd',
      when: { fieldId: 'hydro', valueIn: ['snail', 'not_stated'] },
      converts: { from: OXAZEPAM, to: NORDAZEPAM },
      appliesTo: { scope: 'matrix', matrices: ['urine'] },
      noteKey: 'pattern.profile.artefact.glucuronidaseOxaNdd',
      referenceCitations: [FU_2010],
    },
  ],

  // Pinned to match the approved design. A module that pins nothing gets an
  // axis computed from its own values (§8.3).
  axisPin: { lo: 0.03, hi: 100 },
};
