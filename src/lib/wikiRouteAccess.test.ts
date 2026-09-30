import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/_lib/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: vi.fn(),
}));

vi.mock("../../api/_lib/approvals.js", () => ({
  summariseApprovalsForTargets: vi.fn(async () => new Map()),
}));

import pagesHandler from "../../api/wiki/pages.ts";
import historyHandler from "../../api/wiki/history.ts";
import { getDb } from "../../api/_lib/db.js";
import { getUserFromRequest } from "../../api/_lib/auth.js";

function createRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {
      host: "localhost",
    },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  status: () => number | undefined;
  headers: () => Record<string, unknown>;
  json: () => Record<string, unknown>;
} {
  let statusCode: number | undefined;
  let body = "";
  let headers: Record<string, unknown> = {};

  const res = {
    headersSent: false,
    writeHead: vi.fn((code: number, nextHeaders?: Record<string, unknown>) => {
      statusCode = code;
      headers = nextHeaders ?? {};
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      body = chunk ?? "";
      return res;
    }),
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    headers: () => headers,
    json: () => JSON.parse(body),
  };
}

function mockDbSelectSequence(results: unknown[]): void {
  const queue = [...results];

  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  Object.assign(builder, {
    from: vi.fn(chain),
    leftJoin: vi.fn(chain),
    innerJoin: vi.fn(chain),
    where: vi.fn(chain),
    orderBy: vi.fn(chain),
    limit: vi.fn(chain),
    offset: vi.fn(chain),
    then: vi.fn((resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve(queue.shift())),
    ),
  });

  const select = vi.fn(() => builder);

  vi.mocked(getDb).mockReturnValue({
    select,
  } as unknown as ReturnType<typeof getDb>);
}

function tiptapText(text: string): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

describe("wiki route access control", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 404 for draft pages when the requester is not privileged", async () => {
    mockDbSelectSequence([
      [
        {
          id: 1,
          slug: "secret-draft",
          title: "Secret draft",
          content: null,
          contentHtml: "<p>draft</p>",
          pageType: "topic",
          drugCid: null,
          status: "draft",
          createdAt: new Date(),
          updatedAt: new Date(),
          updatedBy: { username: "admin" },
        },
      ],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const response = createResponse();
    await pagesHandler(
      createRequest("/api/wiki/pages?slug=secret-draft"),
      response.res,
    );

    expect(response.status()).toBe(404);
    expect(response.json()).toEqual({ error: "Page not found" });
  });

  it("allows editors to fetch draft page history without revision bodies", async () => {
    mockDbSelectSequence([
      [{ id: 2, title: "Internal page", status: "draft" }],
      [
        {
          id: 9,
          editSummary: "Initial draft",
          createdAt: new Date("2026-04-18T10:00:00Z"),
          createdBy: { username: "editor" },
        },
      ],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 7,
      role: "editor",
    });

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=internal-page"),
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({
      pageTitle: "Internal page",
      revisions: [
        {
          id: 9,
          editSummary: "Initial draft",
          createdBy: { username: "editor" },
        },
      ],
      hasMore: false,
    });
    expect(response.json().revisions).toEqual([
      expect.not.objectContaining({ content: expect.anything() }),
    ]);
    expect(response.headers()["Cache-Control"]).toBe("no-store");
    const db = vi.mocked(getDb).mock.results[0]?.value as {
      select: ReturnType<typeof vi.fn>;
    };
    expect(db.select).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ content: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("detects more history without running a count query", async () => {
    mockDbSelectSequence([
      [{ id: 2, title: "Internal page", status: "draft" }],
      [
        {
          id: 11,
          editSummary: "Current",
          createdAt: new Date("2026-04-19T10:00:00Z"),
          createdBy: { username: "editor" },
        },
        {
          id: 10,
          editSummary: "Previous",
          createdAt: new Date("2026-04-18T10:00:00Z"),
          createdBy: { username: "editor" },
        },
      ],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 7,
      role: "editor",
    });

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=internal-page&limit=1"),
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({
      revisions: [
        {
          id: 11,
          editSummary: "Current",
          createdBy: { username: "editor" },
        },
      ],
      hasMore: true,
    });
    expect(response.headers()["Cache-Control"]).toBe("no-store");
    const db = vi.mocked(getDb).mock.results[0]?.value as {
      select: ReturnType<typeof vi.fn>;
    };
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("blocks revision diff bodies from public published history", async () => {
    mockDbSelectSequence([
      [{ id: 3, title: "Public page", status: "published" }],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=public-page&revisionId=10"),
      response.res,
    );

    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: "wiki.diffReviewerRequired" });
  });

  it("allows editors to fetch one revision diff", async () => {
    mockDbSelectSequence([
      [{ id: 2, title: "Internal page", status: "draft" }],
      [{ id: 9, content: tiptapText("alpha delta gamma") }],
      [{ content: tiptapText("alpha beta gamma") }],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 7,
      role: "editor",
    });

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=internal-page&revisionId=9"),
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({
      revisionId: 9,
      diff: [
        { type: "same", text: "alpha" },
        { type: "removed", text: "beta" },
        { type: "added", text: "delta" },
        { type: "same", text: "gamma" },
      ],
    });
    expect(response.headers()["Cache-Control"]).toBe("no-store");
  });

  it("prevents caching signed-in published history because approval state is personalized", async () => {
    mockDbSelectSequence([
      [{ id: 3, title: "Public page", status: "published" }],
      [
        {
          id: 10,
          editSummary: "Public revision",
          createdAt: new Date("2026-04-20T10:00:00Z"),
          createdBy: { username: "editor" },
        },
      ],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 7,
      role: "authenticated",
    });

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=public-page"),
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["Cache-Control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      pageTitle: "Public page",
      revisions: [
        {
          id: 10,
          editSummary: "Public revision",
          createdBy: { username: "editor" },
        },
      ],
    });
  });

  it("rejects oversized revision diffs before building the matrix", async () => {
    const longText = Array.from({ length: 501 }, (_, i) => `word${i}`).join(
      " ",
    );
    mockDbSelectSequence([
      [{ id: 2, title: "Internal page", status: "draft" }],
      [{ id: 9, content: tiptapText(longText) }],
      [{ content: tiptapText(longText) }],
    ]);
    vi.mocked(getUserFromRequest).mockResolvedValue({
      userId: 7,
      role: "editor",
    });

    const response = createResponse();
    await historyHandler(
      createRequest("/api/wiki/history?slug=internal-page&revisionId=9"),
      response.res,
    );

    expect(response.status()).toBe(413);
    expect(response.json()).toEqual({ error: "wiki.diffTooLarge" });
  });
});
