import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock("../../api/_lib/db.js", () => ({
  getDb: getDbMock,
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from "../../api/agent-rejection-scan.ts";

function createRequest(): IncomingMessage {
  return {
    method: "GET",
    url: "/api/agent-rejection-scan",
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

function query(rows: unknown[], whereCalls: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((predicate: unknown) => {
      whereCalls.push(predicate);
      return chain;
    }),
    orderBy: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

describe("GET /api/agent-rejection-scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests before querying", async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const select = vi.fn();
    getDbMock.mockReturnValue({ select });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("filters rejected edits to agent submitters in SQL before limiting, marking the response non-cacheable", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    const whereCalls: unknown[] = [];
    const select = vi
      .fn()
      .mockReturnValueOnce(query([{ id: 12 }], whereCalls))
      .mockReturnValueOnce(query([{ agentNotes: "prior ledger" }], whereCalls))
      .mockReturnValueOnce(
        query(
          [
            {
              id: 99,
              editType: "parameter",
              targetId: 42,
              parameter: "halfLife",
              rejectionReason: "unsupported",
              rejectionComment: "No primary source",
              reviewedAt: new Date("2026-07-16T10:00:00.000Z"),
              submittedBy: 7,
            },
          ],
          whereCalls,
        ),
      );
    const batch = vi.fn(async (queries: Array<Promise<unknown>>) =>
      Promise.all(queries),
    );
    getDbMock.mockReturnValue({ select, batch });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(select).toHaveBeenCalledTimes(3);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    const rejectionPredicateSql = new PgDialect().sqlToQuery(
      whereCalls[2] as SQL,
    ).sql;
    expect(rejectionPredicateSql).toContain(
      '"pending_edits"."submitted_by" IN (SELECT user_id FROM agents)',
    );
    expect(rejectionPredicateSql).toContain('"pending_edits"."reviewed_at" >');
    expect(JSON.parse(state.body)).toEqual({
      priorLedger: "prior ledger",
      rejections: [
        expect.objectContaining({
          id: 99,
          submittedBy: 7,
        }),
      ],
    });
  });
});
