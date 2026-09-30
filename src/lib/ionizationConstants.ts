/**
 * Structured ionization constants (#structured-ionization-constants).
 *
 * A single scalar `pKa` cannot represent a molecule with more than one
 * ionizable group, and it silently loses the *direction* of each equilibrium —
 * whether a value is the pKa of a basic centre (BH⁺ ⇌ B) or an acidic one
 * (HA ⇌ A⁻). This module models each dissociation as its own record carrying
 * the net-charge transition it represents, so a monoprotic base, a monoprotic
 * acid, an amphoteric compound and a diprotic base are all expressible without
 * pooling distinct physicochemical constants into one number.
 *
 * Everything here is pure and dependency-light (zod only) so it can be shared
 * between the frontend, the API serializer, the deep-research importer and the
 * iPMR derivation, and unit-tested without a database.
 */
import { z } from 'zod';

/**
 * Provenance of a pKa value. Experimental measurements must be distinguishable
 * from software predictions — a predicted value is admissible evidence but a
 * weaker one, and the two must never be silently merged.
 */
export type IonizationEvidenceType = 'experimental' | 'predicted';

export const IONIZATION_EVIDENCE_TYPES: readonly IonizationEvidenceType[] = [
  'experimental',
  'predicted',
];

/**
 * Whether the constant is a macroscopic (observable, site-agnostic) pKa or a
 * microscopic one tied to a specific ionizable atom. Macroscopic is the default
 * and by far the more commonly available quantity; microscopic is recorded only
 * where a source specifically establishes the site.
 */
export type IonizationConstantType = 'macroscopic' | 'microscopic';

export const IONIZATION_CONSTANT_TYPES: readonly IonizationConstantType[] = [
  'macroscopic',
  'microscopic',
];

/**
 * One acid-dissociation equilibrium of a molecule.
 *
 * The primary representation is the net-charge transition, not the identity of
 * the ionizable atom: a single deprotonation removes one proton, so the
 * protonated species always carries exactly one more unit of positive charge
 * than the deprotonated one (`protonatedCharge === deprotonatedCharge + 1`).
 * That charge pair is what makes a value unambiguous — the same numeric pKa of
 * 9.2 means "basic centre" as `+1 → 0` and "acidic centre" as `0 → -1`.
 */
export interface IonizationConstant {
  /** The pKa of this equilibrium. */
  pKa: number;
  /** Net molecular charge of the protonated (proton-bearing) species. */
  protonatedCharge: number;
  /** Net molecular charge after losing the proton. Always protonatedCharge − 1. */
  deprotonatedCharge: number;
  /** Macroscopic unless a source established a specific microscopic site. */
  type?: IonizationConstantType;
  evidenceType: IonizationEvidenceType;
  /** Optional human description of the ionizable group/site. */
  siteLabel?: string;
  temperatureC?: number;
  medium?: string;
  /** Citation ids backing this constant (Kinetix `citations.id`). */
  referenceIds?: number[];
  note?: string;
}

/**
 * Loose input shape a deep-research / import document may declare for one
 * ionization constant. Every field is optional-and-nullable at the envelope
 * level; {@link normalizeIonizationConstant} enforces the real rules and
 * reports what it dropped, matching how the rest of the importer is permissive
 * about structure and strict about values.
 */
export const ionizationConstantInputSchema = z
  .object({
    pKa: z.number().optional().nullable(),
    protonatedCharge: z.number().optional().nullable(),
    deprotonatedCharge: z.number().optional().nullable(),
    type: z.string().optional().nullable(),
    evidenceType: z.string().optional().nullable(),
    siteLabel: z.string().optional().nullable(),
    temperatureC: z.number().optional().nullable(),
    medium: z.string().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
    note: z.string().optional().nullable(),
  })
  .passthrough();

export type IonizationConstantInput = z.infer<typeof ionizationConstantInputSchema>;

/** pKa values below this / above it are not physically meaningful for aqueous ionization. */
export const PKA_MIN = -10;
export const PKA_MAX = 20;
/** A net molecular charge outside this band is almost certainly a data error. */
export const CHARGE_ABS_MAX = 8;

/**
 * The transition a given constant represents, as a stable string key. Two
 * constants share a transition iff this key matches; it is what
 * "different transitions are never aggregated together" is enforced on.
 */
export function transitionKey(c: {
  protonatedCharge: number;
  deprotonatedCharge: number;
}): string {
  return `${c.protonatedCharge}->${c.deprotonatedCharge}`;
}

/**
 * The basic-centre pKa a molecule presents to iPMR: the pKa of the
 * `+1 → 0` equilibrium (BH⁺ ⇌ B + H⁺), or `null` when the profile has no such
 * transition (an acid or a neutral-only compound has no basic centre).
 *
 * When more than one constant describes the `+1 → 0` transition — e.g. an
 * experimental and a predicted value, or two experimental media —
 * experimental values are preferred and the representative is their median.
 * This aggregates *within* a transition only; constants for other transitions
 * are never mixed in.
 */
export function deriveBasicPKa(
  constants: readonly IonizationConstant[] | null | undefined,
): number | null {
  if (!constants || constants.length === 0) return null;
  const matches = constants.filter(
    (c) => c.protonatedCharge === 1 && c.deprotonatedCharge === 0,
  );
  if (matches.length === 0) return null;
  return macroscopicRepresentativePKa(matches);
}

/**
 * The single representative MACROSCOPIC pKa for one transition, or `null` when
 * the transition has only microscopic constants.
 *
 * These population derivations (neutral fraction, logD, iPMR's basicity term)
 * are about the macroscopic equilibrium governing the total populations of two
 * adjacent charge states. A microscopic constant describes one microstate and
 * is not the same quantity, so mixing the two — or averaging microscopic
 * microstates into a "macroscopic" value — would move the result away from the
 * established macroscopic pKa. Macroscopic constants are therefore used
 * exclusively; a transition with no macroscopic value contributes none (rather
 * than being approximated from microscopic data, which would need the full
 * microstate network to do correctly). Within the macroscopic pool, experimental
 * values are preferred over predicted and the median is taken, so the result is
 * order-independent (the database read has no ordering among equal-charge rows).
 */
function macroscopicRepresentativePKa(
  group: readonly IonizationConstant[],
): number | null {
  // `type` is optional and defaults to macroscopic.
  const macroscopic = group.filter((c) => c.type !== 'microscopic');
  if (macroscopic.length === 0) return null;
  const experimental = macroscopic.filter(
    (c) => c.evidenceType === 'experimental',
  );
  const pool = experimental.length > 0 ? experimental : macroscopic;
  return median(pool.map((c) => c.pKa));
}

function median(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[mid - 1]! + finite[mid]!) / 2
    : finite[mid]!;
}

/**
 * Fraction of the molecule in its neutral (net-charge-zero) form at a given pH,
 * derived from the ionization profile.
 *
 * Each constant relates two adjacent charge states through
 * `[deprotonated] / [protonated] = 10^(pH − pKa)`. Walking those relations out
 * from the neutral state gives every state's relative population; the neutral
 * fraction is the normalized population of charge 0. Returns `null` when the
 * profile is empty, malformed (a transition whose charges are not adjacent), or
 * disconnected from the neutral state, since no fraction can be established
 * then. Computed in log space so a polyprotic profile cannot overflow.
 */
export function neutralFractionAtPh(
  constants: readonly IonizationConstant[] | null | undefined,
  pH: number,
): number | null {
  if (!constants || constants.length === 0) return null;

  // Group all measurements of one transition and reduce each to a single
  // representative pKa deterministically, so the ladder is single-valued and
  // order-independent (see transitionRepresentativePKa).
  const groups = new Map<number, IonizationConstant[]>();
  for (const c of constants) {
    if (c.protonatedCharge !== c.deprotonatedCharge + 1) return null;
    const list = groups.get(c.protonatedCharge);
    if (list) list.push(c);
    else groups.set(c.protonatedCharge, [c]);
  }
  const byHigh = new Map<number, number>(); // high charge → representative pKa
  for (const [high, group] of groups) {
    const rep = macroscopicRepresentativePKa(group);
    // A transition with only microscopic data has no macroscopic pKa to place
    // on the ladder; without it the neutral fraction cannot be established.
    if (rep == null) return null;
    byHigh.set(high, rep);
  }

  // BFS out from the neutral state along adjacent transitions. For a transition
  // high ⇌ low with pKa: log10(P_low) − log10(P_high) = pH − pKa.
  // log10(relative population), anchored at the neutral state = 0.
  const logPop = new Map<number, number>([[0, 0]]);
  const queue = [0];
  const seen = new Set<number>([0]);
  while (queue.length) {
    const charge = queue.shift()!;
    const base = logPop.get(charge)!;
    // Transition where this charge is the protonated (high) side: charge ⇌ charge−1.
    const asHigh = byHigh.get(charge);
    if (asHigh != null && !seen.has(charge - 1)) {
      logPop.set(charge - 1, base + (pH - asHigh));
      seen.add(charge - 1);
      queue.push(charge - 1);
    }
    // Transition where this charge is the deprotonated (low) side: charge+1 ⇌ charge.
    const asLow = byHigh.get(charge + 1);
    if (asLow != null && !seen.has(charge + 1)) {
      logPop.set(charge + 1, base - (pH - asLow));
      seen.add(charge + 1);
      queue.push(charge + 1);
    }
  }

  // Every supplied transition must be reachable from the neutral state — a
  // profile disconnected from charge 0 (e.g. only +2 → +1) cannot establish a
  // neutral fraction, and returning 1 there would report logP unchanged as a
  // derived logD. Reject rather than silently ignore the disconnected part.
  for (const high of byHigh.keys()) {
    if (!seen.has(high) || !seen.has(high - 1)) return null;
  }

  // Normalize in log space: f_neutral = 10^(logPop[0] − logSumExp10(all)).
  const logs = [...logPop.values()];
  const maxLog = Math.max(...logs);
  const sum = logs.reduce((acc, l) => acc + Math.pow(10, l - maxLog), 0);
  const logSum = maxLog + Math.log10(sum);
  const fraction = Math.pow(10, (logPop.get(0) ?? -Infinity) - logSum);
  return Number.isFinite(fraction) ? fraction : null;
}

export interface DerivedLogD {
  /** The estimated distribution coefficient. */
  value: number;
  /** Always true: this value is calculated, never a measured logD. */
  derived: true;
  pH: number;
}

/**
 * Estimate logD at a pH from logP and the ionization profile, under the common
 * approximation that only the neutral species partitions into octanol:
 *
 *   logD(pH) ≈ logP + log10(f_neutral(pH))
 *
 * Returns `null` when logP is missing or the profile is insufficient to
 * establish a neutral fraction. The result is explicitly flagged `derived` so
 * no caller can present it as an experimentally measured logD.
 */
export function deriveLogD(
  logP: number | null | undefined,
  constants: readonly IonizationConstant[] | null | undefined,
  pH = 7.4,
): DerivedLogD | null {
  if (logP == null || !Number.isFinite(logP)) return null;
  const fNeutral = neutralFractionAtPh(constants, pH);
  if (fNeutral == null || fNeutral <= 0) return null;
  return { value: logP + Math.log10(fNeutral), derived: true, pH };
}
