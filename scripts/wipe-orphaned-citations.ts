/**
 * One-off cleanup: delete citations that no live data source still references.
 *
 * Why this exists
 * ───────────────
 * After `wipe-legacy-summary-content.ts` cleared the legacy `summary.body`
 * TipTap content from migrated v2 monographs, every footnote / fact reference
 * embedded in that prose lost its anchor. The `citations` rows themselves
 * are still in the DB, so the bibliography surfaces strays that no current
 * page links to. Issue #282 calls for wiping those orphans so the rebuilt
 * monographs only carry references their parameters and remaining body
 * actually cite.
 *
 * Live citation sources (anything in this set is preserved):
 *   - `wiki_pages.content`  — fact `attrs.referenceIds`, footnote
 *     `attrs.referenceId`, field-level `refs[]`
 *   - `wiki_revisions.content` — same shape, historical snapshots
 *   - `drug_parameter_revisions.reference_id` and `reference_ids`
 *   - `reference_concentrations.citation_id`
 *   - `pending_edits.reference_id` and `reference_ids`
 *   - `drug_ionization_constants.reference_ids`
 *
 * Anything else is considered orphan and deleted.
 *
 * Safety
 * ──────
 * - Destructive and not auto-reversible. Take a Neon snapshot before
 *   running with `--apply`.
 * - Dry-run by default. Re-running after `--apply` is a no-op.
 * - All the FK columns into `citations.id` are `ON DELETE SET NULL`, but
 *   the orphan filter excludes every row referenced by those columns
 *   anyway, so the delete should never null out a live link.
 *
 * Usage
 * ─────
 *   DATABASE_URL=… npx tsx scripts/wipe-orphaned-citations.ts            # dry-run
 *   DATABASE_URL=… npx tsx scripts/wipe-orphaned-citations.ts --apply
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { inArray, isNotNull } from 'drizzle-orm';
import {
  citations,
  drugIonizationConstants,
  drugParameterRevisions,
  pendingEdits,
  referenceConcentrations,
  wikiPages,
  wikiRevisions,
} from '../db/schema';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

/**
 * Walk a TipTap node (or any of its children) and collect every citation
 * id we recognise. Two shapes carry references in monograph bodies:
 *   - fact nodes:      `attrs.referenceIds: number[]`
 *   - footnote nodes:  `attrs.referenceId: number`
 * Anything else just recurses.
 */
function walkTipTapNode(node: unknown, ids: Set<number>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as {
    type?: string;
    attrs?: { referenceId?: unknown; referenceIds?: unknown };
    content?: unknown[];
    marks?: unknown[];
  };
  const refIds = n.attrs?.referenceIds;
  if (Array.isArray(refIds)) {
    for (const id of refIds) if (typeof id === 'number') ids.add(id);
  }
  const refId = n.attrs?.referenceId;
  if (typeof refId === 'number') ids.add(refId);
  if (Array.isArray(n.marks)) {
    for (const mark of n.marks) walkTipTapNode(mark, ids);
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) walkTipTapNode(child, ids);
  }
}

/**
 * Walk a `wiki_pages.content` / `wiki_revisions.content` value. Modern
 * rows are v2 envelopes (`{ version, sections: { [id]: { body?, fields? } } }`);
 * pre-migration rows are bare TipTap docs. Treat both.
 */
function collectFromMonographContent(content: unknown, ids: Set<number>): void {
  if (!content || typeof content !== 'object') return;
  const envelope = content as {
    sections?: Record<
      string,
      | {
          body?: unknown;
          fields?: Record<string, { body?: unknown; refs?: unknown }>;
        }
      | null
      | undefined
    >;
  };
  if (envelope.sections && typeof envelope.sections === 'object') {
    for (const section of Object.values(envelope.sections)) {
      if (!section) continue;
      if (section.body) walkTipTapNode(section.body, ids);
      if (section.fields) {
        for (const field of Object.values(section.fields)) {
          if (!field) continue;
          if (field.body) walkTipTapNode(field.body, ids);
          if (Array.isArray(field.refs)) {
            for (const id of field.refs) if (typeof id === 'number') ids.add(id);
          }
        }
      }
    }
    return;
  }
  // Fallback: legacy bare TipTap doc.
  walkTipTapNode(content, ids);
}

async function main(): Promise<void> {
  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  const live = new Set<number>();

  // 1. Active monograph bodies
  const pages = await db
    .select({ id: wikiPages.id, content: wikiPages.content })
    .from(wikiPages);
  for (const row of pages) collectFromMonographContent(row.content, live);

  // 2. Wiki revision history
  const revisions = await db
    .select({ id: wikiRevisions.id, content: wikiRevisions.content })
    .from(wikiRevisions);
  for (const row of revisions) collectFromMonographContent(row.content, live);

  // 3. Parameter revisions (single + array)
  const paramRevs = await db
    .select({
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
    })
    .from(drugParameterRevisions);
  for (const row of paramRevs) {
    if (typeof row.referenceId === 'number') live.add(row.referenceId);
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }

  // 4. Reference concentrations
  const concRows = await db
    .select({ citationId: referenceConcentrations.citationId })
    .from(referenceConcentrations)
    .where(isNotNull(referenceConcentrations.citationId));
  for (const row of concRows) {
    if (typeof row.citationId === 'number') live.add(row.citationId);
  }

  // 5. Pending edits (single + array)
  const pending = await db
    .select({
      referenceId: pendingEdits.referenceId,
      referenceIds: pendingEdits.referenceIds,
    })
    .from(pendingEdits);
  for (const row of pending) {
    if (typeof row.referenceId === 'number') live.add(row.referenceId);
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }

  // 6. Ionization constants (reference_ids array; no FK, so the cascade never
  //    reaches it — a source cited only here would be wrongly deleted otherwise)
  const ionRows = await db
    .select({ referenceIds: drugIonizationConstants.referenceIds })
    .from(drugIonizationConstants)
    .where(isNotNull(drugIonizationConstants.referenceIds));
  for (const row of ionRows) {
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }

  // 7. All current citation ids
  const allCitations = await db
    .select({ id: citations.id, type: citations.type, identifier: citations.identifier })
    .from(citations);

  const orphans = allCitations.filter((c) => !live.has(c.id));

  console.log(
    `citations total: ${allCitations.length} | live: ${live.size} | orphans: ${orphans.length}`,
  );

  if (orphans.length === 0) {
    console.log('nothing to do.');
    return;
  }

  if (dryRun) {
    for (const o of orphans.slice(0, 25)) {
      console.log(`[dry-run] would delete id=${o.id} type=${o.type} identifier=${o.identifier}`);
    }
    if (orphans.length > 25) {
      console.log(`[dry-run] … and ${orphans.length - 25} more`);
    }
    console.log(`[dry-run] would delete ${orphans.length} orphan citation(s). Re-run with --apply.`);
    return;
  }

  // Delete in chunks so a huge orphan list doesn't blow past parameter limits.
  const ids = orphans.map((o) => o.id);
  const chunkSize = 500;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await db.delete(citations).where(inArray(citations.id, chunk));
    deleted += chunk.length;
  }
  console.log(`deleted ${deleted} orphan citation(s).`);
}

main().catch((err) => {
  console.error('wipe-orphaned-citations failed:', err);
  process.exit(1);
});
