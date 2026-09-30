import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  assertSameOrigin,
  CrossOriginRequestError,
  DEFAULT_MAX_BODY_BYTES,
  parseAndValidate,
  readBody,
  RequestBodyTooLargeError,
} from "../../api/_lib/validate.js";

function requestWithBody(
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.headers = headers;
  queueMicrotask(() => {
    req.end(body);
  });
  return req;
}

describe("request body validation", () => {
  it("parses valid JSON bodies normally", async () => {
    const req = requestWithBody(JSON.stringify({ email: "max@example.com" }));
    const result = await parseAndValidate(
      req,
      z.object({ email: z.string().email() }),
    );

    expect(result).toEqual({
      data: {
        email: "max@example.com",
      },
    });
  });

  it("accepts same-origin browser requests", async () => {
    const req = requestWithBody(JSON.stringify({ ok: true }), {
      host: "kinetix.no",
      origin: "https://kinetix.no",
    });

    await expect(readBody(req)).resolves.toBe(JSON.stringify({ ok: true }));
  });

  it("accepts same-origin forwarded http requests", async () => {
    const req = requestWithBody(JSON.stringify({ ok: true }), {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "x-forwarded-proto": "http",
    });

    await expect(readBody(req)).resolves.toBe(JSON.stringify({ ok: true }));
  });

  it("rejects browser requests from a different origin", async () => {
    const req = requestWithBody(JSON.stringify({ ok: true }), {
      host: "kinetix.no",
      origin: "https://evil.example",
    });

    await expect(readBody(req)).rejects.toBeInstanceOf(CrossOriginRequestError);
  });

  it("rejects same-host browser requests from the wrong scheme", async () => {
    const req = requestWithBody(JSON.stringify({ ok: true }), {
      host: "kinetix.no",
      origin: "http://kinetix.no",
    });

    await expect(readBody(req)).rejects.toBeInstanceOf(CrossOriginRequestError);
  });

  it("rejects origin schemes that do not match the forwarded request scheme", () => {
    const req = requestWithBody("", {
      host: "kinetix.no",
      origin: "https://kinetix.no",
      "x-forwarded-proto": "http",
    });

    expect(() => assertSameOrigin(req)).toThrow(CrossOriginRequestError);
  });

  it("rejects cross-origin no-body mutations before handler-specific work", () => {
    const req = requestWithBody("", {
      host: "kinetix.no",
      origin: "https://evil.example",
    });

    expect(() => assertSameOrigin(req)).toThrow(CrossOriginRequestError);
  });

  it("rejects requests that exceed the declared body size limit", async () => {
    const req = requestWithBody('{"ok":true}', {
      "content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
    });

    await expect(readBody(req)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("rejects streamed bodies that grow beyond the limit before parsing", async () => {
    const oversized = "a".repeat(DEFAULT_MAX_BODY_BYTES + 1);
    const req = requestWithBody(JSON.stringify({ payload: oversized }));

    await expect(
      parseAndValidate(req, z.object({ payload: z.string() })),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
