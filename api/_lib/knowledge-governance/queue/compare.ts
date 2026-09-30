/**
 * Legacy ⇄ generic queue comparison (Phase 5 work items 3 and 4).
 *
 * Runs both selectors for the same actor context and reports where they
 * disagree. The exit gate is stated in terms of what this produces:
 *
 *   - no unexplained candidate eligibility divergences;
 *   - no reviewer-data leakage;
 *   - latency within acceptable budget;
 *   - the existing agent queue remains the served endpoint.
 *
 * The plan is explicit that **ordering need not match** — a later phase may
 * introduce a different prioritisation model on purpose — but that
 * inclusion/exclusion semantics must match first. So an order difference is
 * reported and counted, and is deliberately not the same kind of finding as a
 * candidate present on only one side.
 */

import { fingerprint } from 'assurance-core';
import { KINETIX_SPACE } from '../actor-context.js';
import { registerKinetixAdapters } from '../adapters/kinetix/index.js';
import { findKnowledgeTargetAdapter } from '../registry.js';
import { legacyPayloadFromPacket, type LegacyQueueItem } from '../shadow-queue.js';
import {
  selectGenericQueue,
  type ExclusionReason,
  type GenericQueueRequest,
  type GenericQueueResult,
} from './generic-queue.js';

export const QUEUE_METRICS = [
  'kg_queue_candidate_legacy_only',
  'kg_queue_candidate_generic_only',
  'kg_queue_packet_mismatch',
  'kg_queue_order_difference',
  'kg_queue_scan_truncated',
  'kg_queue_latency_ms',
] as const;

export type QueueMetric = (typeof QUEUE_METRICS)[number];

export interface QueueComparison {
  /** Served by the legacy queue and not selected by the generic one. */
  readonly legacyOnly: ReadonlyArray<{
    readonly key: string;
    /** Why the generic selector dropped it, when it saw and dropped it. */
    readonly reason: ExclusionReason | 'never_considered';
  }>;
  /** Selected by the generic queue and not served by the legacy one. */
  readonly genericOnly: readonly string[];
  /** Candidates both agreed on whose review packets differ. */
  readonly packetMismatches: ReadonlyArray<{
    readonly key: string;
    readonly legacyFingerprint: string;
    readonly genericFingerprint: string;
  }>;
  /** True when both selected the same set but in a different order. */
  readonly orderDiffers: boolean;
  /**
   * Target types whose generic scan hit its candidate cap before finding a
   * full batch.
   *
   * For such a type the generic side is a known lower bound, so the findings
   * above are not a parity verdict for it: rows the generic selector never
   * reached appear here as `legacyOnly` and are indistinguishable from rows it
   * saw and dropped. They are still listed — which of them were cap-induced
   * cannot be determined from this side, and silently discarding them would
   * hide a real divergence — but a report that shows the findings without
   * this list states a conclusion the scan did not reach.
   */
  readonly truncated: readonly string[];
  readonly metrics: Readonly<Record<QueueMetric, number>>;
}

function keyOf(item: { targetType: string; targetId: number }): string {
  return `${item.targetType}:${item.targetId}`;
}

/**
 * What the generic path would hand this reviewer, projected back into the
 * legacy payload shape and fingerprinted.
 *
 * Projected back rather than compared as a packet, because the two sides do not
 * have the same shape and the question is not "are these the same object" but
 * "would a reviewer learn the same things". Phase 2 established by round-trip
 * that the projection is lossless in both directions, so a mismatch here is a
 * real difference in what would be served — most likely because the row moved
 * between the legacy read and this one, which is exactly the case worth
 * catching before a cutover.
 *
 * Returns `null` when the row is no longer loadable at all, which the caller
 * reports rather than treating as agreement.
 */
async function genericPayloadFingerprint(
  targetType: string,
  targetId: number,
  space: string,
): Promise<string | null> {
  const adapter = findKnowledgeTargetAdapter(space, targetType);
  if (!adapter) return null;
  const ref = { space, type: targetType, id: String(targetId) };
  const version = await adapter.loadVersion(ref);
  if (!version) return null;
  const packet = await adapter.buildReviewPacket({
    version,
    // The packet must not vary by who is reading it — that is what makes it a
    // sealed snapshot (§8.1) — so a fixed observer is the honest input here.
    actor: {
      actorRef: 'system:queue-compare',
      kind: 'system',
      capabilities: [],
      assuranceCapabilities: [],
    },
  });
  return payloadFingerprintOf(legacyPayloadFromPacket(targetType, packet));
}

/**
 * Fingerprint a served payload.
 *
 * JSON round-trip first, so an absent key and an explicitly-undefined one hash
 * alike: the legacy queue builds payloads with `undefined` holes for
 * inapplicable fields and `json()` drops them on the way out, so comparing
 * before that normalisation would report a difference no agent could observe.
 */
function payloadFingerprintOf(payload: unknown): string {
  return fingerprint(JSON.parse(JSON.stringify(payload ?? null)));
}

/**
 * Compare a legacy batch against the generic selector for the same actor.
 *
 * The legacy side is passed in rather than fetched, so the caller drives the
 * real route (with its real auth and its real SQL) and this stays a pure
 * comparison over what that route actually served.
 */
export async function compareQueues(
  legacyItems: readonly LegacyQueueItem[],
  request: GenericQueueRequest,
): Promise<QueueComparison & { generic: GenericQueueResult }> {
  registerKinetixAdapters();
  const space = request.space ?? KINETIX_SPACE;
  const generic = await selectGenericQueue(request);

  const legacyKeys = legacyItems.map(keyOf);
  const genericKeys = generic.items.map(keyOf);
  const legacySet = new Set(legacyKeys);
  const genericSet = new Set(genericKeys);

  // A legacy-only candidate is reported with the reason the generic selector
  // dropped it, when it had one. "It disagreed" is not a finding anyone can
  // act on; "it dropped this as authored_by_caller" is.
  const exclusionReasons = new Map(
    generic.excluded.map((e) => [keyOf(e.candidate), e.reason]),
  );
  const legacyOnly = legacyKeys
    .filter((key) => !genericSet.has(key))
    .map((key) => ({
      key,
      reason: exclusionReasons.get(key) ?? ('never_considered' as const),
    }));
  const genericOnly = genericKeys.filter((key) => !legacySet.has(key));

  const packetMismatches: Array<{
    key: string;
    legacyFingerprint: string;
    genericFingerprint: string;
  }> = [];
  for (const item of legacyItems) {
    const key = keyOf(item);
    if (!genericSet.has(key)) continue;
    // The legacy side is the payload the route actually served — not a
    // re-read of the row, which would compare the generic path to itself.
    const legacyFingerprint = payloadFingerprintOf(item.payload);
    const genericFingerprint = await genericPayloadFingerprint(
      item.targetType,
      item.targetId,
      space,
    );
    if (genericFingerprint !== legacyFingerprint) {
      packetMismatches.push({
        key,
        legacyFingerprint,
        genericFingerprint: genericFingerprint ?? 'null',
      });
    }
  }

  const sameSet = legacyOnly.length === 0 && genericOnly.length === 0;
  const orderDiffers =
    sameSet && legacyKeys.join(',') !== genericKeys.join(',');

  return {
    generic,
    legacyOnly,
    genericOnly,
    packetMismatches,
    orderDiffers,
    truncated: generic.truncated,
    metrics: {
      kg_queue_candidate_legacy_only: legacyOnly.length,
      kg_queue_candidate_generic_only: genericOnly.length,
      kg_queue_packet_mismatch: packetMismatches.length,
      kg_queue_order_difference: orderDiffers ? 1 : 0,
      kg_queue_scan_truncated: generic.truncated.length,
      kg_queue_latency_ms: generic.latencyMs,
    },
  };
}

/** One-line summary, for a diagnostics log. */
export function describeComparison(comparison: QueueComparison): string {
  const parts: string[] = [];
  // First, because it qualifies everything after it: with a truncated scan
  // "identical" is not available and the findings are not conclusive.
  if (comparison.truncated.length) {
    parts.push(
      `SCAN TRUNCATED for ${comparison.truncated.join(' ')} — findings below are not conclusive`,
    );
  }
  if (comparison.legacyOnly.length) {
    parts.push(
      `legacy-only=${comparison.legacyOnly
        .map((l) => `${l.key}(${l.reason})`)
        .join(' ')}`,
    );
  }
  if (comparison.genericOnly.length) {
    parts.push(`generic-only=${comparison.genericOnly.join(' ')}`);
  }
  if (comparison.packetMismatches.length) {
    parts.push(`packet-mismatch=${comparison.packetMismatches.length}`);
  }
  if (comparison.orderDiffers) parts.push('order-differs');
  return parts.length === 0
    ? `kg queue: identical (${comparison.metrics.kg_queue_latency_ms}ms)`
    : `kg queue: ${parts.join('; ')}`;
}
