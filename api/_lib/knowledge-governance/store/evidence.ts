/**
 * `kg_evidence_items` and `kg_evidence_links` (§5.5, §5.6).
 *
 * Not in the plan's Phase 3 file list, which names eight modules and no
 * evidence one — but §5.5 and §5.6 are two of the thirteen tables, and leaving
 * them without a store would mean the only way to write evidence is raw SQL at
 * a call site.
 *
 * An evidence item is deliberately *not* a copy of a Kinetix citation. Kinetix
 * maps `citations.id` in through `externalRef` plus a `kg_legacy_links` row:
 * duplicating title, authors, DOI and PDF state into a second table would
 * create a second thing that can be wrong, and citation metadata is already
 * corrected in place by the crossref/datacite resolvers.
 *
 * The kinds are generic on purpose (§9.1) — `scientific_paper`, `web_page`,
 * `dataset`, `code_test`, `expert_statement`. A governance core that only
 * understands "citation" cannot govern a knowledge space whose evidence is a
 * passing test or a regulator's letter.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { kgEvidenceItems, kgEvidenceLinks } from '../../../../db/governance-schema.js';
import type {
  EvidenceLinkInput,
  GovernanceDb,
  SubjectType,
} from './interface.js';

export interface EvidenceItemRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly kind: string;
  readonly externalRef: string | null;
  readonly locator: unknown;
  readonly metadata: unknown;
  readonly contentHash: string | null;
  readonly createdAt: Date;
}

export interface EvidenceLinkRecord {
  readonly id: number;
  readonly evidenceItemId: number;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly relation: string;
  readonly quote: string | null;
  readonly createdAt: Date;
}

const ITEM_COLUMNS = {
  id: kgEvidenceItems.id,
  spaceId: kgEvidenceItems.spaceId,
  kind: kgEvidenceItems.kind,
  externalRef: kgEvidenceItems.externalRef,
  locator: kgEvidenceItems.locator,
  metadata: kgEvidenceItems.metadata,
  contentHash: kgEvidenceItems.contentHash,
  createdAt: kgEvidenceItems.createdAt,
} as const;

const LINK_COLUMNS = {
  id: kgEvidenceLinks.id,
  evidenceItemId: kgEvidenceLinks.evidenceItemId,
  subjectType: kgEvidenceLinks.subjectType,
  subjectId: kgEvidenceLinks.subjectId,
  relation: kgEvidenceLinks.relation,
  quote: kgEvidenceLinks.quote,
  createdAt: kgEvidenceLinks.createdAt,
} as const;

/**
 * Find or create the evidence item for one external reference.
 *
 * Keyed on `(spaceId, kind, externalRef)` — the same triple the partial index
 * covers — so mirroring the same citation from ten proposals produces one item
 * with ten links, not ten items. An item with no `externalRef` has nothing to
 * deduplicate on and is always inserted fresh; that is the honest behaviour for
 * a free-text expert statement, which is not the same statement just because it
 * was filed twice.
 */
export async function ensureEvidenceItem(
  db: GovernanceDb,
  args: {
    spaceId: number;
    kind: string;
    externalRef?: string | null;
    locator?: unknown;
    metadata?: unknown;
    contentHash?: string | null;
  },
): Promise<EvidenceItemRecord> {
  if (args.externalRef) {
    const existing = await findEvidenceItem(db, {
      spaceId: args.spaceId,
      kind: args.kind,
      externalRef: args.externalRef,
    });
    if (existing) return existing;
  }
  const [row] = await db
    .insert(kgEvidenceItems)
    .values({
      spaceId: args.spaceId,
      kind: args.kind,
      externalRef: args.externalRef ?? null,
      locator: args.locator ?? null,
      metadata: args.metadata ?? null,
      contentHash: args.contentHash ?? null,
    })
    .returning(ITEM_COLUMNS);
  return row as EvidenceItemRecord;
}

export async function findEvidenceItem(
  db: GovernanceDb,
  args: { spaceId: number; kind: string; externalRef: string },
): Promise<EvidenceItemRecord | null> {
  const [row] = await db
    .select(ITEM_COLUMNS)
    .from(kgEvidenceItems)
    .where(
      and(
        eq(kgEvidenceItems.spaceId, args.spaceId),
        eq(kgEvidenceItems.kind, args.kind),
        eq(kgEvidenceItems.externalRef, args.externalRef),
      ),
    )
    .limit(1);
  return (row as EvidenceItemRecord | undefined) ?? null;
}

/** Attach evidence to a version, assessment, dispute or decision. */
export async function linkEvidence(
  db: GovernanceDb,
  args: EvidenceLinkInput,
): Promise<EvidenceLinkRecord> {
  const [row] = await db
    .insert(kgEvidenceLinks)
    .values({
      evidenceItemId: args.evidenceItemId,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      relation: args.relation,
      quote: args.quote ?? null,
      locator: args.locator ?? null,
    })
    .returning(LINK_COLUMNS);
  return row as EvidenceLinkRecord;
}

/** The evidence attached to one subject, with the item it points at. */
export async function evidenceForSubject(
  db: GovernanceDb,
  args: { subjectType: SubjectType; subjectId: number },
): Promise<Array<{ link: EvidenceLinkRecord; item: EvidenceItemRecord }>> {
  const links = (await db
    .select(LINK_COLUMNS)
    .from(kgEvidenceLinks)
    .where(
      and(
        eq(kgEvidenceLinks.subjectType, args.subjectType),
        eq(kgEvidenceLinks.subjectId, args.subjectId),
      ),
    )
    .orderBy(asc(kgEvidenceLinks.id))) as EvidenceLinkRecord[];
  if (links.length === 0) return [];

  const items = (await db
    .select(ITEM_COLUMNS)
    .from(kgEvidenceItems)
    .where(
      inArray(
        kgEvidenceItems.id,
        links.map((l) => l.evidenceItemId),
      ),
    )) as EvidenceItemRecord[];
  const byId = new Map(items.map((i) => [i.id, i]));

  const out: Array<{ link: EvidenceLinkRecord; item: EvidenceItemRecord }> = [];
  for (const link of links) {
    const item = byId.get(link.evidenceItemId);
    // A link whose item was deleted cannot happen — the FK cascades — but
    // skipping rather than asserting keeps a read path from throwing on data
    // it could still partially explain.
    if (item) out.push({ link, item });
  }
  return out;
}
