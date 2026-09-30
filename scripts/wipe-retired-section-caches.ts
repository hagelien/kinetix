/**
 * One-off cleanup: purge the retired "Saksspesifikke tolkningsmaler"
 * (case_templates) and "Evidenskvalitet og kildenoter" (evidence) monograph
 * sections from the *rendered* page caches, plus the citations that lived
 * only inside them.
 *
 * Why this exists
 * ───────────────
 * Migration 0048 retired both fact categories: it removed them from the
 * monograph schema and stripped `sections.case_templates` / `sections.evidence`
 * from the `content` JSONB on `wiki_pages` and `wiki_revisions`. What it did
 * NOT do is refresh the derived render caches — `wiki_pages.content_html`,
 * `wiki_pages.content_plaintext`, and `wiki_revisions.content_html`. Those
 * columns were last written while the two sections were still part of
 * `MONOGRAPH_SECTIONS`, so they still carry the rendered `<section
 * data-monograph-section="case_templates"…>` / `…="evidence"…>` blocks and the
 * footnote markers for the references those facts cited. The page view, the
 * full-text search index, and the verification-queue diff all read these
 * cached columns, so the retired facts (and their reference superscripts)
 * still appear on pages where they used to be non-empty.
 *
 * What this does (scoped strictly to the two retired sections)
 * ────────────────────────────────────────────────────────────
 *   1. Re-renders `content_html` / `content_plaintext` from the already-clean
 *      `content` JSONB for every page/revision whose cached HTML still carries
 *      a retired `data-monograph-section` block. Because the renderer
 *      (`renderHtml` / `extractPlaintext`) only walks `MONOGRAPH_SECTIONS`, the
 *      regenerated cache drops the retired sections and their reference markers
 *      automatically.
 *   2. Deletes the citations that were referenced ONLY from those retired
 *      blocks — i.e. the reference ids that disappear between the stale cache
 *      and the regenerated render AND are not relied upon by any surviving
 *      fact, parameter, reference-concentration, or pending edit. Citations
 *      still cited elsewhere are kept; only the stale superscript marker goes.
 *
 * This is deliberately NOT a global orphan sweep (see
 * `wipe-orphaned-citations.ts` for that). It only touches rows tied to the two
 * retired categories.
 *
 * Safety
 * ──────
 * - Destructive and not auto-reversible. Take a Neon snapshot before running
 *   with `--apply`.
 * - Dry-run by default. Re-running after `--apply` is a no-op (no rows still
 *   carry the retired markers).
 * - All FK columns into `citations.id` are `ON DELETE SET NULL`, and the
 *   delete set is filtered to references no live source still anchors, so the
 *   delete never nulls out a live link.
 *
 * Usage
 * ─────
 *   DATABASE_URL=… npx tsx scripts/wipe-retired-section-caches.ts            # dry-run
 *   DATABASE_URL=… npx tsx scripts/wipe-retired-section-caches.ts --apply
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, inArray, isNotNull, like, or } from 'drizzle-orm';
import {
  citations,
  drugIonizationConstants,
  drugParameterRevisions,
  pendingEdits,
  referenceConcentrations,
  wikiPages,
  wikiRevisions,
} from '../db/schema';
import { extractPlaintext, renderHtml } from '../api/_lib/tiptap-utils';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

/** Reference ids rendered into a cached HTML string (footnote + fact markers). */
function refIdsFromHtml(html: string | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!html) return out;
  for (const m of html.matchAll(/data-reference-id="(\d+)"/g)) {
    out.add(Number(m[1]));
  }
  for (const m of html.matchAll(/data-fact-refs="([\d,]+)"/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const n = Number(part);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  }
  return out;
}

/** Reference ids anchored in a TipTap node tree. */
function walkNode(node: unknown, ids: Set<number>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as {
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
  if (Array.isArray(n.marks)) for (const m of n.marks) walkNode(m, ids);
  if (Array.isArray(n.content)) for (const c of n.content) walkNode(c, ids);
}

/** Reference ids anchored in a `wiki_*.content` value (v2 envelope or v1 doc). */
function collectFromContent(content: unknown, ids: Set<number>): void {
  if (!content || typeof content !== 'object') return;
  const env = content as {
    sections?: Record<
      string,
      | { body?: unknown; fields?: Record<string, { body?: unknown; refs?: unknown }> }
      | null
      | undefined
    >;
  };
  if (env.sections && typeof env.sections === 'object') {
    for (const section of Object.values(env.sections)) {
      if (!section) continue;
      if (section.body) walkNode(section.body, ids);
      if (section.fields) {
        for (const field of Object.values(section.fields)) {
          if (!field) continue;
          if (field.body) walkNode(field.body, ids);
          if (Array.isArray(field.refs)) {
            for (const id of field.refs) if (typeof id === 'number') ids.add(id);
          }
        }
      }
    }
    return;
  }
  walkNode(content, ids);
}

// Both cached renders are filtered the same way. Drizzle brands a column with
// its table, so the parameter has to name both — annotating it with only
// `wikiPages` made the `wikiRevisions` call below a type error.
const RETIRED_HTML = (
  col: typeof wikiPages.contentHtml | typeof wikiRevisions.contentHtml,
) =>
  or(
    like(col, '%data-monograph-section="case_templates"%'),
    like(col, '%data-monograph-section="evidence"%'),
  );

async function main(): Promise<void> {
  const client = neon(DATABASE_URL!);
  const db = drizzle(client);

  // ── 1. Live citation ids (anything still relied upon) ─────────────────────
  // Computed from the already-clean content, so anything cited only inside a
  // retired section is absent here and therefore deletable.
  const live = new Set<number>();
  for (const row of await db
    .select({ content: wikiPages.content })
    .from(wikiPages)) {
    collectFromContent(row.content, live);
  }
  for (const row of await db
    .select({ content: wikiRevisions.content })
    .from(wikiRevisions)) {
    collectFromContent(row.content, live);
  }
  for (const row of await db
    .select({
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
    })
    .from(drugParameterRevisions)) {
    if (typeof row.referenceId === 'number') live.add(row.referenceId);
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }
  for (const row of await db
    .select({ citationId: referenceConcentrations.citationId })
    .from(referenceConcentrations)
    .where(isNotNull(referenceConcentrations.citationId))) {
    if (typeof row.citationId === 'number') live.add(row.citationId);
  }
  for (const row of await db
    .select({
      referenceId: pendingEdits.referenceId,
      referenceIds: pendingEdits.referenceIds,
    })
    .from(pendingEdits)) {
    if (typeof row.referenceId === 'number') live.add(row.referenceId);
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }
  // Ionization constants carry provenance in a no-FK reference_ids array, so a
  // citation cited only there would otherwise be deleted as orphaned.
  for (const row of await db
    .select({ referenceIds: drugIonizationConstants.referenceIds })
    .from(drugIonizationConstants)
    .where(isNotNull(drugIonizationConstants.referenceIds))) {
    if (Array.isArray(row.referenceIds)) {
      for (const id of row.referenceIds) if (typeof id === 'number') live.add(id);
    }
  }

  // ── 2. Pages whose cached render still carries a retired section ──────────
  const pages = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      content: wikiPages.content,
      contentHtml: wikiPages.contentHtml,
    })
    .from(wikiPages)
    .where(RETIRED_HTML(wikiPages.contentHtml));

  const droppedRefs = new Set<number>();
  const pageUpdates: Array<{
    id: number;
    slug: string;
    contentHtml: string;
    contentPlaintext: string;
  }> = [];
  for (const page of pages) {
    const freshHtml = renderHtml(page.content);
    const freshPlain = extractPlaintext(page.content);
    for (const id of refIdsFromHtml(page.contentHtml)) {
      if (!refIdsFromHtml(freshHtml).has(id)) droppedRefs.add(id);
    }
    pageUpdates.push({
      id: page.id,
      slug: page.slug,
      contentHtml: freshHtml,
      contentPlaintext: freshPlain,
    });
  }

  // ── 3. Revisions whose cached render still carries a retired section ──────
  const revisions = await db
    .select({
      id: wikiRevisions.id,
      pageId: wikiRevisions.pageId,
      content: wikiRevisions.content,
      contentHtml: wikiRevisions.contentHtml,
    })
    .from(wikiRevisions)
    .where(RETIRED_HTML(wikiRevisions.contentHtml));

  const revisionUpdates: Array<{ id: number; contentHtml: string }> = [];
  for (const rev of revisions) {
    const freshHtml = renderHtml(rev.content);
    for (const id of refIdsFromHtml(rev.contentHtml)) {
      if (!refIdsFromHtml(freshHtml).has(id)) droppedRefs.add(id);
    }
    revisionUpdates.push({ id: rev.id, contentHtml: freshHtml });
  }

  // ── 4. References cited only inside retired sections ──────────────────────
  const orphanRefIds = [...droppedRefs].filter((id) => !live.has(id)).sort((a, b) => a - b);
  const keptRefIds = [...droppedRefs].filter((id) => live.has(id)).sort((a, b) => a - b);
  const orphanRows = orphanRefIds.length
    ? await db
        .select({ id: citations.id, type: citations.type, identifier: citations.identifier })
        .from(citations)
        .where(inArray(citations.id, orphanRefIds))
    : [];

  console.log(
    `pages to re-render: ${pageUpdates.length} | revisions to re-render: ${revisionUpdates.length}`,
  );
  console.log(
    `references dropped from retired sections: ${droppedRefs.size} | orphaned (delete): ${orphanRefIds.length} | still cited elsewhere (keep row): ${keptRefIds.length}`,
  );

  if (dryRun) {
    for (const p of pageUpdates) {
      console.log(`[dry-run] re-render page ${p.id} (${p.slug})`);
    }
    console.log(`[dry-run] re-render ${revisionUpdates.length} revision(s)`);
    for (const o of orphanRows) {
      console.log(`[dry-run] delete citation id=${o.id} ${o.type}:${o.identifier}`);
    }
    if (keptRefIds.length) {
      console.log(`[dry-run] keep (still cited): ${keptRefIds.join(', ')}`);
    }
    console.log('[dry-run] re-run with --apply to persist.');
    return;
  }

  for (const p of pageUpdates) {
    await db
      .update(wikiPages)
      .set({ contentHtml: p.contentHtml, contentPlaintext: p.contentPlaintext })
      .where(eq(wikiPages.id, p.id));
  }
  for (const r of revisionUpdates) {
    await db
      .update(wikiRevisions)
      .set({ contentHtml: r.contentHtml })
      .where(eq(wikiRevisions.id, r.id));
  }
  if (orphanRefIds.length) {
    const chunkSize = 500;
    for (let i = 0; i < orphanRefIds.length; i += chunkSize) {
      const chunk = orphanRefIds.slice(i, i + chunkSize);
      await db.delete(citations).where(inArray(citations.id, chunk));
    }
  }
  console.log(
    `applied: re-rendered ${pageUpdates.length} page(s), ${revisionUpdates.length} revision(s); deleted ${orphanRefIds.length} orphaned citation(s).`,
  );
}

main().catch((err) => {
  console.error('wipe-retired-section-caches failed:', err);
  process.exit(1);
});
