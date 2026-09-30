/**
 * Kinetix's compatibility edge over the generic governance tables.
 *
 * §3 of the transition plan asks for exactly this separation: the generic
 * store defines one canonical representation and refuses to infer meaning from
 * anything else, and a host's knowledge of what *it* used to write lives
 * outside that store. These are valuable compatibility rules inside Kinetix.
 * They are not generic Postgres semantics, and when the store is extracted
 * they stay behind rather than travelling as exported archaeology.
 *
 * Three shapes, because three writers produced them before the canonical one
 * existed, and a reader that understood only the newest silently stripped
 * server-owned standing off every row the other two wrote — so a qualifying
 * approval stopped satisfying the clinical-case and high-risk capability
 * gates. That direction is safe for publication and wrong about the data,
 * which makes it a correctness problem rather than a comfortable one.
 *
 * Nothing in this repository writes these shapes any more. They describe rows
 * already on disk.
 *
 * `assessmentMatches` lives here for the same reason rather than in the store:
 * it compares a stored row against a *legacy verdict*, in legacy vocabulary,
 * which is host knowledge. Keeping it in `store/assessments.ts` put Kinetix
 * semantics inside the modules `store/postgres.ts` re-exports — the extraction
 * bundle — and, because it needed the port's reader, made that bundle import
 * the adapter that imports it back.
 */

import { modelTierCapability } from 'assurance-core';
import {
  allStrings,
  canonicalSnapshot,
  isImplicitByColumn,
  type LegacySnapshotReader,
} from './store/capability-snapshot.js';
import { KinetixAssuranceStore, capabilitiesFrom } from './store/assurance-port.js';
import type { AssuranceStoreObserver } from './store/assurance-port.js';
import type { GovernanceDb } from './store/interface.js';
import type { KgVerdict } from '../../../db/schema.js';

/**
 * Capabilities Kinetix can vouch for in a pre-canonical snapshot.
 *
 *   - A bare array is the port's own first representation: the same list the
 *     canonical shape carries, without the wrapper.
 *   - `{ capabilities, assuranceCapabilities }` is the SDK's. Only the
 *     assurance half is read: `capabilities` is descriptive, records what the
 *     actor could do, and no gate consults it. Reading it here would quietly
 *     turn an action permission into a publication qualification.
 *   - `{ modelTier }` is the mirror's and the backfill's, holding the
 *     server-owned tier as it stood when the verdict was admitted. It becomes
 *     the same `model_tier:` capability the live path derives, so a mirrored
 *     row and a native one qualify identically.
 *
 * A present field decides the shape and never falls through to another. An
 * earlier version tested `Array.isArray(assuranceCapabilities)` and, when that
 * failed, tried `modelTier` — so `{ assuranceCapabilities: null, modelTier:
 * 'flagship' }` skipped the all-or-nothing check and was granted the flagship
 * capability anyway. A fall-through between shapes turns "this field is
 * malformed" into "try the next thing that might grant something", which is
 * the opposite of what validating it was for.
 *
 * `null` means "not a shape Kinetix recognises either" — a corrupt row, which
 * the store then surfaces rather than reading as an unqualified approval.
 */
function readLegacyCapabilities(snapshot: unknown): readonly string[] | null {
  // `null` wherever the list cannot be trusted whole. It conferred nothing
  // before and confers nothing now — "trusted whole or not at all" is
  // unchanged — but saying `[]` claimed to have *recognised* the row, so a
  // malformed list read as a canonical assessor with no standing and the
  // corruption counter never saw the one case the rule exists to catch.
  if (Array.isArray(snapshot)) return allStrings(snapshot);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const raw = snapshot as {
    assuranceCapabilities?: unknown;
    modelTier?: unknown;
    isImplicit?: unknown;
    source?: unknown;
  };

  if (raw.assuranceCapabilities !== undefined) {
    return Array.isArray(raw.assuranceCapabilities)
      ? allStrings(raw.assuranceCapabilities)
      : null;
  }
  if (raw.modelTier !== undefined) {
    // A null tier is a row this host really wrote: `mirrorAssessment` stored
    // `verifierTier ?? null` and the source column is nullable, so an agent
    // admitted without one looks exactly like this. It states no qualification
    // and is not malformed. A tier that is present but not a usable string is
    // the other thing, and stays unreadable.
    if (raw.modelTier === null) return [];
    return typeof raw.modelTier === 'string' && raw.modelTier.length > 0
      ? [modelTierCapability(raw.modelTier)]
      : null;
  }
  // The one shape with no capability field at all: `mirrorHumanApproval` stored
  // `{ isImplicit: false, source: 'approval_stamp' }`. Matched on the stamp
  // rather than on `isImplicit` alone, because every agent-side writer paired
  // that marker with `modelTier` — so an object carrying `isImplicit` and *no*
  // tier is a mirror row that lost its tier, not a shape this host wrote, and
  // accepting it would have let a corrupt agent snapshot read as an ordinary
  // unqualified approval.
  if (raw.source === 'approval_stamp') return [];
  // Anything else is an object in no shape this host ever wrote — a misspelled
  // key, a truncated write — and guessing `[]` for it would let it pass as an
  // ordinary unqualified approval, which is the reading this whole counter
  // exists to stop.
  return null;
}

/**
 * The implicit marker the mirror and the backfill wrote into the snapshot.
 *
 * The canonical marker is `independence_group = 'author'`; these writers set
 * `capability_snapshot.isImplicit` and left the column null. Reading only the
 * column reported every such row as an explicit review — which is how an
 * author's own submission ends up counting toward a quorum meant to be
 * independent of them.
 *
 * `undefined` means the row says nothing, and the column's answer stands.
 * Present but unreadable means implicit: `=== true` alone reported a legacy
 * `isImplicit: "true"` as an explicit review. An implicit assessment counts
 * toward nothing, so erring this way withholds a review that might have been
 * real; erring the other way manufactures one.
 */
function readLegacyImplicit(snapshot: unknown): boolean | undefined {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return undefined;
  }
  const marker = (snapshot as { isImplicit?: unknown }).isImplicit;
  if (marker === undefined) return undefined;
  return marker !== false;
}

/**
 * The server-owned tier as the capability a gate reads.
 *
 * The one translation between Kinetix's way of stating a qualification and the
 * generic one, in one place — so a mirrored row and a natively recorded one
 * qualify identically instead of through fields that drift.
 */
export function tierCapabilities(tier: string | null | undefined): readonly string[] {
  return typeof tier === 'string' && tier.length > 0 ? [modelTierCapability(tier)] : [];
}

/** Kinetix's compatibility reader, injected into the store by its factory. */
export const kinetixLegacySnapshots: LegacySnapshotReader = {
  readCapabilities: readLegacyCapabilities,
  readImplicit: readLegacyImplicit,
};

/**
 * Whether an assessment is the author's submit-time stake, for a Kinetix
 * reader outside the store.
 *
 * The column first, then this host's older marker — the same order the store
 * uses, in one function, because it was previously two: the port consulted
 * both and `assurance-service.ts` only the snapshot, so a canonically written
 * implicit approval counted toward a quorum meant to be independent of its
 * author.
 */
export function isImplicitAssessment(row: {
  independenceGroup?: string | null;
  capabilitySnapshot: unknown;
}): boolean {
  if (isImplicitByColumn(row)) return true;
  return readLegacyImplicit(row.capabilitySnapshot) ?? false;
}

/**
 * Whether a recorded assessment already says what the legacy verdict says.
 *
 * Shared by the live mirror, which uses it to decide whether a verdict needs
 * revising, and by the importer's plan, which uses it to decide whether a
 * binding that exists is still the judgment legacy holds. Two definitions of
 * "unchanged" would let one path call a record current while the other
 * corrects it.
 *
 * Compares the whole judgment, not just the verdict: a reviewer that keeps its
 * `approve` but rewrites the rationale has changed what it published, and a
 * verdict re-stamped after a tier change carries a different snapshot behind an
 * identical verdict — which is exactly the case the flagship gate reads.
 */
export function assessmentMatches(
  assessment: {
    verdict: string;
    rationaleMd: string | null;
    capabilitySnapshot: unknown;
    independenceGroup?: string | null;
  },
  incoming: {
    verdict: KgVerdict;
    rationaleMd: string | null;
    capabilitySnapshot: { modelTier: string | null; isImplicit: boolean };
  },
): boolean {
  if (assessment.verdict !== incoming.verdict) return false;
  if ((assessment.rationaleMd ?? null) !== incoming.rationaleMd) return false;
  // Compared as *meaning*, not as stored JSON. A tier and the capability it
  // becomes are the same claim, and a stored row and the legacy verdict it
  // mirrors no longer spell it the same way — so a field-by-field comparison
  // would call every canonically written row stale against the legacy source
  // it faithfully represents, which is a rewrite on every pass and, in the
  // importer, a `stale_binding` reported for a binding that is exactly right.
  const stored = capabilitiesOf(assessment.capabilitySnapshot) ?? [];
  const expected = canonicalSnapshot({
    assuranceCapabilities: tierCapabilities(incoming.capabilitySnapshot.modelTier),
  }).assuranceCapabilities;
  if (stored.length !== expected.length) return false;
  if (stored.some((c: string, i: number) => c !== expected[i])) return false;
  return (
    isImplicitAssessment(assessment) === incoming.capabilitySnapshot.isImplicit
  );
}

/**
 * The capabilities of a snapshot this host wrote, canonical or historical.
 *
 * Lives here rather than in the store because it consults Kinetix's own
 * compatibility reader; the store takes that reader as a parameter and names
 * no host.
 */
export function capabilitiesOf(snapshot: unknown): readonly string[] | undefined {
  const { capabilities } = readHostCapabilities(snapshot);
  return capabilities.length > 0 ? capabilities : undefined;
}

/**
 * As above, but saying whether the snapshot was readable at all.
 *
 * `[]` means "this assessor had no capabilities"; unreadable means nobody can
 * say. A caller that needs to report the second — the corruption counter does —
 * cannot get it from `capabilitiesOf`, which collapses both to `undefined`.
 */
export function readHostCapabilities(snapshot: unknown): {
  capabilities: readonly string[];
  readable: boolean;
} {
  return capabilitiesFrom(snapshot, kinetixLegacySnapshots);
}

/**
 * A port-shaped view of the governance tables, wired for this host.
 *
 * The composition root: it is the only place that hands the store Kinetix's
 * reader for its own older rows. Constructing `KinetixAssuranceStore` without
 * one is the generic behaviour, and is what the extraction leaves behind.
 */
export function kinetixAssuranceStore(
  db: GovernanceDb,
  observer: AssuranceStoreObserver = {},
): KinetixAssuranceStore {
  return new KinetixAssuranceStore(db, observer, kinetixLegacySnapshots);
}
