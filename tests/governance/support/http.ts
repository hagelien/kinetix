/**
 * Minimal `node:http` request/response doubles for driving the API handlers.
 *
 * Kinetix's routes are raw `(req, res)` functions over `node:http`, not Express
 * handlers, so "call the real route" needs nothing more than a readable stream
 * with headers and an object that records what was written. Shared because the
 * end-to-end and concurrency suites both drive the same routes and a second
 * copy would drift.
 *
 * Authentication is deliberately NOT handled here: `vi.mock` is file-scoped, so
 * each suite hoists its own mock of `api/_lib/auth.js` and passes the caller in.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { vi } from 'vitest';

export interface ResponseState {
  statusCode: number;
  body: string;
}

export function createResponse(): { res: ServerResponse; state: ResponseState } {
  const state: ResponseState = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

export function jsonRequest(
  method: string,
  url: string,
  body: unknown,
): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;
