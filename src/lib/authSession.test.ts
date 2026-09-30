import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  SignJWT: class {},
  jwtVerify: vi.fn(),
}));

vi.mock("../../api/_lib/db.js", () => ({
  getDb: vi.fn(),
}));

import { jwtVerify } from "jose";
import {
  clearAuthCookie,
  getUserFromRequest,
  setAuthCookie,
} from "../../api/_lib/auth.js";
import { getDb } from "../../api/_lib/db.js";

type UserRow = {
  id: number;
  role: string;
  lastAuthAt: Date | null;
  sessionMaxDays: number;
};

function requestWithToken(
  token: string,
  cookieName: string = "__Host-kinetix-auth",
): IncomingMessage {
  return {
    headers: {
      cookie: `${cookieName}=${token}`,
    },
  } as IncomingMessage;
}

function mockResponse(): ServerResponse {
  return {
    setHeader: vi.fn(),
  } as unknown as ServerResponse;
}

function mockUserLookup(
  lookup: () => Promise<UserRow[]>,
  agentRows: Array<{ id: number }> = [],
) {
  // db.batch() receives the three pre-built query objects and executes them
  // in a single HTTP round trip. Mock it to return [userRows, groupRows, agentRows].
  const batch = vi.fn(async () => [await lookup(), [], agentRows]);

  // The query builders returned by select().from().where().limit() must be
  // valid objects so db.batch() receives them — but their execution path is
  // handled by the batch mock above, so their own async methods are stubs.
  const makeQueryStub = () => {
    const stub: Record<string, unknown> = {};
    stub.from = vi.fn(() => stub);
    stub.where = vi.fn(() => stub);
    stub.innerJoin = vi.fn(() => stub);
    stub.limit = vi.fn(() => stub);
    return stub;
  };

  const select = vi.fn(() => makeQueryStub());

  vi.mocked(getDb).mockReturnValue({
    select,
    batch,
  } as unknown as ReturnType<typeof getDb>);
}

describe("getUserFromRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.JWT_SECRET = "test-secret-for-auth-helper";
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: "7",
        role: "admin",
      },
      protectedHeader: {
        alg: "HS256",
      },
      key: new Uint8Array(),
    } as Awaited<ReturnType<typeof jwtVerify>>);
  });

  it("uses the latest role from the database instead of the JWT claim", async () => {
    mockUserLookup(async () => [
      {
        id: 7,
        role: "contributor",
        lastAuthAt: new Date(),
        sessionMaxDays: 30,
      },
    ]);

    await expect(
      getUserFromRequest(requestWithToken("signed-token")),
    ).resolves.toEqual({
      userId: 7,
      role: "contributor",
      groups: [],
    });
  });

  it("rejects a JWT whose user backs an agent (must use a kxat_ token)", async () => {
    mockUserLookup(
      async () => [
        {
          id: 7,
          role: "contributor",
          lastAuthAt: new Date(),
          sessionMaxDays: 30,
        },
      ],
      [{ id: 99 }],
    );

    await expect(
      getUserFromRequest(requestWithToken("signed-token")),
    ).resolves.toBeNull();
  });

  it("does not authenticate older cookie names after the migration window", async () => {
    await expect(
      getUserFromRequest(requestWithToken("signed-token", "kinetix-auth")),
    ).resolves.toBeNull();
    await expect(
      getUserFromRequest(requestWithToken("signed-token", "fjelltox-auth")),
    ).resolves.toBeNull();
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("sets the __Host- cookie and clears older cookie names", () => {
    const res = mockResponse();

    setAuthCookie(res, "signed-token", 123);

    expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie", [
      "__Host-kinetix-auth=signed-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=123; Secure",
      "kinetix-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "fjelltox-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
  });

  it("clears the primary and fallback cookie names on logout", () => {
    const res = mockResponse();

    clearAuthCookie(res);

    expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie", [
      "__Host-kinetix-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "kinetix-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "fjelltox-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    ]);
  });

  it("rejects sessions when lastAuthAt is null (fail-closed on missing timestamp)", async () => {
    mockUserLookup(async () => [
      {
        id: 7,
        role: "contributor",
        lastAuthAt: null,
        sessionMaxDays: 30,
      },
    ]);

    await expect(
      getUserFromRequest(requestWithToken("signed-token")),
    ).resolves.toBeNull();
  });

  it("fails closed when the database lookup cannot complete", async () => {
    mockUserLookup(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      getUserFromRequest(requestWithToken("signed-token")),
    ).rejects.toThrow("database unavailable");
  });
});
