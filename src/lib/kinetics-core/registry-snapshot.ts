/**
 * Merge a reviewed override tier with DB-derived models into one checksummed snapshot (CV-4).
 *
 * The catalog-coverage plan (§6) turns the registry from a hand-authored list into a **derived,
 * versioned, checksummed snapshot** of DB declarations + parameters, while KEEPING the current
 * hand-authored models as the reviewed **override tier** (the known nonlinear/complex drugs —
 * cocaine, THC, GHB, ethanol, MDMA, …). The offline consumer still pins the snapshot's checksum, so
 * a DB edit changes the *next* snapshot, never a curve already pinned (plan §6, and the non-goal
 * "no live-DB curves for the offline consumer").
 *
 * This module is the pure **merge primitive** at the heart of that — no DB read, no file emission,
 * no engine change. A caller (CV-4b) supplies:
 *   - the `overrides`: the reviewed, hand-authored `DrugModelDefinition`s (today's `registry.ts`), and
 *   - the `derived`:  models assembled from DB declarations for the broad catalog,
 * and `buildRegistrySnapshot` returns the merged, checksummed release.
 *
 * **Override precedence: an override ALWAYS wins (founder decision, 2026-08-24).** A derived entry is
 * kept only when NO override already claims its analyte (or an alias); a derived entry that collides
 * with an override is dropped (`supersededByOverride`), so a reviewed nonlinear model is never
 * silently replaced by a naive one-compartment DB derivation. Derivation fills the gaps the override
 * tier leaves; it never overrides the reviewed tier.
 *
 * The checksum is computed EXACTLY as `registry.ts` computes `REGISTRY_CHECKSUM`
 * (`hashValue({ version, definitions })`), so a snapshot built from the current definitions with NO
 * derived entries reproduces today's pinned checksum bit-for-bit — the derived-snapshot path is a
 * drop-in for the hand-authored release, which is what keeps reproducibility intact across the
 * migration. Pure/additive: no `CORE_VERSION` bump.
 */
import type { DrugModelDefinition } from './types.js';
import { hashValue } from './hash.js';

/** A merged, versioned, checksummed registry release — the unit the offline consumer pins. */
export interface RegistrySnapshot {
  /** The release version this snapshot carries (mirrors `REGISTRY_VERSION`). */
  version: string;
  /**
   * The merged models, in a STABLE order: every override first (in the given order), then the
   * surviving derived entries (in the given order). The builder does not reorder — a caller wanting
   * a reproducible checksum passes deterministically-ordered inputs (the authored override list is
   * fixed; the DB read adapter sorts its rows), and passing the current registry definitions with no
   * derived entries reproduces `REGISTRY_CHECKSUM`.
   *
   * An independent, deeply-frozen deep copy of the inputs (like `registry.ts`'s own definitions), so
   * the pinned release cannot drift from its `checksum` — mutating a source model after the build, or
   * the returned array itself, cannot reach into the snapshot.
   */
  definitions: DrugModelDefinition[];
  /** `hashValue({ version, definitions })` — identical scheme to `registry.ts`. */
  checksum: string;
  /**
   * Analyte ids of the derived entries dropped because an override already claims that analyte (or
   * one of its aliases). Build-report metadata only — the override tier is authoritative, so a
   * shadowed derivation is expected, not an error. Empty when derivation and the override tier are
   * disjoint.
   */
  supersededByOverride: string[];
}

/** Every id a definition resolves under: its primary analyte plus any declared aliases. */
function keysOf(definition: DrugModelDefinition): string[] {
  return [definition.analyte, ...(definition.aliases ?? [])];
}

/**
 * Structural deep copy of a definition graph (arrays, plain objects, primitives — the whole
 * `DrugModelDefinition` payload is plain JSON data, which is exactly why `hashValue` can fingerprint
 * it). The snapshot owns an independent copy so the caller mutating a source model afterwards cannot
 * reach into the release.
 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(deepClone) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/** Recursively freeze so a returned model cannot be mutated in place (mirrors `registry.ts`). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Merge the reviewed override tier with DB-derived models into a checksummed snapshot, with the
 * override tier taking precedence (see the module header). Pure.
 *
 * @param overrides Reviewed, hand-authored models — authoritative; each wins any analyte/alias it
 *   shares with a derived entry.
 * @param derived   Models assembled from DB declarations; a derived entry is kept only when it
 *   collides with no override.
 * @param version   The release version to stamp on the snapshot and fold into the checksum.
 *
 * @throws if two KEPT definitions collide on an analyte/alias — two overrides, or two surviving
 *   derived entries, claiming the same id. That is an authoring/generation bug (the same collision
 *   `registry.ts` rejects at module load), not a precedence question, so it fails loudly rather than
 *   silently dropping one model. A derived entry colliding with an OVERRIDE is not a collision — it
 *   is the expected supersession and is reported in `supersededByOverride`.
 */
export function buildRegistrySnapshot(
  overrides: readonly DrugModelDefinition[],
  derived: readonly DrugModelDefinition[],
  version: string,
): RegistrySnapshot {
  const claimed = new Map<string, DrugModelDefinition>();

  // The override tier is laid down first and is authoritative. A collision WITHIN the overrides is
  // an authoring bug.
  for (const override of overrides) {
    for (const key of keysOf(override)) {
      if (claimed.has(key)) {
        throw new Error(`Registry snapshot: override key collision on "${key}"`);
      }
      claimed.set(key, override);
    }
  }
  const overrideKeys = new Set(claimed.keys());

  const definitions: DrugModelDefinition[] = [...overrides];
  const supersededByOverride: string[] = [];

  for (const candidate of derived) {
    const keys = keysOf(candidate);
    // Override always wins: if the override tier claims ANY of this entry's ids, drop the whole
    // derived entry (it cannot be partially kept — a model resolves under all its ids or none).
    if (keys.some((key) => overrideKeys.has(key))) {
      supersededByOverride.push(candidate.analyte);
      continue;
    }
    // Not shadowed by an override — but it must not collide with an already-kept derived entry.
    for (const key of keys) {
      if (claimed.has(key)) {
        throw new Error(`Registry snapshot: derived key collision on "${key}"`);
      }
      claimed.set(key, candidate);
    }
    definitions.push(candidate);
  }

  // The release the offline consumer pins must be immutable: an independent deep copy, deep-frozen
  // (the array and every nested model), so neither a caller mutating a source model afterwards nor a
  // consumer mutating `snapshot.definitions` can change the payload while `checksum` stays fixed —
  // which is exactly how a curve could advertise a checksum it no longer matches. `registry.ts`
  // deep-freezes its own definitions for the same reason. Freezing does not affect canonical-JSON
  // serialisation, and a faithful clone hashes identically, so checksum parity with `registry.ts`
  // holds. The checksum is computed from the frozen payload itself, so the two can never diverge.
  const release = deepFreeze(deepClone(definitions));

  return {
    version,
    definitions: release,
    checksum: hashValue({ version, definitions: release }),
    supersededByOverride,
  };
}
