import type { MetabolismEnzyme } from './metabolism';

/**
 * Drug↔enzyme interaction (#785 Phase 6 follow-up). The DDI-perpetrator
 * relationship: a drug that is a substrate of, or induces/inhibits, a metabolic
 * enzyme. Distinct from `drug_elimination_routes` (which models the drug as a
 * substrate with a dose fraction) — this captures the inducer/inhibitor roles
 * a drug plays on enzymes that clear *other* drugs.
 */
export type EnzymeInteractionRole = 'substrate' | 'inducer' | 'inhibitor';

export const ENZYME_INTERACTION_ROLES: readonly EnzymeInteractionRole[] = [
  'substrate',
  'inducer',
  'inhibitor',
];

export type EnzymeInteractionStrength = 'weak' | 'moderate' | 'strong';

export const ENZYME_INTERACTION_STRENGTHS: readonly EnzymeInteractionStrength[] =
  ['weak', 'moderate', 'strong'];

/** A hydrated interaction row, with its canonical enzyme entity. */
export interface DrugEnzymeInteractionSummary {
  id: number;
  drugId: number;
  bioEntityId: number;
  role: EnzymeInteractionRole;
  strength: EnzymeInteractionStrength | null;
  note: string | null;
  referenceIds: number[];
  /** The enzyme, in the legacy MetabolismEnzyme shape for display reuse. */
  enzyme: MetabolismEnzyme;
}

export function isEnzymeInteractionRole(
  value: unknown,
): value is EnzymeInteractionRole {
  return (
    typeof value === 'string' &&
    (ENZYME_INTERACTION_ROLES as readonly string[]).includes(value)
  );
}

export function isEnzymeInteractionStrength(
  value: unknown,
): value is EnzymeInteractionStrength {
  return (
    typeof value === 'string' &&
    (ENZYME_INTERACTION_STRENGTHS as readonly string[]).includes(value)
  );
}
