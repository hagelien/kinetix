import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, getUserFromRequestMock, resolveActiveAgentMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    resolveActiveAgentMock: vi.fn(),
  }));

vi.mock("../../api/_lib/db.js", () => ({
  getDb: getDbMock,
}));

vi.mock("../../api/_lib/auth.js", () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock("../../api/_lib/agent-verifications.js", () => ({
  resolveActiveAgent: resolveActiveAgentMock,
}));

import handler, {
  appliedViaPriority,
  resolveAppliedVia,
} from "../../api/agent-audit-sample";

function createRequest(url: string, method = "GET"): IncomingMessage {
  return { method, url, headers: { host: "localhost" } } as IncomingMessage;
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

describe("resolveAppliedVia", () => {
  it("classifies a revision with no originating pending edit as direct", () => {
    expect(resolveAppliedVia(null, null)).toBe("direct");
  });

  it("classifies a pending-edit-backed revision reviewed by an agent as agent_applied", () => {
    expect(resolveAppliedVia(42, 7)).toBe("agent_applied");
  });

  it("classifies a pending-edit-backed revision reviewed by a human as human_reviewed", () => {
    expect(resolveAppliedVia(42, null)).toBe("human_reviewed");
  });
});

describe("appliedViaPriority", () => {
  it("ranks agent_applied ahead of human_reviewed and direct", () => {
    expect(appliedViaPriority("agent_applied")).toBeLessThan(
      appliedViaPriority("human_reviewed"),
    );
    expect(appliedViaPriority("human_reviewed")).toBeLessThan(
      appliedViaPriority("direct"),
    );
  });
});

describe("GET /api/agent-audit-sample route — auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-GET method", async () => {
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-audit-sample", "POST"), res);
    expect(state.statusCode).toBe(405);
  });

  it("rejects an unauthenticated caller", async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-audit-sample"), res);
    expect(state.statusCode).toBe(401);
  });

  it("rejects a caller with no active agent identity", async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: "contributor" });
    resolveActiveAgentMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("/api/agent-audit-sample"), res);
    expect(state.statusCode).toBe(403);
  });

  it("rejects an invalid since date", async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: "contributor" });
    resolveActiveAgentMock.mockResolvedValue({
      id: 1,
      userId: 1,
      slug: "t2-agent",
      selfReviewEnabled: false,
    });
    const { res, state } = createResponse();
    await handler(
      createRequest("/api/agent-audit-sample?since=not-a-date"),
      res,
    );
    expect(state.statusCode).toBe(400);
  });
});
