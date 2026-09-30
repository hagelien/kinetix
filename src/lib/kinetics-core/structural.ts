/**
 * Structural PK parameter identity + identifiability semantics (SC-1A).
 *
 * Implements the plan's true-vs-apparent rule (docs/plans/2026-08-18-…-scientific-
 * completion.md §4.1, §5.3): a model fitted only to extravascular data identifies
 * `CL/F` and `V/F`, NOT `CL` and `V`. This module keeps that distinction
 * first-class — a difference of IDENTITY, not a note on one value — and refuses to
 * surface an apparent parameter as an absolute physiological one.
 *
 * Pure and dependency-free (like the rest of kinetics-core): every function here is
 * a total function of its inputs with no I/O, so it is trivially portable and
 * Hermes-safe. The forward engine (`simulate.ts`) uses `resolveClvDisposition` to
 * turn an authored clearance/volume pair into the `ke`, half-life and scaling
 * volume its closed-form kernel needs.
 */
import type {
  IdentifiabilityBasis,
  Limitation,
  ResolvedStructuralParameter,
  StructuralParameterId,
  StructuralParameterSpec,
} from './types.js';
import { halfLifeFromK } from './equations.js';

/**
 * Base ids that have an APPARENT (÷F) counterpart — the disposition parameters an
 * extravascular-only fit cannot separate from bioavailability. Absorption (`ka`),
 * bioavailability (`F`) and the saturable-elimination constants (`Vmax`, `Km`)
 * have no `/F` identity, so their display id is unchanged by the basis.
 */
const APPARENT_SUFFIXABLE: ReadonlySet<StructuralParameterId> = new Set<StructuralParameterId>([
  'CL',
  'Vc',
  'Vp',
  'Q',
]);

/** An extravascular-only fit: only the apparent value (`CL/F`, `V/F`) is identified. */
export function isApparentBasis(basis: IdentifiabilityBasis): boolean {
  return basis === 'apparent-extravascular';
}

/** A basis that licenses reading the parameter as an ABSOLUTE physiological value. */
export function isAbsoluteBasis(basis: IdentifiabilityBasis): boolean {
  return basis === 'iv-anchored' || basis === 'absolute-f-supported';
}

/**
 * A basis valid for an AUTHORED PRIMITIVE parameter (a value the model states, not
 * one the engine computes): it must be apparent or absolute. `derived` is excluded
 * (it is for computed quantities like ke / t½), and so is any unknown/out-of-enum
 * value a non-TypeScript caller might supply (`null`, `''`, a typo) — for which both
 * the apparent and absolute predicates return false. Guarding on this positively,
 * rather than only rejecting `derived`, closes the hole where two identically-unknown
 * bases would pass `sameIdentifiabilityClass` (false === false).
 */
export function isPrimitiveBasis(basis: IdentifiabilityBasis): boolean {
  return isApparentBasis(basis) || isAbsoluteBasis(basis);
}

/**
 * The DISPLAY identity of a parameter given its basis: `CL` when absolute/derived,
 * `CL/F` when apparent-extravascular (and likewise `Vc/F`, `Vp/F`, `Q/F`).
 * Parameters with no apparent counterpart (`ka`, `F`, `Vmax`, `Km`) keep their id.
 */
export function structuralIdentity(
  id: StructuralParameterId,
  basis: IdentifiabilityBasis,
): string {
  return isApparentBasis(basis) && APPARENT_SUFFIXABLE.has(id) ? `${id}/F` : id;
}

/**
 * Resolve an authored structural parameter against a drawn/central value into its
 * reportable form — the value, its display identity, and whether it may be exposed
 * as an absolute physiological quantity. `derived` values (ke, t½, …) are computed
 * quantities, not measurements, so they are not flagged absolute-exposable here.
 */
export function resolveStructural(
  p: Pick<StructuralParameterSpec, 'id' | 'basis'>,
  value: number,
): ResolvedStructuralParameter {
  return {
    id: p.id,
    basis: p.basis,
    value,
    identity: structuralIdentity(p.id, p.basis),
    exposableAsAbsolute: isAbsoluteBasis(p.basis),
  };
}

/**
 * The ABSOLUTE physiological value of a resolved structural parameter, or `null`
 * when its basis does not license an absolute reading. This is the enforcement
 * point for plan §4.1: a run "refuses to report an absolute CL/V for a parameter
 * whose basis is apparent-extravascular". Consumers that want an absolute number
 * must go through this and handle the `null`, rather than reading `.value`
 * directly (which for an apparent parameter is `CL/F`, not `CL`).
 *
 * Exposure is derived from the authoritative `basis` (via `isAbsoluteBasis`), NOT
 * from the redundant `exposableAsAbsolute` boolean: a deserialized or
 * hand-constructed value could carry an inconsistent pair (`apparent-extravascular`
 * with `exposableAsAbsolute: true`), and trusting the boolean would then promote an
 * apparent `CL/F` to absolute — the exact no-promotion guarantee this guard exists
 * to hold. `resolveStructural` always keeps the two consistent, so this changes
 * nothing for engine-produced values.
 */
export function absoluteValueOrNull(p: ResolvedStructuralParameter): number | null {
  return isAbsoluteBasis(p.basis) ? p.value : null;
}

/**
 * The limitation every `one-compartment-clv` route carries in S1A: its `CL`/`Vc`
 * are the model's reference-subject population values and are NOT scaled to the
 * subject's weight or covariates — allometric/covariate scaling of CL and V is a
 * later slice (S2). Emitted as a standing WARNING so a consumer can never mistake a
 * reference-subject curve for an individualised one: without it a 40 kg and a 140 kg
 * subject would receive an identical curve with no indication that weight was
 * ignored (the other families scale Vd by weight, so the expectation differs).
 */
export function clvReferenceSubjectLimitation(route: string): Limitation {
  return {
    code: 'clv-reference-subject',
    text:
      `Route "${route}" uses reference-subject CL/Vc; the curve is NOT scaled to the ` +
      `subject's weight or other covariates (allometric/covariate scaling of CL and V ` +
      `is not yet implemented), so it is a population/reference-subject prediction, not ` +
      `an individualised one.`,
    severity: 'warning',
  };
}

/** A clearance/volume disposition resolved for one run. */
export interface ResolvedClvDisposition {
  clearance: ResolvedStructuralParameter;
  volume: ResolvedStructuralParameter;
  /** Elimination rate constant `ke = CL/Vc` (1/h). Identifiable in either basis. */
  eliminationRatePerHour: number;
  /** Terminal half-life `ln2/ke` (h). A `derived` quantity, not an independent primitive. */
  halfLifeHours: number;
  /**
   * The distribution volume (L) the forward curve amplitude scales with: the
   * absolute `Vc` for an absolute basis, or the apparent `Vc/F` for an
   * apparent-extravascular basis. Equal to `volume.value` in both cases; named
   * distinctly because the kernel meaning differs (see `OneCompartmentClvRouteParams`).
   */
  scalingVolumeLiters: number;
}

/**
 * Do two structural parameters share the same identifiability class — **both
 * apparent, or both absolute**? A clearance/volume pair must be coherent: you cannot
 * identify an absolute `CL` while `V` stays apparent (both need the same IV/F
 * anchor). Mixing the two is a model-authoring error.
 *
 * Defined positively (two apparent, or two absolute) rather than as equality of the
 * two class predicates: an equality test would report `('derived','derived')` — or
 * any two identically non-primitive/unknown bases — as the "same class" (both
 * predicates false → `false === false`), which contradicts this function's own
 * contract. `derived` is a computed-quantity basis and unknown values are not a
 * class at all, so neither shares a class with anything, including itself.
 */
export function sameIdentifiabilityClass(
  a: IdentifiabilityBasis,
  b: IdentifiabilityBasis,
): boolean {
  return (
    (isApparentBasis(a) && isApparentBasis(b)) || (isAbsoluteBasis(a) && isAbsoluteBasis(b))
  );
}

/**
 * Whether an authored clearance/volume pair is a COHERENT structural disposition —
 * the runtime guard behind the type-level `StructuralParameterSpec<'CL'>` /
 * `<'Vc'>` pinning, for non-TypeScript callers and defensive depth. A pair is
 * coherent iff:
 *   - clearance is `CL` and volume is `Vc` (not swapped or an unrelated id);
 *   - EACH basis is a valid primitive basis (apparent or absolute). This rejects
 *     `derived` (a COMPUTED-quantity basis, never an authored primitive) AND any
 *     unknown/out-of-enum value a non-TypeScript caller might pass (`null`, `''`, a
 *     typo). Without this positive check two identically-unknown bases would slip
 *     through the same-class test below (both apparent? no; both absolute? no →
 *     `false === false` is true);
 *   - both share the same identifiability class (`sameIdentifiabilityClass`): you
 *     cannot identify an ABSOLUTE `CL` alongside an APPARENT `V` (or vice versa) —
 *     separating either from bioavailability needs the same IV/F anchor, so a mixed
 *     pair is scientifically impossible, not merely unusual.
 *
 * An incoherent pair would still yield a finite curve (the numbers divide), but
 * with contradictory identities — exactly the "valid but wrong" result the
 * identifiability contract exists to prevent — so the engine rejects it rather than
 * deciding the whole calculation from `clearance.basis` alone.
 */
export function isCoherentClvDisposition(
  clearance: Pick<StructuralParameterSpec, 'id' | 'basis'>,
  volume: Pick<StructuralParameterSpec, 'id' | 'basis'>,
): boolean {
  if (clearance.id !== 'CL' || volume.id !== 'Vc') return false;
  if (!isPrimitiveBasis(clearance.basis) || !isPrimitiveBasis(volume.basis)) return false;
  return sameIdentifiabilityClass(clearance.basis, volume.basis);
}

/**
 * Resolve an authored clearance/volume disposition against drawn values into the
 * quantities the closed-form one-compartment kernel needs. `ke = CL/Vc` and the
 * terminal half-life are derived; the scaling volume is `volume`'s resolved value.
 * The caller supplies already-drawn numeric values (so the seeded draw ORDER stays
 * owned by the engine, which defines the parity contract); this function does the
 * identity bookkeeping and the CL/V → ke/t½ derivation.
 *
 * **Enforced precondition:** the pair must be a coherent disposition
 * (`isCoherentClvDisposition`) — clearance `CL`, volume `Vc`, a shared primitive
 * identifiability class. This is checked here too, not only in the engine, so a
 * DIRECT package consumer cannot bypass the engine's guard and get a valid-looking
 * `ke`/summary out of a scientifically meaningless division (mixed apparent/absolute,
 * or a `Q`/`Vp` id). Incoherent input throws rather than returning a plausible-wrong
 * result; the id types are also narrowed so a swap is a TypeScript error. The engine
 * guards with `isCoherentClvDisposition` BEFORE calling this, so its structured-
 * failure path (invalid draw → non-result) is never turned into a throw.
 *
 * `Number.isFinite` / positivity is NOT enforced here — the engine's physicality
 * filter owns rejecting a non-physical draw (and resampling), so a `0`/negative
 * value flows through to that single gate rather than being second-guessed here.
 */
export function resolveClvDisposition(
  clearanceSpec: Pick<StructuralParameterSpec<'CL'>, 'id' | 'basis'>,
  volumeSpec: Pick<StructuralParameterSpec<'Vc'>, 'id' | 'basis'>,
  clearanceValue: number,
  volumeValue: number,
): ResolvedClvDisposition {
  if (!isCoherentClvDisposition(clearanceSpec, volumeSpec)) {
    throw new Error(
      `resolveClvDisposition: incoherent disposition (CL basis "${String(
        clearanceSpec.basis,
      )}", Vc basis "${String(
        volumeSpec.basis,
      )}"); clearance must be CL and volume Vc with a shared primitive identifiability class.`,
    );
  }
  const clearance = resolveStructural(clearanceSpec, clearanceValue);
  const volume = resolveStructural(volumeSpec, volumeValue);
  const ke = clearanceValue / volumeValue;
  return {
    clearance,
    volume,
    eliminationRatePerHour: ke,
    halfLifeHours: halfLifeFromK(ke),
    scalingVolumeLiters: volumeValue,
  };
}
