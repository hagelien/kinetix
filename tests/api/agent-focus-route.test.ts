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
  effectiveFocusParameters,
  scopeArraysToMode,
} from "../../api/agent-focus.ts";

function createRequest(): IncomingMessage {
  return {
    method: "GET",
    url: "/api/agent-focus",
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

function configQuery(row: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      })),
    })),
  };
}

function rowsQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(rows),
    })),
  };
}

function orderedRowsQuery(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn().mockResolvedValue(rows),
      })),
    })),
  };
}

function deferredRowsQuery<T>(deferred: {
  promise: Promise<T[]>;
  resolve: (rows: T[]) => void;
}) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => deferred.promise),
    })),
  };
}

function deferred<T>() {
  let resolve!: (rows: T[]) => void;
  const promise = new Promise<T[]>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GET /api/agent-focus access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects ordinary authenticated users before reading the config", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "authenticated",
    });
    resolveActiveAgentMock.mockResolvedValue(null);

    const { res, state } = createResponse();
    await handler(createRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toEqual({
      error: "Admin or agent token required",
    });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("allows admins to read the config without an agent row", async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: "admin" });
    const select = vi.fn().mockReturnValueOnce(
      configQuery({
        mode: "parameters",
        pageIds: [],
        parameters: ["halfLife"],
        methodIds: [],
        updatedAt: new Date("2026-06-25T00:00:00.000Z"),
      }),
    );
    getDbMock.mockReturnValue({ select });

    const { res, state } = createResponse();
    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(resolveActiveAgentMock).not.toHaveBeenCalled();
    expect(JSON.parse(state.body).config).toMatchObject({
      mode: "parameters",
      parameters: ["halfLife"],
      methods: [],
    });
  });

  it("allows active agent tokens and keeps method hydration available to the agent", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({ id: 42, slug: "kinetix-agent" });
    const select = vi
      .fn()
      .mockReturnValueOnce(
        configQuery({
          mode: "methods",
          pageIds: [],
          parameters: [],
          methodIds: [9001],
          updatedAt: new Date("2026-06-25T00:00:00.000Z"),
        }),
      )
      .mockReturnValueOnce(
        rowsQuery([{ id: 9001, code: "9001", name: "Synthetic screening panel A" }]),
      )
      .mockReturnValueOnce(
        orderedRowsQuery([
          { methodId: 9001, drugId: 5 },
          { methodId: 9001, drugId: 8 },
        ]),
      );
    getDbMock.mockReturnValue({ select });

    const { res, state } = createResponse();
    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(state.body).config.methods).toEqual([
      {
        id: 9001,
        code: "9001",
        name: "Synthetic screening panel A",
        drugIds: [5, 8],
      },
    ]);
  });

  it("hydrates method metadata and component rows without serializing DB reads", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: "contributor",
    });
    resolveActiveAgentMock.mockResolvedValue({ id: 42, slug: "kinetix-agent" });

    const methodRows = deferred<{
      id: number;
      code: string;
      name: string;
    }>();
    const select = vi
      .fn()
      .mockReturnValueOnce(
        configQuery({
          mode: "methods",
          pageIds: [],
          parameters: [],
          methodIds: [9001],
          updatedAt: new Date("2026-06-25T00:00:00.000Z"),
        }),
      )
      .mockReturnValueOnce(deferredRowsQuery(methodRows))
      .mockReturnValueOnce(
        orderedRowsQuery([
          { methodId: 9001, drugId: 5 },
          { methodId: 9001, drugId: 8 },
        ]),
      );
    getDbMock.mockReturnValue({ select });

    const { res, state } = createResponse();
    const request = handler(createRequest(), res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(select).toHaveBeenCalledTimes(3);

    methodRows.resolve([
      { id: 9001, code: "9001", name: "Synthetic screening panel A" },
    ]);
    await request;

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body).config.methods[0].drugIds).toEqual([5, 8]);
  });
});

describe("scopeArraysToMode", () => {
  // The invariant db/schema.ts always claimed ("…for mode=X; empty otherwise")
  // and nothing enforced. It only started to matter when `methods` learned to
  // read a second array: a `parameters` selection left behind by an earlier
  // save would otherwise have become a live filter on deploy, silently
  // narrowing a method-focused agent to a set nobody chose for that scope.
  const ALL = {
    pageIds: [7],
    parameters: ["halfLife", "dispositionModel"],
    methodIds: [9001],
  };

  it("keeps the parameter list under the mode it is the instruction for", () => {
    expect(scopeArraysToMode("parameters", ALL)).toEqual({
      pageIds: [],
      parameters: ["halfLife", "dispositionModel"],
      methodIds: [],
      // The opt-in vouches for a COMPOSED methods focus specifically; under
      // `parameters` the array needs no vouching, since that mode has always
      // read it.
      methodsParametersOptIn: false,
    });
  });

  it("keeps BOTH arrays under methods, which now composes them", () => {
    expect(scopeArraysToMode("methods", ALL)).toEqual({
      pageIds: [],
      parameters: ["halfLife", "dispositionModel"],
      methodIds: [9001],
      // Set here and nowhere else. The pre-composition handler does not know
      // the column exists, so this is what separates an array an admin chose
      // from one that slipped through the deploy window (migration 0122).
      methodsParametersOptIn: true,
    });
  });

  it("does not vouch for a methods focus that selected no parameters", () => {
    // The flag means "an admin composed these two", so an empty selection must
    // not set it — otherwise a later write by an old handler would inherit a
    // true flag and have its array trusted after all.
    expect(
      scopeArraysToMode("methods", { ...ALL, parameters: [] }),
    ).toEqual({
      pageIds: [],
      parameters: [],
      methodIds: [9001],
      methodsParametersOptIn: false,
    });
  });

  it("drops a parameter list under pages, which never reads one", () => {
    // Without this a pages-mode save would store a dormant array that a later
    // switch to methods would silently activate — the same trap 0121 cleans up
    // for rows written before the invariant was enforced.
    expect(scopeArraysToMode("pages", ALL)).toEqual({
      pageIds: [7],
      parameters: [],
      methodIds: [],
      methodsParametersOptIn: false,
    });
  });

  it("drops everything under all, which narrows nothing", () => {
    expect(scopeArraysToMode("all", ALL)).toEqual({
      pageIds: [],
      parameters: [],
      methodIds: [],
      methodsParametersOptIn: false,
    });
  });
});

describe("effectiveFocusParameters", () => {
  // The deploy window migration 0122 exists for: `vercel build` applies
  // migrations while the PREVIOUS build is still serving writes, so an admin
  // saving a methods focus in that window goes through the old handler, which
  // persists `parameters` and knows nothing about the opt-in. Timing cannot
  // fix that; refusing to trust an unvouched array can.
  it("ignores a methods array no composition-aware writer vouched for", () => {
    expect(effectiveFocusParameters("methods", ["halfLife"], false)).toEqual(
      [],
    );
  });

  it("honours a methods array the new write path vouched for", () => {
    expect(effectiveFocusParameters("methods", ["halfLife"], true)).toEqual([
      "halfLife",
    ]);
  });

  it("leaves parameters mode alone, vouched or not", () => {
    // That mode has always read the array, so there is no legacy reading to
    // distinguish it from — gating it on the flag would break a focus that
    // worked before this change.
    expect(effectiveFocusParameters("parameters", ["halfLife"], false)).toEqual(
      ["halfLife"],
    );
  });
});
