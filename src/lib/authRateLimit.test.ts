import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/_lib/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../api/_lib/email.js", () => ({
  sendLoginCode: vi.fn(),
}));

import authRequestHandler from "../../api/auth-request.ts";
import authVerifyHandler from "../../api/auth-verify.ts";
import { getDb } from "../../api/_lib/db.js";
import {
  clearRateLimitState,
  consumeRateLimit,
} from "../../api/_lib/rate-limit.js";

function createJsonRequest(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = JSON.stringify(body);
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    ...headers,
  };

  queueMicrotask(() => {
    req.end(payload);
  });

  return req;
}

function createResponse(): {
  res: ServerResponse;
  status: () => number | undefined;
  json: () => Record<string, unknown>;
  header: (name: string) => string | string[] | number | undefined;
} {
  let statusCode: number | undefined;
  let body = "";
  const headers = new Map<string, string | string[] | number>();

  const res = {
    headersSent: false,
    setHeader: vi.fn((name: string, value: string | string[] | number) => {
      headers.set(name.toLowerCase(), value);
      return res;
    }),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    writeHead: vi.fn((code: number, nextHeaders?: Record<string, string>) => {
      statusCode = code;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers.set(name.toLowerCase(), value);
        }
      }
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
    json: () => JSON.parse(body),
    header: (name: string) => headers.get(name.toLowerCase()),
  };
}

function mockAllowlistMissDb(): void {
  const limit = vi.fn(async () => []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  vi.mocked(getDb).mockReturnValue({
    select,
  } as unknown as ReturnType<typeof getDb>);
}

describe("rate-limit helper", () => {
  beforeEach(() => {
    clearRateLimitState();
  });

  it("returns a retry window once the configured budget is exhausted", () => {
    expect(
      consumeRateLimit("auth-test", "user@example.com", 2, 60_000, 1_000),
    ).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
    expect(
      consumeRateLimit("auth-test", "user@example.com", 2, 60_000, 2_000),
    ).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
    expect(
      consumeRateLimit("auth-test", "user@example.com", 2, 60_000, 30_000),
    ).toEqual({
      limited: true,
      retryAfterSeconds: 31,
    });
  });
});

describe("magic-link endpoint throttling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearRateLimitState();
    mockAllowlistMissDb();
  });

  it("limits repeated OTP sends for the same email before allowlist checks can be abused", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = createResponse();

      await authRequestHandler(
        createJsonRequest(
          "/api/auth-request",
          { email: "victim@example.com", stayLoggedIn: false },
          { "x-forwarded-for": "203.0.113.10" },
        ),
        response.res,
      );

      expect(response.status()).toBe(200);
      expect(response.json()).toEqual({
        message:
          "If that email is on the allowlist, a sign-in code has been sent. Check your inbox.",
      });
    }

    const response = createResponse();
    await authRequestHandler(
      createJsonRequest(
        "/api/auth-request",
        { email: "victim@example.com", stayLoggedIn: false },
        { "x-forwarded-for": "203.0.113.10" },
      ),
      response.res,
    );

    expect(response.status()).toBe(429);
    expect(Number(response.header("Retry-After"))).toBeGreaterThan(0);
    expect(Number(response.header("Retry-After"))).toBeLessThanOrEqual(900);
    expect(response.json()).toEqual({
      error:
        "Too many sign-in requests. Please wait before requesting another code.",
    });
  });

  it("limits repeated OTP guesses for the same email before the database lookup", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = createResponse();

      await authVerifyHandler(
        createJsonRequest(
          "/api/auth-verify",
          { email: "victim@example.com", code: "123456" },
          { "x-forwarded-for": "198.51.100.44" },
        ),
        response.res,
      );

      expect(response.status()).toBe(401);
      expect(response.json()).toEqual({
        error: "Invalid or expired code",
      });
    }

    const response = createResponse();
    await authVerifyHandler(
      createJsonRequest(
        "/api/auth-verify",
        { email: "victim@example.com", code: "123456" },
        { "x-forwarded-for": "198.51.100.44" },
      ),
      response.res,
    );

    expect(response.status()).toBe(429);
    expect(Number(response.header("Retry-After"))).toBeGreaterThan(0);
    expect(Number(response.header("Retry-After"))).toBeLessThanOrEqual(900);
    expect(response.json()).toEqual({
      error:
        "Too many code verification attempts. Please wait before trying again.",
    });
  });
});
