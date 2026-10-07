/**
 * Facts from the paper fact-extraction queue are exempt from the admin
 * agent-focus gate — on proof of a live claim, not on the agent's say-so.
 *
 * The production complaint this closes: with "Ikke skriv monograf- eller
 * wikiinnhold" ticked, the extractor refused to claim anything, so papers an
 * editor had deliberately queued sat at "I kø" forever. An editor queuing a
 * paper is a narrower, more recent instruction than the standing focus.
 *
 * The exemption must not become a general bypass, so the other half of this
 * file pins what it requires: the caller's own live claim, the matching
 * token, and a fact that cites the job's paper.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("../../api/_lib/auth.js", () => ({ getUserFromRequest: authMock }));

import handler from "../../api/pending-edits.js";
import {
  agentFocusConfig,
  agents,
  paperExtractionJobs,
  wikiPages,
} from "../../db/schema.js";
import { STALE_CLAIM_MS } from "../../src/lib/paperExtraction.js";
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from "./setup/harness.js";
import { seedAdmissibleCitation, seedUser } from "./setup/seed.js";

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authMock.mockReset();
});

const TOKEN = "a".repeat(32);

async function seedAuthor(): Promise<number> {
  return await seedUser(db, {
    email: "author@example.com",
    username: "author",
  });
}

async function seedPage(authorId: number): Promise<number> {
  const [row] = await db
    .insert(wikiPages)
    .values({
      slug: "a-page",
      title: "A page",
      content: {},
      pageType: "drug_monograph",
      status: "published",
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });
  return row!.id;
}

async function seedAgent(slug = "extractor"): Promise<number> {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: "contributor",
  });
  await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: "active" });
  return userId;
}

async function seedClaimedJob(
  citationId: number,
  claimedBy: number,
  claimedAt: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .insert(paperExtractionJobs)
    .values({
      citationId,
      status: "claimed",
      claimedBy,
      claimedAt,
      claimToken: TOKEN,
      attempts: 1,
    })
    .returning({ id: paperExtractionJobs.id });
  return row!.id;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: "" };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? "";
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function createJsonRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = "POST";
  req.url = "/api/pending-edits";
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(raw)),
  };
  return req;
}

async function submitFact(
  userId: number,
  pageId: number,
  referenceId: number,
  paperExtraction?: { jobId: number; claimToken: string },
) {
  authMock.mockResolvedValue({ userId, role: "contributor" });
  const { res, state } = createResponse();
  await handler(
    createJsonRequest({
      editType: "wiki_fact",
      targetId: pageId,
      sectionId: "pk",
      factOperation: "add",
      factStatement:
        "Halveringstiden er 30–56 timer hos voksne etter peroral dosering.",
      referenceIds: [referenceId],
      ...(paperExtraction ? { paperExtraction } : {}),
    }),
    res,
  );
  return state;
}

describe("POST /api/pending-edits — paper-extraction focus exemption", () => {
  it("lets a fact under a live claim past skipWikiContent", async () => {
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(citationId, agent);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: "all", skipWikiContent: true });

    // The control: without the block the same fact is refused.
    const refused = await submitFact(agent, page, citationId);
    expect(refused.statusCode).toBe(403);

    const state = await submitFact(agent, page, citationId, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.body).not.toContain("agent_focus_out_of_scope");
    expect(state.statusCode).not.toBe(403);
  });

  it("lets a fact under a live claim past mode=parameters", async () => {
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(citationId, agent);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: "parameters", parameters: ["halfLife"] });

    const state = await submitFact(agent, page, citationId, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.body).not.toContain("agent_focus_out_of_scope");
    expect(state.statusCode).not.toBe(403);
  });

  it("refuses a wrong claim token with 409", async () => {
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(citationId, agent);

    const state = await submitFact(agent, page, citationId, {
      jobId,
      claimToken: "b".repeat(32),
    });
    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: "paper_extraction_not_claim_holder",
    });
  });

  it("refuses a claim held by another identity", async () => {
    const author = await seedAuthor();
    const holder = await seedAgent("holder");
    const other = await seedAgent("other");
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(citationId, holder);

    const state = await submitFact(other, page, citationId, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.statusCode).toBe(409);
  });

  it("refuses a stale claim", async () => {
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(
      citationId,
      agent,
      new Date(Date.now() - STALE_CLAIM_MS - 60_000),
    );

    const state = await submitFact(agent, page, citationId, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.statusCode).toBe(409);
  });

  it("refuses a cancelled job, so an editor cancel binds mid-run", async () => {
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const citationId = await seedAdmissibleCitation(db, { createdBy: author });
    const jobId = await seedClaimedJob(citationId, agent);
    await db.update(paperExtractionJobs).set({ status: "cancelled" });

    const state = await submitFact(agent, page, citationId, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.statusCode).toBe(409);
  });

  it("refuses a fact that does not cite the job paper", async () => {
    // Holding a claim on one paper must not unlock unscoped writes
    // sourced from another.
    const author = await seedAuthor();
    const agent = await seedAgent();
    const page = await seedPage(author);
    const jobCitation = await seedAdmissibleCitation(db, { createdBy: author });
    const otherCitation = await seedAdmissibleCitation(db, {
      createdBy: author,
      identifier: "99999999",
    });
    const jobId = await seedClaimedJob(jobCitation, agent);
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: "all", skipWikiContent: true });

    const state = await submitFact(agent, page, otherCitation, {
      jobId,
      claimToken: TOKEN,
    });
    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: "paper_extraction_reference_mismatch",
    });
  });
});
