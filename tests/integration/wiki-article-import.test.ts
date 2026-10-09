import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentFocusConfig,
  citations,
  paperReviews,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from "../../db/schema.js";
import { wikiArticleSchema } from "../../src/lib/wikiArticleImport.js";
import {
  applyWikiArticle,
  planWikiArticle,
} from "../../api/_lib/wikiArticleImportStore.js";
import { extractTopicSections } from "../../src/lib/topicSections.js";
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from "./setup/harness.js";
import { seedUser } from "./setup/seed.js";

let db: IntegrationDb;
let userId: number;
let pageId: number;
const content = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { sectionId: "existing", level: 2 },
      content: [{ type: "text", text: "Bakgrunn" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Bevar eksisterende tekst." }],
    },
  ],
};
function bundle() {
  return wikiArticleSchema.parse({
    schemaVersion: "kinetix-wiki-article-v1",
    idempotencyKey: "test",
    articleDigest: "a".repeat(64),
    createdAt: "2026-10-09T00:00:00Z",
    page: { slug: "test", id: pageId },
    sources: [{ key: "S1", type: "doi", identifier: "10.1093/jat/bkae097" }],
    sections: [
      {
        key: "intro",
        sectionId: "existing",
        heading: "Bakgrunn",
        level: 2,
        facts: [
          { key: "F1", statement: "Første testpåstand.", sourceKeys: ["S1"] },
        ],
      },
      {
        key: "new",
        heading: "Påvisningstid",
        level: 3,
        facts: [
          {
            key: "F2",
            statement: "Andre testpåstand.",
            sourceKeys: ["S1"],
            evidence: [{ sourceKey: "S1", locator: "Tabell 2" }],
          },
        ],
      },
    ],
  });
}
beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(teardownIntegrationDb);
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db, { role: "admin" });
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: "test",
      title: "Test",
      content,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  pageId = page!.id;
});

describe("wiki article imports", () => {
  it("keeps the agent-focus gate before all writes", async () => {
    await db
      .insert(agents)
      .values({
        userId,
        name: "Testagent",
        slug: "testagent",
        status: "active",
      });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: "all", skipWikiContent: true });
    const b = bundle();
    await expect(
      applyWikiArticle(b, userId, (await planWikiArticle(b)).fingerprint),
    ).rejects.toThrow();
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });
  it("refuses to place an existing H3 beneath the wrong H2", async () => {
    const headings = [
      {
        type: "heading",
        attrs: { sectionId: "other", level: 2 },
        content: [{ type: "text", text: "Annet tema" }],
      },
      {
        type: "heading",
        attrs: { sectionId: "child", level: 3 },
        content: [{ type: "text", text: "Påvisningstid" }],
      },
    ];
    await db
      .update(wikiPages)
      .set({
        content: { type: "doc", content: [...content.content, ...headings] },
      })
      .where(eq(wikiPages.id, pageId));
    const b = bundle();
    b.sections[1]!.sectionId = "child";
    await expect(planWikiArticle(b)).rejects.toThrow("section_parent_conflict");
  });
  it("previews without writes; queues every fact with references and stable section IDs", async () => {
    const b = bundle();
    const plan = await planWikiArticle(b);
    expect(plan.newSectionCount).toBe(1);
    expect(await db.select().from(citations)).toHaveLength(0);
    const result = await applyWikiArticle(b, userId, plan.fingerprint);
    expect(result.queued).toBe(2);
    const edits = await db.select().from(pendingEdits);
    expect(edits.map((e) => e.status)).toEqual(["pending", "pending"]);
    expect(edits.map((e) => e.sectionId)).toEqual([
      "existing",
      plan.sections[1]!.sectionId,
    ]);
    expect(edits.every((e) => e.referenceIds?.length === 1)).toBe(true);
    expect(edits[1]!.proposedMeta).toMatchObject({
      evidence: [{ referenceId: edits[1]!.referenceId, locator: "Tabell 2" }],
    });
    const [page] = await db.select().from(wikiPages);
    const sections = extractTopicSections(page!.content as typeof content);
    expect(sections[0]!.bodyContent).toEqual(content.content.slice(1));
    expect(sections[1]!.bodyContent).toEqual([]);
    expect(await db.select().from(wikiRevisions)).toHaveLength(1);
    expect(await db.select().from(paperReviews)).toHaveLength(0);
  });

  it("does not overwrite a read-in-full review or publish verified-source facts", async () => {
    const [citation] = await db
      .insert(citations)
      .values({
        type: "doi",
        identifier: bundle().sources[0]!.identifier,
        createdBy: userId,
      })
      .returning();
    await db.insert(paperReviews).values({
      citationId: citation!.id,
      readInFull: true,
      reviewMarkdown: "Bevar faglig vurdering.",
      createdBy: userId,
      updatedBy: userId,
    });
    const before = await db.select().from(paperReviews);
    const b = bundle();
    await applyWikiArticle(b, userId, (await planWikiArticle(b)).fingerprint);
    expect(await db.select().from(paperReviews)).toEqual(before);
    expect(
      (await db.select().from(pendingEdits)).every(
        (e) => e.status === "pending",
      ),
    ).toBe(true);
  });

  it("is idempotent after a new preview, including newly created sections", async () => {
    const b = bundle();
    await applyWikiArticle(b, userId, (await planWikiArticle(b)).fingerprint);
    const second = await planWikiArticle(b);
    expect(second.newSectionCount).toBe(0);
    expect(await applyWikiArticle(b, userId, second.fingerprint)).toMatchObject(
      { queued: 0, skipped: 2, newSections: 0 },
    );
    expect(await db.select().from(pendingEdits)).toHaveLength(2);
  });

  it("refuses stale preview and altered input before any writes", async () => {
    const b = bundle();
    const plan = await planWikiArticle(b);
    b.sections[0]!.facts[0]!.statement = "Endret påstand.";
    await expect(applyWikiArticle(b, userId, plan.fingerprint)).rejects.toThrow(
      "stale_preview",
    );
    b.sections[0]!.facts[0]!.statement = "Første testpåstand.";
    await db
      .update(wikiPages)
      .set({ title: "Endret tittel" })
      .where(eq(wikiPages.id, pageId));
    await expect(applyWikiArticle(b, userId, plan.fingerprint)).rejects.toThrow(
      "stale_preview",
    );
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
  });

  it("refuses wrong identity, missing IDs and wrong heading order", async () => {
    const b = bundle();
    b.page.id = pageId + 1;
    await expect(planWikiArticle(b)).rejects.toThrow("page_identity_conflict");
    b.page.id = pageId;
    b.sections[0]!.sectionId = "nonexistent";
    await expect(planWikiArticle(b)).rejects.toThrow("section_not_found");
  });

  it("rolls back citations and headings if a later write fails", async () => {
    const b = bundle();
    // Valid preview; the missing actor violates the revision foreign key.
    await expect(
      applyWikiArticle(b, 99999, (await planWikiArticle(b)).fingerprint),
    ).rejects.toThrow();
    expect(await db.select().from(citations)).toHaveLength(0);
    expect(await db.select().from(pendingEdits)).toHaveLength(0);
    expect((await db.select().from(wikiPages))[0]!.content).toEqual(content);
  });
});
