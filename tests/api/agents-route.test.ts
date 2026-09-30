import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock("../../api/_lib/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/_lib/db.js")>();
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from "../../api/agents.ts";

const dialect = new PgDialect();

function createGetRequest(): IncomingMessage {
  const req = {} as IncomingMessage;
  req.method = "GET";
  req.url = "/api/agents";
  req.headers = { host: "localhost" };
  return req;
}

function createResponse() {
  const state = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string | number | readonly string[]>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (
        statusCode: number,
        headers?: Record<string, string | number | readonly string[]>,
      ) => {
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
  } as unknown as ServerResponse & {
    headersSent: boolean;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  return { res, state };
}

interface MockedDbResult {
  whereCalls: SQL[];
}

function mockDb(opts: {
  agentRows: Array<Record<string, unknown>>;
  userRows: Array<Record<string, unknown>>;
  statsRows: Array<Record<string, unknown>>;
}): MockedDbResult {
  const whereCalls: SQL[] = [];

  // Agent listing: select().from().innerJoin().where().orderBy()
  const agentOrderBy = vi.fn().mockResolvedValue(opts.agentRows);
  const agentWhere = vi.fn((arg: SQL) => {
    whereCalls.push(arg);
    return { orderBy: agentOrderBy };
  });
  const agentInnerJoin = vi.fn().mockReturnValue({ where: agentWhere });
  const agentFrom = vi.fn().mockReturnValue({ innerJoin: agentInnerJoin });

  // User lookup: select().from().where()
  const userWhere = vi.fn((arg: SQL) => {
    whereCalls.push(arg);
    return Promise.resolve(opts.userRows);
  });
  const userFrom = vi.fn().mockReturnValue({ where: userWhere });

  // Stats: select().from().where().groupBy()
  const statsGroupBy = vi.fn().mockResolvedValue(opts.statsRows);
  const statsWhere = vi.fn((arg: SQL) => {
    whereCalls.push(arg);
    return { groupBy: statsGroupBy };
  });
  const statsFrom = vi.fn().mockReturnValue({ where: statsWhere });

  // Drizzle picks the right chain by sequence of select() calls. The
  // handler issues exactly three selects in order: agents, users, stats.
  const select = vi
    .fn()
    .mockReturnValueOnce({ from: agentFrom })
    .mockReturnValueOnce({ from: userFrom })
    .mockReturnValueOnce({ from: statsFrom });

  getDbMock.mockReturnValue({ select });
  return { whereCalls };
}

describe("GET /api/agents — WHERE clauses use IN (…), not = ANY((…))", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: "authenticated",
    });
  });

  it("compiles the user and stats lookups as IN (…) (regression for #659)", async () => {
    // Two agents — one with a maintainer, one without — exercises the
    // allUserIds dedupe path and a non-empty agentUserIds set.
    const agentRows = [
      {
        id: 11,
        name: "Alpha",
        nameEn: "Alpha",
        slug: "alpha",
        description: null,
        descriptionEn: null,
        status: "active",
        createdAt: new Date("2026-06-01T00:00:00Z"),
        agentUserId: 8,
        maintainerUserId: 4,
      },
      {
        id: 12,
        name: "Beta",
        nameEn: "Beta",
        slug: "beta",
        description: null,
        descriptionEn: null,
        status: "active",
        createdAt: new Date("2026-06-02T00:00:00Z"),
        agentUserId: 1,
        maintainerUserId: null,
      },
    ];
    const userRows = [
      { id: 8, username: "alpha", displayName: "Alpha" },
      { id: 4, username: "maintainer-1", displayName: "M1" },
      { id: 1, username: "beta", displayName: "Beta" },
    ];
    const statsRows = [
      { submittedBy: 8, status: "pending", count: 2 },
      { submittedBy: 1, status: "approved", count: 3 },
    ];

    const { whereCalls } = mockDb({ agentRows, userRows, statsRows });

    const { res, state } = createResponse();
    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(whereCalls.length).toBe(3);

    // The user lookup (call #2) and the stats query (call #3) are the two
    // that previously used `sql\`... = ANY(${jsArray})\`` and emitted
    // `= ANY(($1, $2, $3))` — a row constructor that Postgres rejects with
    // "op ANY/ALL (array) requires array on right side". Verify the
    // compiled SQL now uses the `IN (…)` form from inArray().
    const userSql = dialect.sqlToQuery(whereCalls[1]).sql;
    const statsSql = dialect.sqlToQuery(whereCalls[2]).sql;
    for (const compiled of [userSql, statsSql]) {
      expect(compiled).toMatch(/\bin\s*\(/i);
      expect(compiled).not.toMatch(/\bany\s*\(/i);
    }
  });

  it("marks empty authenticated agent listings no-store", async () => {
    mockDb({ agentRows: [], userRows: [], statsRows: [] });

    const { res, state } = createResponse();
    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body)).toEqual({ agents: [] });
  });
});
