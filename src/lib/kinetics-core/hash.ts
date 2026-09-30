/**
 * Deterministic, dependency-free hashing for provenance.
 *
 * Used for:
 *   - the registry checksum (integrity of the pinned parameter release), and
 *   - the per-run scenario hash (part of the run manifest, so an identical
 *     scenario is provably identical across Kinetix and Redose).
 *
 * `canonicalJson` serialises with object keys sorted recursively so that key
 * ordering never changes the hash. `fnv1a32` is a stable 32-bit FNV-1a hash
 * rendered as 8 hex chars — not cryptographic, just a reproducible fingerprint.
 */

/** JSON with recursively sorted object keys — stable regardless of insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 32-bit FNV-1a hash of a string, as 8 lowercase hex chars. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical-JSON-then-FNV-1a fingerprint of an arbitrary value.
 *
 * Never throws: a structurally malformed input (a circular object, a BigInt
 * field) would make JSON.stringify / the recursive key-sort throw, which must not
 * escape and bypass the engine's structured-failure path. Such inputs get a
 * stable sentinel hash and are rejected downstream by validation.
 */
export function hashValue(value: unknown): string {
  try {
    return fnv1a32(canonicalJson(value));
  } catch {
    return 'unhashable';
  }
}
