/**
 * In-memory fixture cases.
 *
 * Phase 0 has no persistence: the view renders from one of these, and Phase 1
 * replaces the source without changing the shape (§10). They are production code
 * rather than test scaffolding for exactly that reason, and the acceptance tests
 * read the same objects the screen does — a fixture that drifted from the one
 * under test would prove nothing.
 */

import type { PatternCaseData } from '../../types/patternCase.js';
import { PATTERN_CASE_KIND } from '../../types/patternCase.js';
import type { MetabolismGraph } from './sourceAmbiguity.js';

const DIAZEPAM = { pubchemCid: 3016, slug: 'diazepam' };
const NORDAZEPAM = { pubchemCid: 2997, slug: 'n-desmetyldiazepam' };
const TEMAZEPAM = { pubchemCid: 5391, slug: 'temazepam' };
const OXAZEPAM = { pubchemCid: 4616, slug: 'oxazepam' };

/**
 * The label the synthetic worked example carries.
 *
 * Exported because the screen has to say which case it is showing: a reader who
 * opens the route sees realistic-looking figures, and unlabelled realistic
 * figures in a forensic tool are figures that can be mistaken for somebody's
 * case (§9.2). The label says outright that it is not one. Phase 1 replaces this
 * with the stored case's own identifier.
 */
export const DIAZEPAM_FIXTURE_CASE_NUMBER = 'SYNTHETIC-DIAZEPAM-001';

/**
 * A synthetic diazepam worked example, labelled `SYNTHETIC-DIAZEPAM-001`.
 *
 * Not a real case. Every concentration is invented, chosen only to exercise the
 * ratio arithmetic: the within-matrix ratios come out at the design handoff's
 * illustrative figures (1,45 · 1,79 · 0,212 · 0,461) and the creatinine-
 * normalised cross-matrix ratios at 3,28 and 5,87. No specimen, person or
 * laboratory result stands behind these numbers.
 *
 * Concentrations are stated in nmol/L — the molar basis Norwegian toxicology
 * reports use — so the fixture exercises unit resolution without depending on a
 * molecular weight for its headline numbers.
 *
 * Urine creatinine is 13.26 mmol/L against spec §11.3's 8.84 reference, making
 * `k` exactly 2/3. That is deliberate: a fixture whose creatinine equalled the
 * reference would give `k = 1` and pass whether or not the engine applied it,
 * which is the one thing these numbers exist to prove.
 */
export const DIAZEPAM_FIXTURE_CASE: PatternCaseData = {
  kind: PATTERN_CASE_KIND,
  schemaVersion: 1,
  moduleIds: ['benzodiazepines'],
  normalization: { creatinineReferenceMmolL: 8.84 },
  // Stated in the case, so filing it or editing it cannot quietly turn a worked
  // example into casework. See `PatternCaseData.origin`.
  origin: 'example',

  specimens: [
    {
      id: 'blood-1',
      matrix: 'whole_blood',
      relativeTimeHours: 0,
    },
    {
      id: 'urine-1',
      matrix: 'urine',
      relativeTimeHours: 0,
      urine: { creatinineMmolL: 13.26 },
    },
  ],

  observations: [
    {
      id: 'obs-dzp-b',
      specimenId: 'blood-1',
      analyte: DIAZEPAM,
      value: 315.39,
      unit: 'nmol/L',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'obs-ndd-b',
      specimenId: 'blood-1',
      analyte: NORDAZEPAM,
      value: 457.317,
      unit: 'nmol/L',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'obs-ndd-u',
      specimenId: 'urine-1',
      analyte: NORDAZEPAM,
      value: 2250,
      unit: 'nmol/L',
      qualifier: 'quantified',
      assay: { measurandMode: 'total_after_hydrolysis' },
    },
    {
      id: 'obs-oxa-u',
      specimenId: 'urine-1',
      analyte: OXAZEPAM,
      value: 4027.5,
      unit: 'nmol/L',
      qualifier: 'quantified',
      assay: { measurandMode: 'total_after_hydrolysis' },
    },
    {
      id: 'obs-tem-u',
      specimenId: 'urine-1',
      analyte: TEMAZEPAM,
      value: 853.83,
      unit: 'nmol/L',
      qualifier: 'quantified',
      assay: { measurandMode: 'total_after_hydrolysis' },
    },
  ],

  context: {
    postmortem: false,
    timeOrigin: 'first_specimen_collection',
    // No declared exposures: the source ambiguity reads `unresolved` and every
    // signal depending on it degrades. That is the fixture's default state, not
    // an omission — §7.3.1 is explicit that no case in this release reaches a
    // state that lifts the degradation except `not_applicable`.
    knownExposures: [],
    fields: {},
  },
};

/**
 * The benzodiazepine metabolism neighbourhood, as Phase 1's graph endpoint will
 * return it.
 *
 * Every one of these metabolites is also a marketed product in its own right —
 * which is the whole of Layer A's A4 finding, and why this graph produces
 * candidates where the cocaine one produces none.
 */
export const BENZODIAZEPINE_GRAPH: MetabolismGraph = {
  nodes: [
    { drug: DIAZEPAM, substanceClass: 'drug' },
    { drug: NORDAZEPAM, substanceClass: 'drug' },
    { drug: TEMAZEPAM, substanceClass: 'drug' },
    { drug: OXAZEPAM, substanceClass: 'drug' },
  ],
  edges: [
    { from: DIAZEPAM, to: NORDAZEPAM },
    { from: DIAZEPAM, to: TEMAZEPAM },
    { from: NORDAZEPAM, to: OXAZEPAM },
    { from: TEMAZEPAM, to: OXAZEPAM },
  ],
};
