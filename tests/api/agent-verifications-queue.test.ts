import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getUserFromRequestMock, resolveActiveAgentMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    resolveActiveAgentMock: vi.fn(),
  }));

// getDb() is only invoked inside request handlers, never at import time, but
// mock it so importing the queue module never touches a real connection.
vi.mock("../../api/_lib/db.js", () => ({
  getDb: getDbMock,
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock("../../api/_lib/agent-verifications.js", () => ({
  resolveActiveAgent: resolveActiveAgentMock,
}));

import {
  collectQueueCandidates,
  notAuthoredByCaller,
  pendingEditPageHydrationFor,
  selectQueueBatch,
  unverifiedByAgent,
} from "../../api/agent-verifications-queue";
import handler from "../../api/agent-verifications-queue";
import {
  paperReviews,
  pendingEdits,
  type AgentVerificationTargetType,
} from "../../db/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

type Item = {
  targetType: AgentVerificationTargetType;
  targetId: number;
  createdAt: string;
};

const item = (
  targetType: AgentVerificationTargetType,
  targetId: number,
  createdAt: string,
): Item => ({ targetType, targetId, createdAt });

const types = (batch: Item[]) => batch.map((b) => b.targetType);
const ids = (batch: Item[]) => batch.map((b) => b.targetId);

function createRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: { host: "localhost" },
  } as IncomingMessage;
}

function createResponse() {
  const state = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        res.headersSent = true;
        return res;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? "";
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

function emptyCandidateDb() {
  const limit = vi.fn().mockResolvedValue([]);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

describe("GET /api/agent-verifications-queue route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks successful agent queue reads as non-cacheable", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({
      id: 42,
      slug: "kinetix-agent",
      selfReviewEnabled: false,
    });
    getDbMock.mockReturnValue(emptyCandidateDb());

    const { res, state } = createResponse();
    await handler(
      createRequest(
        "/api/agent-verifications-queue?targetType=drug_discussion",
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body)).toEqual({
      items: [],
      agent: { id: 42, slug: "kinetix-agent", selfReviewEnabled: false },
    });
  });

  // An agent that can review its own work needs to be told so: meeting its own
  // submission in the queue is otherwise indistinguishable from a bug.
  it("echoes the agent's self-review grant back to it", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({
      id: 42,
      slug: "kinetix-agent",
      selfReviewEnabled: true,
    });
    getDbMock.mockReturnValue(emptyCandidateDb());

    const { res, state } = createResponse();
    await handler(
      createRequest(
        "/api/agent-verifications-queue?targetType=drug_discussion",
      ),
      res,
    );

    expect(JSON.parse(state.body).agent).toEqual({
      id: 42,
      slug: "kinetix-agent",
      selfReviewEnabled: true,
    });
  });
});

describe("author-exclusion predicates", () => {
  const dialect = new PgDialect();
  const render = (frag: SQL | undefined): string =>
    frag ? dialect.sqlToQuery(frag).sql : "";

  it("excludes the caller's own rows by default", () => {
    const frag = notAuthoredByCaller(pendingEdits.submittedBy, {
      agentUserId: 7,
      selfReviewEnabled: false,
    });
    expect(frag).toBeDefined();
    expect(render(frag)).toContain("submitted_by");
  });

  it("drops the filter entirely for a self-review agent", () => {
    // `undefined` is the point: and() discards it, so the query is the same
    // one every other agent runs, minus the author restriction.
    expect(
      notAuthoredByCaller(pendingEdits.submittedBy, {
        agentUserId: 7,
        selfReviewEnabled: true,
      }),
    ).toBeUndefined();
  });

  it("keeps NULL authors passing on the nullable form", () => {
    // ne() is false for NULL in Postgres, which would silently drop rows whose
    // author is unrecorded — they cannot be the caller.
    const frag = notAuthoredByCaller(
      paperReviews.createdBy,
      { agentUserId: 7, selfReviewEnabled: false },
      { nullable: true },
    );
    expect(render(frag)).toContain("is null");
  });

  it("ignores the submitter's implicit stake when self-review is on", () => {
    // Without this the flag is inert: every self-submitted row already carries
    // an implicit-approve row, so the NOT EXISTS would hide it anyway.
    expect(
      dialect.sqlToQuery(
        unverifiedByAgent("pending_edit", pendingEdits.id, 42, {
          ignoreImplicit: true,
        }),
      ).sql,
    ).toContain("is_implicit");
    expect(
      dialect.sqlToQuery(unverifiedByAgent("pending_edit", pendingEdits.id, 42))
        .sql,
    ).not.toContain("is_implicit");
  });
});

describe("selectQueueBatch", () => {
  it("reserves half the batch for pending edits buried behind an older backlog", () => {
    // The bug: 25 April–May revision/discussion rows are all older than the
    // 5 (later-May) pending edits, so a pure oldest-first slice(0,5) served
    // zero pending edits and the consensus apply-path never fired.
    const revisions = Array.from({ length: 25 }, (_, i) =>
      item(
        "drug_parameter_revision",
        100 + i,
        `2026-05-0${1}T0${i % 9}:00:00.000Z`,
      ),
    );
    const pendings = Array.from({ length: 5 }, (_, i) =>
      item("pending_edit", 200 + i, `2026-05-24T1${i}:00:00.000Z`),
    );
    const batch = selectQueueBatch([...revisions, ...pendings], 5);

    expect(batch).toHaveLength(5);
    const pendingCount = batch.filter(
      (b) => b.targetType === "pending_edit",
    ).length;
    // ceil(5 * 0.5) = 3 guaranteed pending-edit slots.
    expect(pendingCount).toBe(3);
    // …and they are the three OLDEST pending edits.
    expect(ids(batch.filter((b) => b.targetType === "pending_edit"))).toEqual([
      200, 201, 202,
    ]);
  });

  it("reserves slots for paper reviews buried behind an older backlog (the 06-2026 starvation)", () => {
    // The incident: a ~1k-item older wiki_revision/drug_discussion backlog plus
    // the pending-edit reserve consumed every slot, so fresh paper_review rows
    // (uniformly newer than the backlog) were never served and peer verification
    // of paper reviews flatlined for days.
    const wiki = Array.from({ length: 30 }, (_, i) =>
      item(
        "wiki_revision",
        100 + i,
        `2026-05-20T00:${String(i).padStart(2, "0")}:00.000Z`,
      ),
    );
    const pendings = Array.from({ length: 10 }, (_, i) =>
      item("pending_edit", 200 + i, `2026-06-20T0${i % 9}:00:00.000Z`),
    );
    const papers = Array.from({ length: 5 }, (_, i) =>
      item("paper_review", 300 + i, `2026-06-23T0${i}:00:00.000Z`),
    );
    const batch = selectQueueBatch([...wiki, ...pendings, ...papers], 20);

    // pending_edit keeps its half-batch reserve (ceil(20*0.5)=10)...
    expect(batch.filter((b) => b.targetType === "pending_edit")).toHaveLength(
      10,
    );
    // ...and paper_review now gets a guaranteed quarter (ceil(20*0.25)=5)
    // instead of zero — all 5 fresh reviews are served despite the older wiki
    // backlog that would otherwise win every backfill slot.
    expect(ids(batch.filter((b) => b.targetType === "paper_review"))).toEqual([
      300, 301, 302, 303, 304,
    ]);
    // The remaining slots go oldest-first to the wiki backlog.
    expect(batch.filter((b) => b.targetType === "wiki_revision")).toHaveLength(
      5,
    );
    expect(batch).toHaveLength(20);
  });

  it("caps the paper-review reserve at how many paper reviews exist", () => {
    // Only one paper review available: it takes a single reserved slot and the
    // rest of the batch falls back to the older backlog, no slots wasted.
    const wiki = Array.from({ length: 30 }, (_, i) =>
      item(
        "wiki_revision",
        100 + i,
        `2026-05-20T00:${String(i).padStart(2, "0")}:00.000Z`,
      ),
    );
    const batch = selectQueueBatch(
      [...wiki, item("paper_review", 999, "2026-06-23T00:00:00.000Z")],
      8,
    );
    expect(batch.filter((b) => b.targetType === "paper_review")).toHaveLength(
      1,
    );
    expect(batch.filter((b) => b.targetType === "wiki_revision")).toHaveLength(
      7,
    );
    expect(batch).toHaveLength(8);
  });

  it("caps the reserve at how many pending edits exist (drained backlog cedes slots)", () => {
    const revisions = Array.from({ length: 10 }, (_, i) =>
      item("wiki_revision", 300 + i, `2026-05-10T0${i % 9}:00:00.000Z`),
    );
    const batch = selectQueueBatch(
      [...revisions, item("pending_edit", 999, "2026-05-24T00:00:00.000Z")],
      5,
    );
    expect(batch).toHaveLength(5);
    expect(batch.filter((b) => b.targetType === "pending_edit")).toHaveLength(
      1,
    );
    expect(batch.filter((b) => b.targetType === "wiki_revision")).toHaveLength(
      4,
    );
  });

  it("falls back to plain oldest-first when there are no pending edits", () => {
    const revisions = [
      item("wiki_revision", 1, "2026-05-03T00:00:00.000Z"),
      item("drug_parameter_revision", 2, "2026-05-01T00:00:00.000Z"),
      item("drug_discussion", 3, "2026-05-02T00:00:00.000Z"),
    ];
    expect(ids(selectQueueBatch(revisions, 2))).toEqual([2, 3]);
  });

  it("is equivalent to oldest-first for a single-type request (pending_edit only)", () => {
    const pendings = Array.from({ length: 6 }, (_, i) =>
      item("pending_edit", i, `2026-05-2${i}T00:00:00.000Z`),
    );
    expect(ids(selectQueueBatch(pendings, 3))).toEqual([0, 1, 2]);
  });

  it("is equivalent to oldest-first for a single non-pending type", () => {
    const revs = Array.from({ length: 6 }, (_, i) =>
      item("paper_review", i, `2026-05-2${i}T00:00:00.000Z`),
    );
    expect(types(selectQueueBatch(revs, 3))).toEqual([
      "paper_review",
      "paper_review",
      "paper_review",
    ]);
    expect(ids(selectQueueBatch(revs, 3))).toEqual([0, 1, 2]);
  });

  it("never returns more than limit and never duplicates a candidate", () => {
    const batch = selectQueueBatch(
      [
        item("pending_edit", 1, "2026-05-24T00:00:00.000Z"),
        item("pending_edit", 2, "2026-05-25T00:00:00.000Z"),
        item("wiki_revision", 3, "2026-05-01T00:00:00.000Z"),
        item("wiki_revision", 4, "2026-05-02T00:00:00.000Z"),
      ],
      3,
    );
    expect(batch.length).toBeLessThanOrEqual(3);
    expect(new Set(ids(batch)).size).toBe(batch.length);
  });

  it("returns an empty batch for a non-positive limit", () => {
    expect(
      selectQueueBatch(
        [item("pending_edit", 1, "2026-05-24T00:00:00.000Z")],
        0,
      ),
    ).toEqual([]);
  });
});

describe("collectQueueCandidates", () => {
  it("flattens results from every type when all fetches succeed", async () => {
    const out = await collectQueueCandidates(
      ["wiki_revision", "pending_edit"],
      async (type) => [`${type}-a`, `${type}-b`],
    );
    expect(out).toEqual([
      "wiki_revision-a",
      "wiki_revision-b",
      "pending_edit-a",
      "pending_edit-b",
    ]);
  });

  it("drops a type whose fetch throws and still serves the others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Mirrors the real incident: learning_unit_revision's table is absent, so
    // its fetch rejects — but pending_edit (and the rest) must still be served.
    const out = await collectQueueCandidates(
      ["learning_unit_revision", "pending_edit", "wiki_revision"],
      async (type) => {
        if (type === "learning_unit_revision") {
          throw new Error('relation "learning_unit_revisions" does not exist');
        }
        return [`${type}#1`];
      },
    );
    expect(out).toEqual(["pending_edit#1", "wiki_revision#1"]);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("learning_unit_revision");
    spy.mockRestore();
  });

  it("returns an empty list when every type fails (never rejects)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await collectQueueCandidates(
      ["wiki_revision", "pending_edit"],
      async () => {
        throw new Error("boom");
      },
    );
    expect(out).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("pendingEditPageHydrationFor", () => {
  it("hydrates rendered HTML only for whole-page wiki edits", () => {
    expect(pendingEditPageHydrationFor("wiki_page")).toBe("full");
  });

  it("keeps fact and section verification payloads to structured content", () => {
    expect(pendingEditPageHydrationFor("wiki_fact")).toBe("content");
    expect(pendingEditPageHydrationFor("wiki_section")).toBe("content");
  });

  it("skips page hydration for non-wiki pending edits", () => {
    expect(pendingEditPageHydrationFor("parameter")).toBe("none");
    expect(pendingEditPageHydrationFor("paper_review")).toBe("none");
  });
});
