/**
 * Which shipped catalog entries are analytes rather than administered drugs,
 * keyed by PubChem CID.
 *
 * This is the seed for `drugs.substance_class`, which drives the class-wide
 * applicability rule in `src/lib/parameterApplicability.ts`: bioavailability
 * and the dose ranges need a dose OF THIS SUBSTANCE, so they are undefined
 * for anything in here, and the maintenance agent's gap queue stops
 * asking for them. Without it those pairs are permanently unfillable work
 * items that the queue re-serves every hourly cycle.
 *
 * It lives beside the catalog rather than inside `data/components.ts` because
 * it is not part of the fixture the catalog-drift job compares field by field;
 * `scripts/seed-drugs.ts` applies it when a substance is first inserted.
 * For databases that already hold the catalog, `scripts/backfill-substance-
 * classes.ts` applies it after a deploy. Deliberately not migration 0097: a
 * migration runs while the previous, unguarded build is still taking writes,
 * and it runs once — wrong for a list of judgements that has already had four
 * entries withdrawn.
 *
 * ## The bar, and why every entry states its case
 *
 * **The bar is "nobody administers it in any form", not "it is a metabolite"
 * and not "the body makes it".** Morphine is a metabolite of codeine, oxazepam
 * and temazepam of diazepam, cathine of khat, and all of them are marketed
 * products whose dose and absorption parameters are perfectly well defined.
 * Anything taken recreationally in its own right (MDA, O-desmethyltramadol) is
 * still administered. So is anything given to humans in a clinical trial with
 * published dose-ranging PK — an investigational drug that was never marketed
 * still has a tmax somebody measured.
 *
 * The two directions are not symmetrical. A missing entry costs one agent
 * cycle on a gap that turns out to be real. A wrong entry makes correct data
 * *unwritable* and hides those gaps permanently, with nothing in the queue
 * output saying why. **When in doubt, leave it off.**
 *
 * Two heuristics, learned from getting this wrong four times:
 *
 * 1. **A pharmacologically active metabolite is a candidate for
 *    administration; an inactive one is not.** Every wrong entry so far was
 *    active. Conjugates, hydrolysis products and dealkylation products are
 *    safe because nothing would be gained by dosing them.
 * 2. **A metabolite of a designer drug is itself a plausible designer
 *    product.** The research-chemical market sells active benzodiazepine
 *    metabolites in their own right — 3-hydroxyphenazepam is the case that
 *    taught this — so an analyte whose parent is an NPS needs positive
 *    evidence that nobody sells it, not merely that it is a metabolite. A
 *    metabolite of a licensed medicine does not carry the same risk.
 *
 * Neither is a licence to classify: they narrow where to look hardest. The
 * asymmetry is also why each entry carries a `neverAdministered` sentence
 * rather than just the parent drug's name. Four wrong entries got in here
 * behind one-word comments — beta-hydroxybutyrate (ketone esters are dosed),
 * hydroxybupropion (its (+)-enantiomer was trialled as radafaxine), cotinine
 * (administered in controlled human studies) and 3-hydroxyphenazepam (sold as
 * a designer benzodiazepine) — because naming the parent substance answers
 * "is it a metabolite", which is not the question. Writing the sentence forces
 * the actual claim into view, where it can be checked or contradicted.
 *
 * It is not sufficient, either: the sentence for 3-hydroxyphenazepam read "an
 * analytical target only", which is an assertion, not evidence. What the field
 * buys is that a wrong entry now states something a reviewer can disagree with.
 */
import type { SubstanceClass } from '../src/lib/parameterApplicability.js';

export interface AnalyteClassification {
  readonly substanceClass: SubstanceClass;
  /**
   * Why no one administers this substance. Not "what is it a metabolite of" —
   * that question does not decide the classification. This is the claim a
   * reviewer has to be able to falsify.
   */
  readonly neverAdministered: string;
}

/** CID → classification. See the docblock for the bar an entry must clear. */
export const SUBSTANCE_CLASS_BY_PUBCHEM_CID: Readonly<
  Record<number, AnalyteClassification>
> = {
  // ── Formed in vivo, analyte only ──────────────────────────────────────────
  5462507: {
    substanceClass: 'metabolite',
    neverAdministered:
      '6-Monoacetylmorphine: heroin’s intermediate hydrolysis product, too short-lived to be a product; measured only to prove heroin use.',
  },
  448223: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Benzoylecgonine: cocaine’s inactive hydrolysis product, no pharmacological effect and no reason to give it.',
  },
  101264121: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Psilocin glucuronide: a conjugate formed for excretion; glucuronides are not dosed.',
  },
  92294: {
    substanceClass: 'metabolite',
    neverAdministered:
      '7-Aminoflunitrazepam: the inactive nitroreduction product of flunitrazepam, a screening marker only.',
  },
  188298: {
    substanceClass: 'metabolite',
    neverAdministered:
      '7-Aminoclonazepam: the inactive nitroreduction product of clonazepam, a screening marker only.',
  },
  78641: {
    substanceClass: 'metabolite',
    neverAdministered:
      '7-Aminonitrazepam: the inactive nitroreduction product of nitrazepam, a screening marker only.',
  },
  86863: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Ritalinic acid: methylphenidate’s inactive de-esterification product; no activity, no product.',
  },
  5352621: {
    substanceClass: 'metabolite',
    neverAdministered:
      'EDDP: methadone’s inactive cyclisation product, measured to confirm methadone compliance.',
  },
  92131860: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Buprenorphine glucuronide: a conjugate formed for excretion; glucuronides are not dosed.',
  },
  91800110: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Norbuprenorphine glucuronide: a conjugate formed for excretion; glucuronides are not dosed.',
  },
  259381: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Norfentanyl: fentanyl’s inactive N-dealkylation product, a urine marker only.',
  },
  162835: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Dehydronorketamine: a downstream ketamine metabolite with no product of its own.',
  },
  32414: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Norpethidine: pethidine’s neurotoxic metabolite; the reason it is measured is to avoid accumulating it.',
  },
  131560: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Remifentanil acid: the inactive esterase product of remifentanil, formed in blood within minutes.',
  },
  162244: {
    substanceClass: 'metabolite',
    neverAdministered:
      'alpha-Hydroxyalprazolam: an alprazolam hydroxylation product, an analytical target only.',
  },
  162548: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Zopiclone N-oxide: a zopiclone oxidation product, an analytical target only.',
  },
  11966044: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Zolpidem phenyl-4-carboxylic acid: zolpidem’s inactive carboxylated metabolite, the main urinary marker.',
  },
  107917: {
    substanceClass: 'metabolite',
    neverAdministered:
      'alpha-Hydroxymidazolam: midazolam’s hydroxylation product, used as a CYP3A activity probe but not given as a dose.',
  },
  26333: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Ethyl glucuronide: a minor conjugate of ethanol used as an abstinence marker; not dosed.',
  },
  24561: {
    substanceClass: 'metabolite',
    neverAdministered:
      'Ethyl sulfate: a minor conjugate of ethanol used as an abstinence marker; not dosed.',
  },

  // ── Produced by normal physiology, measured as a marker ───────────────────
  // Deliberately empty. `endogenous` is a class an editor can assign, but no
  // shipped substance earns it: GHB is sodium oxybate, beta-hydroxybutyrate is
  // sold as ketone salts and esters with published human tmax. "The body makes
  // it" is not the bar.
};

/** The class to seed for a CID, or undefined to leave the column default. */
export function seededSubstanceClass(
  pubchemCid: number | undefined,
): SubstanceClass | undefined {
  if (pubchemCid === undefined) return undefined;
  return SUBSTANCE_CLASS_BY_PUBCHEM_CID[pubchemCid]?.substanceClass;
}
