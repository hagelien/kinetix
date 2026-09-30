import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import drugsHandler from "../../api/drugs.js";

function request(headers: Record<string, string>): IncomingMessage {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = "DELETE";
  req.url = "/api/drugs?id=1";
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  return req;
}

function response(): ServerResponse & {
  body: string;
  statusCodeWritten: number | null;
} {
  let headersSent = false;
  return {
    body: "",
    statusCodeWritten: null,
    get headersSent() {
      return headersSent;
    },
    writeHead(status: number) {
      this.statusCodeWritten = status;
      headersSent = true;
      return this as ServerResponse;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this as ServerResponse;
    },
  } as ServerResponse & { body: string; statusCodeWritten: number | null };
}

describe("drug API security", () => {
  it("rejects cross-origin destructive deletes before auth or database work", async () => {
    const req = request({
      host: "kinetix.no",
      origin: "https://evil.example",
    });
    const res = response();

    await drugsHandler(req, res);

    expect(res.statusCodeWritten).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "Cross-origin API request rejected",
      code: "cross_origin_request_rejected",
    });
  });
});
