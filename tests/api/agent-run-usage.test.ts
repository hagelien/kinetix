import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_WORKFLOWS,
  createAgentRunUsageSchema,
} from "../../api/_lib/schemas";

// ─── Schema ────────────────────────────────────────────────────────────────

describe("createAgentRunUsageSchema", () => {
  const base = {
    workflow: "producer",
    runtime: "claude-code",
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 80000,
  };

  it("accepts a minimal row and a full row", () => {
    expect(createAgentRunUsageSchema.safeParse(base).success).toBe(true);
    expect(
      createAgentRunUsageSchema.safeParse({
        ...base,
        model: "claude-sonnet-5",
        sessionId: "b7863388-ade4-59b5-ae1c-247d9846a3d5",
        startedAt: "2026-09-28T10:00:00.000Z",
        durationMs: 45000,
        notes: "one cycle",
      }).success,
    ).toBe(true);
  });

  it("covers every tiered workflow level", () => {
    expect(AGENT_RUN_WORKFLOWS).toEqual(
      expect.arrayContaining(["producer", "escalation", "adjudication"]),
    );
  });

  it("rejects negative or fractional token counts", () => {
    expect(
      createAgentRunUsageSchema.safeParse({ ...base, inputTokens: -1 }).success,
    ).toBe(false);
    expect(
      createAgentRunUsageSchema.safeParse({ ...base, outputTokens: 1.5 })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown workflow or runtime", () => {
    expect(
      createAgentRunUsageSchema.safeParse({ ...base, workflow: "cleanup" })
        .success,
    ).toBe(false);
    expect(
      createAgentRunUsageSchema.safeParse({ ...base, runtime: "cursor" })
        .success,
    ).toBe(false);
  });

  it("rejects rows no transcript could produce", () => {
    const parse = (over: Record<string, unknown>) =>
      createAgentRunUsageSchema.safeParse({ ...base, ...over }).success;
    const counts = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 80000,
    };
    // A consistent per-model split is accepted.
    expect(
      parse({
        model: "claude-sonnet-5",
        modelUsage: {
          "claude-sonnet-5": { ...counts, inputTokens: 600 },
          "claude-haiku-4-5": {
            inputTokens: 400,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      }),
    ).toBe(true);
    // A split that does not add up (tokens shifted to a cheaper model's
    // share, or dropped) would misprice the run.
    expect(
      parse({
        modelUsage: {
          "claude-haiku-4-5": { ...counts, outputTokens: 0 },
        },
      }),
    ).toBe(false);
    // The headline model must be part of its own split.
    expect(
      parse({ model: "claude-opus-5", modelUsage: { "claude-haiku-4-5": counts } }),
    ).toBe(false);
    // A run that spent nothing is not a run.
    expect(
      parse({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(false);
    // Timing in the future, or longer than any real run.
    expect(
      parse({ startedAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ).toBe(false);
    expect(
      parse({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 3_600_000,
      }),
    ).toBe(false);
    expect(parse({ durationMs: 2 * 24 * 3_600_000 })).toBe(false);
    expect(
      parse({
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        durationMs: 3_000_000,
      }),
    ).toBe(true);
  });

  it("does not accept a caller-supplied tier (strict)", () => {
    expect(
      createAgentRunUsageSchema.safeParse({ ...base, modelTier: "flagship" })
        .success,
    ).toBe(false);
  });
});

// ─── Route handler ───────────────────────────────────────────────────────────

const {
  getDbMock,
  getUserFromRequestMock,
  resolveActiveAgentMock,
  parseAndValidateMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  resolveActiveAgentMock: vi.fn(),
  parseAndValidateMock: vi.fn(),
}));

vi.mock("../../api/_lib/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/_lib/db.js")>();
  return { ...actual, getDb: getDbMock };
});

vi.mock("../../api/_lib/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../api/_lib/auth.js")>();
  return { ...actual, getUserFromRequest: getUserFromRequestMock };
});

vi.mock("../../api/_lib/agent-verifications.js", () => ({
  resolveActiveAgent: resolveActiveAgentMock,
}));

vi.mock("../../api/_lib/validate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../api/_lib/validate.js")>();
  return { ...actual, parseAndValidate: parseAndValidateMock };
});

import handler from "../../api/agent-run-usage.ts";

function createRequest(method: string): IncomingMessage {
  const req = {} as IncomingMessage;
  req.method = method;
  req.url = "/api/agent-run-usage";
  req.headers = { host: "localhost" };
  return req;
}

function createResponse() {
  const state = { statusCode: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      state.body = body ?? "";
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

function mockInsertDb(returning: Array<Record<string, unknown>>) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const onConflictDoUpdate = vi
    .fn()
    .mockReturnValue({ returning: returningFn });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert, values, onConflictDoUpdate };
}

const validBody = {
  workflow: "escalation",
  runtime: "codex",
  model: "gpt-5.6-sol",
  sessionId: "sess-1",
  inputTokens: 1000,
  outputTokens: 200,
  cacheCreationTokens: 0,
  cacheReadTokens: 80000,
};

describe("agent-run-usage route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects methods other than POST with 405", async () => {
    const { res, state } = createResponse();
    await handler(createRequest("GET"), res);
    expect(state.statusCode).toBe(405);
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("POST"), res);
    expect(state.statusCode).toBe(401);
  });

  it("rejects a human session with 403 even when admin", async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: "admin" });
    resolveActiveAgentMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest("POST"), res);
    expect(state.statusCode).toBe(403);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid body", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({ id: 3, userId: 7, slug: "a" });
    parseAndValidateMock.mockResolvedValue({ error: "bad body" });
    const { res, state } = createResponse();
    await handler(createRequest("POST"), res);
    expect(state.statusCode).toBe(400);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("records the run against the token's agent with a server-side tier snapshot", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({ id: 3, userId: 7, slug: "a" });
    parseAndValidateMock.mockResolvedValue({ data: validBody });
    const db = mockInsertDb([{ id: 42, modelTier: "flagship" }]);
    getDbMock.mockReturnValue(db);

    const { res, state } = createResponse();
    await handler(createRequest("POST"), res);

    expect(state.statusCode).toBe(201);
    expect(JSON.parse(state.body)).toEqual({ id: 42, modelTier: "flagship" });
    const inserted = db.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      agentId: 3,
      createdBy: 7,
      workflow: "escalation",
      runtime: "codex",
      sessionId: "sess-1",
      inputTokens: 1000,
      cacheReadTokens: 80000,
    });
    // The tier is a SQL subquery on agents.model_tier, never a body value.
    expect(typeof inserted.modelTier).toBe("object");
    expect(inserted.modelTier).not.toBe("flagship");
  });

  it("upserts on (agent, session) so a re-log replaces rather than double-counts", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({ id: 3, userId: 7, slug: "a" });
    parseAndValidateMock.mockResolvedValue({ data: validBody });
    const db = mockInsertDb([{ id: 42, modelTier: null }]);
    getDbMock.mockReturnValue(db);

    const { res, state } = createResponse();
    await handler(createRequest("POST"), res);

    expect(state.statusCode).toBe(201);
    const conflict = db.onConflictDoUpdate.mock.calls[0]![0] as {
      target: unknown[];
      set: Record<string, unknown>;
    };
    expect(conflict.target).toHaveLength(2);
    expect(conflict.set).toMatchObject({ outputTokens: 200 });
    // A re-log refreshes counts only; attribution stays the first write's.
    for (const kept of ['modelTier', 'createdAt', 'workflow', 'agentId']) {
      expect(conflict.set).not.toHaveProperty(kept);
    }
    expect(JSON.parse(state.body).modelTier).toBeNull();
  });
});
