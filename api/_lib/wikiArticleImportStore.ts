/** Article imports create section headings and stage facts; they never approve. */
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { pendingEdits, wikiPages, wikiRevisions } from "../../db/schema.js";
import { getDb, runInPoolTransaction } from "./db.js";
import { resolveCitation } from "./citation-store.js";
import { isActiveAgentUser } from "./agent-verifications.js";
import { wikiContentFocusRefusal } from "../agent-focus.js";
import { renderHtml, extractPlaintext } from "./tiptap-utils.js";
import { applyAddSection } from "../../src/lib/topicSectionOps.js";
import { extractTopicSections } from "../../src/lib/topicSections.js";
import {
  createFactNode,
  isFactNode,
  type TipTapDoc,
} from "../../src/lib/monographContent.js";
import type {
  WikiArticleBundle,
  WikiArticlePlan,
} from "../../src/lib/wikiArticleImport.js";

export class WikiArticleConflict extends Error {}

type Page = typeof wikiPages.$inferSelect;

function prepare(bundle: WikiArticleBundle, page: Page) {
  if (
    page.pageType !== "topic" ||
    (bundle.page.id != null && bundle.page.id !== page.id)
  ) {
    throw new WikiArticleConflict("page_identity_conflict");
  }
  let doc = (page.content ?? { type: "doc", content: [] }) as TipTapDoc;
  const mapped: WikiArticlePlan["sections"] = [];
  const used = new Set<string>();
  let previousIndex = -1;
  let parentSectionId: string | null = null;
  for (const input of bundle.sections) {
    const current = extractTopicSections(doc);
    const matches = input.sectionId
      ? current.filter((s) => s.sectionId === input.sectionId)
      : current.filter(
          (s) =>
            s.headingText === input.heading && s.headingLevel === input.level,
        );
    if (matches.length > 1)
      throw new WikiArticleConflict(`ambiguous_section:${input.key}`);
    const found = matches[0];
    if (input.sectionId && !found)
      throw new WikiArticleConflict(`section_not_found:${input.sectionId}`);
    if (
      found &&
      (found.headingText !== input.heading ||
        found.headingLevel !== input.level)
    ) {
      throw new WikiArticleConflict(`section_heading_changed:${input.key}`);
    }
    let sectionId: string;
    if (found) {
      sectionId = found.sectionId;
      const index = current.findIndex((s) => s.sectionId === sectionId);
      if (index <= previousIndex)
        throw new WikiArticleConflict(`section_order_conflict:${input.key}`);
      previousIndex = index;
    } else {
      const added = applyAddSection(doc, {
        headingText: input.heading,
        headingLevel: input.level,
        position: previousIndex + 1,
      });
      doc = added.doc;
      sectionId = added.sectionId;
      previousIndex += 1;
    }
    if (used.has(sectionId))
      throw new WikiArticleConflict(`duplicate_section:${input.key}`);
    used.add(sectionId);
    if (input.level === 2) {
      parentSectionId = sectionId;
    } else {
      const layout = extractTopicSections(doc);
      const index = layout.findIndex((s) => s.sectionId === sectionId);
      const parent = layout
        .slice(0, index)
        .reverse()
        .find((s) => s.headingLevel <= 2);
      if (!parentSectionId || parent?.sectionId !== parentSectionId) {
        throw new WikiArticleConflict(`section_parent_conflict:${input.key}`);
      }
    }
    mapped.push({
      key: input.key,
      sectionId,
      heading: input.heading,
      level: input.level,
      create: !found,
      facts: input.facts,
    });
  }
  // Pins both the exact input and the existing content. No client-provided plan is trusted.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        bundle,
        id: page.id,
        title: page.title,
        content: page.content,
      }),
    )
    .digest("hex");
  const plan: WikiArticlePlan = {
    fingerprint,
    pageId: page.id,
    title: page.title,
    sections: mapped,
    factCount: mapped.reduce((n, s) => n + s.facts.length, 0),
    newSectionCount: mapped.filter((s) => s.create).length,
    blockedCount: bundle.blockedCandidates?.length ?? 0,
  };
  return { plan, doc };
}

async function load(bundle: WikiArticleBundle) {
  const [page] = await getDb()
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.slug, bundle.page.slug))
    .limit(1);
  if (!page) throw new WikiArticleConflict("page_not_found");
  return page;
}

export async function planWikiArticle(
  bundle: WikiArticleBundle,
): Promise<WikiArticlePlan> {
  return prepare(bundle, await load(bundle)).plan;
}

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { text?: string; content?: unknown[] };
  return n.text ?? n.content?.map(nodeText).join("") ?? "";
}

export async function applyWikiArticle(
  bundle: WikiArticleBundle,
  userId: number,
  expectedFingerprint: string,
) {
  return runInPoolTransaction(async () => {
    const db = getDb();
    const initial = await load(bundle);
    if (await isActiveAgentUser(userId)) {
      const refusal = await wikiContentFocusRefusal(initial.id);
      if (refusal) throw new WikiArticleConflict(refusal);
    }
    // Share the existing conversation-import queue lock; lock content as well.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`wiki_fact_proposal:${initial.id}`}))`,
    );
    const [page] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, initial.id))
      .for("update");
    if (!page || page.slug !== bundle.page.slug)
      throw new WikiArticleConflict("page_identity_conflict");
    const { plan, doc } = prepare(bundle, page);
    if (plan.fingerprint !== expectedFingerprint)
      throw new WikiArticleConflict("stale_preview");

    const ids = new Map<string, number>();
    const needed = new Set(
      bundle.sections.flatMap((s) => s.facts.flatMap((f) => f.sourceKeys)),
    );
    // These are bibliographic records only: never write or replace a paper review.
    for (const source of [...bundle.sources].sort((a, b) =>
      a.identifier.localeCompare(b.identifier),
    )) {
      if (!needed.has(source.key)) continue;
      const citation = await resolveCitation(db, source, userId);
      ids.set(source.key, citation.id);
    }
    if (plan.newSectionCount > 0) {
      const contentHtml = renderHtml(doc);
      await db
        .update(wikiPages)
        .set({
          content: doc,
          contentHtml,
          contentPlaintext: extractPlaintext(doc),
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, page.id));
      await db.insert(wikiRevisions).values({
        pageId: page.id,
        content: doc,
        contentHtml,
        createdBy: userId,
        editSummary:
          "Opprettet seksjoner for artikkelimport; fakta sendt til review-køen.",
      });
    }
    let skipped = 0;
    const values: Array<typeof pendingEdits.$inferInsert> = [];
    const signature = (sectionId: string, statement: string, refs: number[]) =>
      JSON.stringify([
        sectionId,
        statement,
        [...new Set(refs)].sort((a, b) => a - b),
      ]);
    const open = await db
      .select({
        sectionId: pendingEdits.sectionId,
        statement: pendingEdits.factStatement,
        referenceIds: pendingEdits.referenceIds,
      })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.editType, "wiki_fact"),
          eq(pendingEdits.targetId, page.id),
          eq(pendingEdits.status, "pending"),
          eq(pendingEdits.factOperation, "add"),
        ),
      );
    const queuedSignatures = new Set(
      open.flatMap((row) =>
        row.sectionId && row.statement
          ? [signature(row.sectionId, row.statement, row.referenceIds ?? [])]
          : [],
      ),
    );
    const sections = extractTopicSections(doc);
    for (const section of plan.sections) {
      const published =
        sections.find((s) => s.sectionId === section.sectionId)?.bodyContent ??
        [];
      for (const fact of section.facts) {
        const referenceIds = [
          ...new Set(fact.sourceKeys.map((k) => ids.get(k)!)),
        ].sort((a, b) => a - b);
        const same = (refs: number[]) =>
          JSON.stringify([...new Set(refs)].sort((a, b) => a - b)) ===
          JSON.stringify(referenceIds);
        if (
          published.some(
            (n) =>
              isFactNode(n) &&
              nodeText(n) === fact.statement &&
              same(n.attrs.referenceIds),
          )
        ) {
          skipped += 1;
          continue;
        }
        const key = signature(section.sectionId, fact.statement, referenceIds);
        if (queuedSignatures.has(key)) {
          skipped += 1;
          continue;
        }
        queuedSignatures.add(key);
        values.push({
          editType: "wiki_fact",
          targetId: page.id,
          sectionId: section.sectionId,
          factOperation: "add",
          factStatement: fact.statement,
          proposedValue: createFactNode({
            factId: randomUUID(),
            statement: fact.statement,
            referenceIds,
          }),
          proposedMeta: {
            source: "wiki-article-import",
            idempotencyKey: bundle.idempotencyKey,
            articleDigest: bundle.articleDigest,
            articleFactKey: fact.key,
            articleSectionKey: section.key,
            evidence:
              fact.evidence?.map((e) => ({
                referenceId: ids.get(e.sourceKey),
                locator: e.locator,
              })) ?? [],
            // An empty marker opts into the existing live paper-review gate
            // without claiming that a source is unread or rewriting its review.
            unverifiedReferenceIds: [],
          },
          referenceId: referenceIds[0]!,
          referenceIds,
          status: "pending",
          submittedBy: userId,
        });
      }
    }
    // One insert for the article, rather than two round trips per fact.
    const inserted = values.length
      ? await db
          .insert(pendingEdits)
          .values(values)
          .returning({ id: pendingEdits.id })
      : [];
    return {
      queued: inserted.length,
      skipped,
      newSections: plan.newSectionCount,
      pendingIds: inserted.map((r) => r.id),
    };
  });
}
