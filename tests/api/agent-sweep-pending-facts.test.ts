import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getNeonClientMock, getUserFromRequestMock } = vi.hoisted(
  () => ({
    getDbMock: vi.fn(),
    getNeonClientMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
  }),
);

vi.mock("../../api/_lib/db.js", () => ({
  getDb: getDbMock,
  getNeonClient: getNeonClientMock,
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from "../../api/agent-sweep.ts";

function createRequest(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: { host: "localhost" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string; headers: Record<string, unknown> };
} {
  const state = { statusCode: 200, body: "", headers: {} };
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

/** Mock the active-agent lookup: db.select(...).from(...).where(...).limit(1). */
function mockAgentLookup(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  getDbMock.mockReturnValue({ select });
}

describe("GET /api/agent-sweep?mode=pending_facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    mockAgentLookup([{ id: 42 }]);
  });

  it("rejects a request with no targetId", async () => {
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-sweep?mode=pending_facts"), res);
    expect(state.statusCode).toBe(400);
    expect(state.body).toContain("targetId");
  });

  it("rejects a non-positive-integer targetId", async () => {
    const sqlSpy = vi.fn();
    getNeonClientMock.mockReturnValue(sqlSpy);
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_facts&targetId=abc"),
      res,
    );
    expect(state.statusCode).toBe(400);
    // The allowlisted query must never run against bad input.
    expect(sqlSpy).not.toHaveBeenCalled();
  });

  it("returns the page-wide pending facts when no sectionId is given", async () => {
    const rows = [
      { id: 1, section_id: "pd", fact_operation: "add", fact_statement: "A" },
    ];
    const sqlSpy = vi.fn().mockResolvedValue(rows);
    getNeonClientMock.mockReturnValue(sqlSpy);

    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_facts&targetId=15"),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body)).toEqual({ pendingFacts: rows });
    expect(sqlSpy).toHaveBeenCalledTimes(1);
    // The interpolated values include the numeric page id (no section filter).
    const values = sqlSpy.mock.calls[0].slice(1);
    expect(values).toContain(15);
  });

  it("passes the sectionId into the query when provided", async () => {
    const sqlSpy = vi.fn().mockResolvedValue([]);
    getNeonClientMock.mockReturnValue(sqlSpy);

    const { res, state } = createResponse();
    await handler(
      createRequest(
        "/api/agent-sweep?mode=pending_facts&targetId=15&sectionId=pd",
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body)).toEqual({ pendingFacts: [] });
    const values = sqlSpy.mock.calls[0].slice(1);
    expect(values).toContain(15);
    expect(values).toContain("pd");
  });

  it("requires an active agent token", async () => {
    mockAgentLookup([]); // no active agent row
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_facts&targetId=15"),
      res,
    );
    expect(state.statusCode).toBe(403);
  });
});

describe("GET /api/agent-sweep?mode=pending_parameters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    mockAgentLookup([{ id: 42 }]);
  });

  it("rejects a request with no targetId", async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters"),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toContain("targetId");
  });

  it("rejects a non-positive-integer targetId without running the query", async () => {
    const sqlSpy = vi.fn();
    getNeonClientMock.mockReturnValue(sqlSpy);
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters&targetId=abc"),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(sqlSpy).not.toHaveBeenCalled();
  });

  it("returns the drug-wide open pending parameter edits across all contributors", async () => {
    const rows = [
      {
        id: 1,
        parameter: "bloodPlasmaRatio",
        proposed_value: { value: 0.6 },
        submitted_by: 9,
      },
    ];
    const sqlSpy = vi.fn().mockResolvedValue(rows);
    getNeonClientMock.mockReturnValue(sqlSpy);

    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters&targetId=42"),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body)).toEqual({
      pendingParameters: rows,
      pendingParameterEntries: rows,
      pendingParameterEntriesTruncated: false,
    });
    // One query per lane; both are scoped to the numeric drug id.
    expect(sqlSpy).toHaveBeenCalledTimes(2);
    for (const call of sqlSpy.mock.calls) {
      expect(call.slice(1)).toContain(42);
    }
  });

  it("lists open param_entry creates as a separate lane from parameter edits", async () => {
    const entries = [
      {
        id: 5,
        parameter: "halfLife",
        proposed_value: { op: "create", input: { centralValue: 7.3 } },
        reference_id: 11,
        submitted_by: 9,
      },
    ];
    const sqlSpy = vi
      .fn()
      .mockImplementation((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join("?").includes("'param_entry'") ? entries : [],
        ),
      );
    getNeonClientMock.mockReturnValue(sqlSpy);

    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters&targetId=42"),
      res,
    );

    expect(JSON.parse(state.body)).toEqual({
      pendingParameters: [],
      pendingParameterEntries: entries,
      pendingParameterEntriesTruncated: false,
    });
    const entrySql = sqlSpy.mock.calls
      .map(([strings]) => (strings as TemplateStringsArray).join("?"))
      .find((text) => text.includes("'param_entry'"));
    expect(entrySql).toContain("'create'");
    expect(entrySql).toContain("status = 'pending'");
  });

  it("signals truncation and caps the entry lane at the limit", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: i + 1,
      parameter: "halfLife",
    }));
    const sqlSpy = vi
      .fn()
      .mockImplementation((strings: TemplateStringsArray) =>
        Promise.resolve(strings.join("?").includes("'param_entry'") ? many : []),
      );
    getNeonClientMock.mockReturnValue(sqlSpy);
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters&targetId=42"),
      res,
    );
    const body = JSON.parse(state.body);
    expect(body.pendingParameterEntriesTruncated).toBe(true);
    expect(body.pendingParameterEntries).toHaveLength(200);
  });

  it("passes the parameter and citation filters to the entry query", async () => {
    const sqlSpy = vi.fn().mockResolvedValue([]);
    getNeonClientMock.mockReturnValue(sqlSpy);
    const { res } = createResponse();
    await handler(
      createRequest(
        "/api/agent-sweep?mode=pending_parameters&targetId=42&parameter=halfLife&citationId=11",
      ),
      res,
    );
    const entryCall = sqlSpy.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join("?").includes("'param_entry'"),
    );
    expect(entryCall!.slice(1)).toEqual(
      expect.arrayContaining([42, "halfLife", 11]),
    );
  });

  it("rejects a malformed citationId", async () => {
    const sqlSpy = vi.fn();
    getNeonClientMock.mockReturnValue(sqlSpy);
    const { res, state } = createResponse();
    await handler(
      createRequest(
        "/api/agent-sweep?mode=pending_parameters&targetId=42&citationId=x",
      ),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(sqlSpy).not.toHaveBeenCalled();
  });

  it("requires an active agent token", async () => {
    mockAgentLookup([]);
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-sweep?mode=pending_parameters&targetId=42"),
      res,
    );
    expect(state.statusCode).toBe(403);
  });
});
