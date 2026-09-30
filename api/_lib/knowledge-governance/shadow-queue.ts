/**
 * The shadow adapter-based review queue (Phase 2 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 2 says plainly: *do not replace `api/agent-verifications-queue.ts` yet;
 * let a shadow adapter-based queue run in tests/diagnostics.* This is that
 * shadow, and it is deliberately a **reconciler** rather than a second queue.
 *
 * A second queue would need its own copy of the candidate SQL — the age cutoff,
 * the author exclusion, the not-yet-verified NOT EXISTS, the wiki visibility
 * filter, the reserved-share interleave — and two copies of an eligibility rule
 * is how a governance system starts serving one audience rows the other thinks
 * are hidden. So eligibility stays where it is proven, in the live queue, and
 * the shadow re-hydrates the rows that queue actually served, through the
 * adapters, and reports any difference.
 *
 * What that buys is exactly Phase 2's exit gate: adapter review packets
 * preserve all the information an agent currently receives, and leak nothing
 * extra. It is checked by round-tripping — the packet is projected *back* into
 * the legacy payload shape and compared field by field, so a field the adapter
 * quietly dropped, renamed, or reshaped shows up as a divergence rather than
 * passing because both sides happen to be truthy.
 */

import {
  getKnowledgeTargetAdapter,
  findKnowledgeTargetAdapter,
} from './registry.js';
import type { ReviewPacket } from 'assurance-core';
import type { ProposalVersion } from './target-adapter.js';
import { KINETIX_SPACE } from './actor-context.js';
import type { ActorContext } from 'assurance-core';

/** One item as `GET /api/agent-verifications-queue` serves it today. */
export interface LegacyQueueItem {
  readonly targetType: string;
  readonly targetId: number;
  readonly targetVersion: string;
  readonly createdAt: string;
  readonly authorUserId: number | null;
  readonly payload: Record<string, unknown>;
}

export interface ShadowQueueItem {
  readonly targetType: string;
  readonly targetId: number;
  readonly version: ProposalVersion;
  readonly packet: ReviewPacket;
}

/** Build the adapter-side view of one legacy queue item. */
export async function buildShadowQueueItem(
  item: Pick<LegacyQueueItem, 'targetType' | 'targetId'>,
  actor: ActorContext,
  space = KINETIX_SPACE,
): Promise<ShadowQueueItem | null> {
  const adapter = getKnowledgeTargetAdapter(space, item.targetType);
  const target = { space, type: item.targetType, id: String(item.targetId) };
  const version = await adapter.loadVersion(target);
  if (!version) return null;
  const packet = await adapter.buildReviewPacket({ version, actor });
  return { targetType: item.targetType, targetId: item.targetId, version, packet };
}

/**
 * Project a review packet back into the legacy queue payload shape.
 *
 * This is the compatibility direction, and it exists only so the two can be
 * compared. It disappears when a later phase cuts the queue over to adapters:
 * at that point the packet *is* the payload and there is nothing to translate.
 *
 * Each branch is a statement about where a legacy field went — `oldValue` into
 * the baseline, `readInFullUnverified` into review context, and so on — so the
 * mapping is reviewable rather than implied.
 */
export function legacyPayloadFromPacket(
  targetType: string,
  packet: ReviewPacket,
): Record<string, unknown> {
  const proposed = packet.proposed;
  const current = packet.current;
  const citationIds = packet.evidence
    .filter((e) => e.kind === 'citation')
    .map((e) => Number(e.id));

  switch (targetType) {
    case 'drug_parameter_revision':
      return {
        drug: current.drug,
        parameter: proposed.parameter,
        oldValue: current.value,
        newValue: proposed.newValue,
        editSummary: proposed.editSummary,
        referenceIds: citationIds,
      };
    case 'wiki_revision':
      return {
        page: current.page,
        editSummary: proposed.editSummary,
        content: proposed.content,
        contentHtml: proposed.contentHtml,
        previousContent: current.content,
        previousContentHtml: current.contentHtml,
        previousCreatedAt: current.createdAt,
      };
    case 'paper_review':
      return {
        citation: current.citation,
        reviewMarkdown: proposed.reviewMarkdown,
        overallScore: proposed.overallScore,
        conclusionSupport: proposed.conclusionSupport,
        reviewConfidence: proposed.reviewConfidence,
        readInFull: proposed.readInFull,
        readInFullUnverified: packet.context.readInFullUnverified,
      };
    case 'drug_discussion':
      return {
        drugId: current.drugId,
        parameter: proposed.parameter,
        parentId: proposed.parentId,
        body: proposed.body,
      };
    case 'learning_unit_revision':
      return {
        unitId: current.unitId,
        content: proposed.content,
        editSummary: proposed.editSummary,
      };
    case 'pending_edit':
      return {
        editType: proposed.editType,
        targetId: proposed.targetId,
        parameter: proposed.parameter,
        proposedValue: proposed.proposedValue,
        proposedMeta: proposed.proposedMeta,
        referenceIds: citationIds,
        status: proposed.status,
        sectionId: proposed.sectionId,
        fieldId: proposed.fieldId,
        factStatement: proposed.factStatement,
        factOperation: proposed.factOperation,
        factTargetAnchor: proposed.factTargetAnchor,
        drugName: current.drugName,
        currentValue: current.currentValue,
        pageTitle: current.pageTitle,
        currentContent: current.currentContent,
        currentContentHtml: current.currentContentHtml,
        citation: current.citation,
      };
    default:
      throw new Error(
        `knowledge-governance: no legacy payload projection for '${targetType}'`,
      );
  }
}

export type DivergenceKind =
  | 'no_adapter'
  | 'version_missing'
  | 'field_mismatch'
  | 'field_missing'
  | 'field_extra'
  | 'target_version_mismatch'
  | 'created_at_mismatch'
  | 'author_mismatch';

export interface ShadowDivergence {
  readonly targetType: string;
  readonly targetId: number;
  readonly kind: DivergenceKind;
  /** The payload key at issue, when the divergence is about one. */
  readonly field?: string;
  readonly legacy?: unknown;
  readonly shadow?: unknown;
}

/**
 * JSON round-trip, so an absent key and an explicitly-undefined one compare
 * equal and `Date`/`Decimal`-ish values compare the way the HTTP response
 * serialises them. The legacy queue builds payloads with `undefined` holes for
 * inapplicable fields (`drugName` on a wiki edit, say) and `json()` drops them
 * on the way out; comparing before that normalisation would report a
 * divergence the agent could never observe.
 */
function normalise(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/**
 * Compare one legacy queue item against its adapter-built packet.
 *
 * Returns every difference rather than the first: a divergence report that
 * stops at one field makes an adapter take as many round trips to fix as it
 * has bugs.
 */
export async function reconcileQueueItem(
  item: LegacyQueueItem,
  actor: ActorContext,
  space = KINETIX_SPACE,
): Promise<ShadowDivergence[]> {
  const base = { targetType: item.targetType, targetId: item.targetId };
  if (!findKnowledgeTargetAdapter(space, item.targetType)) {
    return [{ ...base, kind: 'no_adapter' }];
  }
  const shadow = await buildShadowQueueItem(item, actor, space);
  if (!shadow) return [{ ...base, kind: 'version_missing' }];

  const out: ShadowDivergence[] = [];
  if (shadow.version.targetVersion !== item.targetVersion) {
    out.push({
      ...base,
      kind: 'target_version_mismatch',
      legacy: item.targetVersion,
      shadow: shadow.version.targetVersion,
    });
  }
  if (shadow.version.createdAt !== item.createdAt) {
    out.push({
      ...base,
      kind: 'created_at_mismatch',
      legacy: item.createdAt,
      shadow: shadow.version.createdAt,
    });
  }
  const expectedAuthor =
    item.authorUserId === null ? null : `user:${item.authorUserId}`;
  if (shadow.version.authorRef !== expectedAuthor) {
    out.push({
      ...base,
      kind: 'author_mismatch',
      legacy: expectedAuthor,
      shadow: shadow.version.authorRef,
    });
  }

  const projected = legacyPayloadFromPacket(item.targetType, shadow.packet);
  const legacyPayload = normalise(item.payload) as Record<string, unknown>;
  const shadowPayload = normalise(projected) as Record<string, unknown>;

  for (const [key, legacyValue] of Object.entries(legacyPayload)) {
    if (!(key in shadowPayload)) {
      out.push({ ...base, kind: 'field_missing', field: key, legacy: legacyValue });
    } else if (!sameJson(legacyValue, shadowPayload[key])) {
      out.push({
        ...base,
        kind: 'field_mismatch',
        field: key,
        legacy: legacyValue,
        shadow: shadowPayload[key],
      });
    }
  }
  // An extra field is a finding too, not a bonus: the queue's audience is
  // blind peer reviewers, and anything the adapter adds is something a
  // reviewer was not previously trusted with.
  for (const key of Object.keys(shadowPayload)) {
    if (!(key in legacyPayload)) {
      out.push({ ...base, kind: 'field_extra', field: key, shadow: shadowPayload[key] });
    }
  }
  return out;
}

/** Reconcile a whole served batch. Returns every divergence across every item. */
export async function reconcileQueueBatch(
  items: readonly LegacyQueueItem[],
  actor: ActorContext,
  space = KINETIX_SPACE,
): Promise<ShadowDivergence[]> {
  const perItem = await Promise.all(
    items.map((item) => reconcileQueueItem(item, actor, space)),
  );
  return perItem.flat();
}

/** One-line rendering of a divergence, for a diagnostics log. */
export function describeDivergence(d: ShadowDivergence): string {
  const where = d.field ? `${d.targetType}#${d.targetId}.${d.field}` : `${d.targetType}#${d.targetId}`;
  return `${d.kind} at ${where}: legacy=${JSON.stringify(d.legacy)} shadow=${JSON.stringify(d.shadow)}`;
}
