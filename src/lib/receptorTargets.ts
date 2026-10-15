import type { NumericRange } from '../types/index.js';

/**
 * Rank of a mechanism in the drug's overall pharmacodynamic profile. Drives
 * the primary/secondary/tertiary grouping in the monograph pharmacodynamics
 * box. `null` means unranked.
 */
export const MECHANISM_TIERS = ['primary', 'secondary', 'tertiary'] as const;
export type MechanismTier = (typeof MECHANISM_TIERS)[number];

export function isMechanismTier(value: unknown): value is MechanismTier {
  return (
    typeof value === 'string' &&
    (MECHANISM_TIERS as readonly string[]).includes(value)
  );
}

export interface ReceptorTargetSummary {
  id: number;
  slug: string;
  symbol: string;
  name: string;
  nameEn: string | null;
  targetClass: string | null;
  organism: string;
}

export interface DrugReceptorTargetSummary {
  id: number;
  drugId: number;
  receptorTargetId: number;
  interactionType: string;
  /** Mechanism rank — 'primary' | 'secondary' | 'tertiary' — or null if unranked. */
  tier: MechanismTier | null;
  affinity: NumericRange | null;
  potency: NumericRange | null;
  efficacy: NumericRange | null;
  ki: NumericRange | null;
  ic50: NumericRange | null;
  ec50: NumericRange | null;
  emax: NumericRange | null;
  selectivityRatio: NumericRange | null;
  /**
   * Species of the preparation the measurements on this row were made in
   * (#1017) — "Homo sapiens", "Rattus norvegicus", "recombinant human
   * (HEK293)", … The catalog target stays human-canonical, so this is what
   * tells a reader whether a Ki transfers directly or is animal evidence.
   * `null` means unstated, NOT human.
   */
  assaySpecies: string | null;
  referenceIds: number[];
  evidenceNote: string | null;
  target: ReceptorTargetSummary;
}

/**
 * One `drug_receptor_targets` relationship read from the target's side — the
 * inverse of {@link DrugReceptorTargetSummary}. Backs the target-pharmacology
 * collection on a bio entity's monograph (`GET /api/bio-entities?targetLigands=`).
 *
 * A summary relationship, not an assay result: the measurement ranges are
 * returned exactly as stored, and `assaySpecies = null` still means unstated.
 * Drug identity is the minimal shape needed for display and navigation — never
 * a full drug row.
 */
export interface EntityTargetLigand {
  /** `drug_receptor_targets.id`. A drug may act on one target in several ways. */
  relationshipId: number;
  drugId: number;
  drugSlug: string;
  drugNames: Record<string, string>;
  /** Slug of the drug's published monograph, or null when it has none yet. */
  drugMonographSlug: string | null;

  interactionType: string;
  tier: MechanismTier | null;

  affinity: NumericRange | null;
  potency: NumericRange | null;
  efficacy: NumericRange | null;
  ki: NumericRange | null;
  ic50: NumericRange | null;
  ec50: NumericRange | null;
  emax: NumericRange | null;
  selectivityRatio: NumericRange | null;

  /** `null` means unstated, NOT human. */
  assaySpecies: string | null;
  referenceIds: number[];
  evidenceNote: string | null;
}
