import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock("../../api/_lib/db.js", () => ({ getDb: getDbMock }));
vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from "../../api/drug-indicators.ts";

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
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

function mockWikiPageDb(
  pageRows: Array<{ status: string }>,
  commentRows: Array<{ parameter: string | null; count: number }> = [],
) {
  const limit = vi.fn().mockResolvedValue(pageRows);
  const pageWhere = vi.fn().mockReturnValue({ limit });
  const commentGroupBy = vi.fn().mockResolvedValue(commentRows);
  const commentWhere = vi.fn().mockReturnValue({ groupBy: commentGroupBy });
  let selectCall = 0;
  const select = vi.fn(() => {
    selectCall += 1;
    return {
      from: vi.fn().mockReturnValue({
        where: selectCall === 1 ? pageWhere : commentWhere,
      }),
    };
  });
  const db = { select };
  getDbMock.mockReturnValue(db);
  return { select, commentWhere };
}

describe("GET /api/drug-indicators?wikiPageId=", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose draft page comment indicators to anonymous callers", async () => {
    const { select } = mockWikiPageDb(
      [{ status: "draft" }],
      [{ parameter: "fact:secret", count: 2 }],
    );
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest("/api/drug-indicators?wikiPageId=42"), res);

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toMatchObject({
      code: "wiki_page_not_found",
    });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps published page indicators public-cacheable", async () => {
    mockWikiPageDb(
      [{ status: "published" }],
      [
        { parameter: "fact:visible", count: 3 },
        { parameter: null, count: 10 },
      ],
    );
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest("/api/drug-indicators?wikiPageId=7"), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      comments: { "fact:visible": 3 },
      refs: {},
    });
    expect(state.headers["Cache-Control"]).toContain("public");
  });

  it("allows editors to read draft page indicators without shared caching", async () => {
    mockWikiPageDb(
      [{ status: "draft" }],
      [{ parameter: "fact:draft", count: 1 }],
    );
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: "editor" });
    const { res, state } = createResponse();

    await handler(createRequest("/api/drug-indicators?wikiPageId=9"), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      comments: { "fact:draft": 1 },
      refs: {},
    });
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });
});
