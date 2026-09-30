/**
 * The canonical `kg_assessments.capability_snapshot`, and nothing host-specific.
 *
 * §3 of `docs/plans/2026-09-05-assurance-transition-continuation.md` records
 * why this file exists and why it is this small: the column holds several
 * Kinetix-era representations, and a generic Postgres store cannot be
 * extracted from a reader that has to know them. Import purity is not semantic
 * portability — the adapter was clean about what it imported and still
 * understood a mirror's `{ modelTier, isImplicit }` object, which is Kinetix
 * archaeology rather than storage semantics.
 *
 * So the split is by what a field *means*, not by who wrote it:
 *
 *   - `assuranceCapabilities` is the only thing any gate reads. It is a claim
 *     about qualification — what this assessor was entitled to certify when
 *     the assessment was admitted — and it is server-owned.
 *   - `host` is everything else: descriptive capabilities, an agent slug,
 *     import provenance. The generic store carries it and never interprets it.
 *     A field the store might read is a field a host can influence a gate
 *     with; a field it provably ignores is not.
 *
 * The implicit marker is deliberately *not* here. "This is the author's
 * submit-time stake rather than a review" is a fact about the assessment, not
 * about the assessor's capabilities, and the generic schema already has a
 * column for it (`independence_group = 'author'`). Two places to record one
 * fact is how the reader that this replaced acquired its second branch.
 *
 * ## Rows that are not canonical
 *
 * Every writer in this repository produces the canonical shape, so a
 * non-canonical row is either history written before that was true or
 * something corrupt. This module does not guess at either: it reports
 * `NON_CANONICAL` and leaves the decision to whoever knows the host. Kinetix's
 * knowledge of its own older shapes lives in `kinetix-legacy-snapshots.ts` and
 * is injected — see {@link LegacySnapshotReader} — so the extraction of this
 * store is a move rather than exported archaeology.
 */

/** The canonical stored shape. Anything else is history or corruption. */
export interface CapabilitySnapshot {
  /** Server-owned qualifications. The only part a gate reads. */
  readonly assuranceCapabilities: readonly string[];
  /** Host-owned, opaque to the generic store, never consulted by a gate. */
  readonly host?: Readonly<Record<string, unknown>>;
}

/** The marker a canonical row uses for the author's submit-time stake. */
export const AUTHOR_INDEPENDENCE_GROUP = 'author';

/** This snapshot is not in the canonical shape; the store will not guess. */
export const NON_CANONICAL = Symbol('non-canonical capability snapshot');

/**
 * What a host offers the store about its own older representations.
 *
 * Returning `null` means "I do not recognise this either", which is the honest
 * answer for a corrupt row and keeps the store's behaviour the same as if no
 * host reader were configured at all.
 */
export interface LegacySnapshotReader {
  /** Capabilities this host can vouch for in a non-canonical snapshot. */
  readCapabilities(snapshot: unknown): readonly string[] | null;
  /** An implicit marker this host recorded outside `independence_group`. */
  readImplicit(snapshot: unknown): boolean | undefined;
}

/**
 * Build a canonical snapshot.
 *
 * Capabilities in, capabilities out. A host whose older rows state a
 * qualification some other way — Kinetix's server-owned model tier, say —
 * translates it before calling this; see `kinetix-compat.ts`. Naming that
 * field here would have put the host's vocabulary in the one module the
 * extraction is supposed to carry unchanged, for the sake of a convenience
 * three call sites can express in a word.
 */
export function canonicalSnapshot(input: {
  assuranceCapabilities?: readonly string[] | undefined;
  host?: Record<string, unknown> | undefined;
}): CapabilitySnapshot {
  const capabilities = new Set(input.assuranceCapabilities ?? []);
  const host = input.host && Object.keys(input.host).length > 0 ? input.host : undefined;
  return {
    assuranceCapabilities: [...capabilities].sort(),
    ...(host ? { host } : {}),
  };
}

/**
 * A capability list is trusted whole or not at all.
 *
 * Filtering the non-strings out and keeping the rest is the same "parsed,
 * therefore safe" reasoning the risk tags were fixed for, and it grants rather
 * than withholds: `{ assuranceCapabilities: ['clinical_expert', null] }` would
 * have kept `clinical_expert`, so a malformed server-owned snapshot could
 * still satisfy `humanApprovalWithCapability`. A capability is a claim about
 * qualification, and half a readable claim is not one.
 */
export function allStrings(values: readonly unknown[]): readonly string[] | null {
  return values.every((v): v is string => typeof v === 'string')
    ? (values as readonly string[])
    : null;
}

/**
 * The assurance capabilities of a canonical snapshot.
 *
 * `NON_CANONICAL` rather than `[]` for anything else, because those two
 * answers must not be confused: an assessor with no capabilities and a row
 * nobody can read are different facts, and collapsing them is how a corrupt
 * snapshot becomes an ordinary unqualified approval that nobody investigates.
 */
export function readCanonicalCapabilities(
  snapshot: unknown,
): readonly string[] | typeof NON_CANONICAL {
  // An absent snapshot is the column's default and states no qualification.
  // It is not corruption, and reporting it as such would fire the signal on
  // the most ordinary row there is — noise from its first day, which is the
  // failure mode a corruption counter can least afford.
  if (snapshot === null || snapshot === undefined) return [];
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return NON_CANONICAL;
  const raw = snapshot as { assuranceCapabilities?: unknown };
  if (!Array.isArray(raw.assuranceCapabilities)) return NON_CANONICAL;
  // A list with a non-string in it is not a shorter list; it is a claim about
  // qualification that cannot be read. Collapsing it to `[]` would have marked
  // the snapshot canonical and readable, so the one corruption the
  // all-or-nothing rule exists to catch was the one case that never reached
  // the counter.
  return allStrings(raw.assuranceCapabilities) ?? NON_CANONICAL;
}

/**
 * Whether an assessment is the author's submit-time stake, by the column.
 *
 * The canonical answer, and the only one the generic store has. A host with an
 * older marker of its own supplies it through {@link LegacySnapshotReader}.
 */
export function isImplicitByColumn(row: {
  independenceGroup?: string | null;
}): boolean {
  return row.independenceGroup === AUTHOR_INDEPENDENCE_GROUP;
}

/** A host field of a snapshot, canonical or historical, or `undefined`. */
export function readHostField(snapshot: unknown, key: string): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return undefined;
  }
  const canonical = (snapshot as CapabilitySnapshot).host;
  if (canonical && typeof canonical === 'object' && key in canonical) {
    return (canonical as Record<string, unknown>)[key];
  }
  // Historical rows kept host data at the top level.
  return (snapshot as Record<string, unknown>)[key];
}
