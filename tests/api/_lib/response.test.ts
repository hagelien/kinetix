import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { withErrorHandling } from '../../../api/_lib/response.ts';

/** Build an error shaped like the neon-http driver's NeonDbError. */
function neonError(message: string, code?: string): Error {
  const err = new Error(message);
  err.name = 'NeonDbError';
  if (code !== undefined) (err as Error & { code?: string }).code = code;
  return err;
}

interface FakeResponse extends ServerResponse {
  _status?: number;
  _body?: string;
}

function fakeReqRes(): { req: IncomingMessage; res: FakeResponse } {
  const req = {
    url: '/api/auth-request',
    method: 'POST',
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number) {
      (this as FakeResponse)._status = status;
      (this as FakeResponse).headersSent = true;
      return this;
    },
    end(body?: string) {
      (this as FakeResponse)._body = body;
      return this;
    },
  } as unknown as FakeResponse;
  return { req, res };
}

describe('withErrorHandling — database-unavailable handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 503 with a stable code when the DB is unavailable (bad Neon password)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = fakeReqRes();
    const handler = withErrorHandling(async () => {
      throw neonError("password authentication failed for user 'neondb_owner'", '28P01');
    });

    await handler(req, res);

    expect(res._status).toBe(503);
    const body = JSON.parse(res._body ?? '{}');
    expect(body.code).toBe('service_unavailable');
    // Body stays generic English prose; the client translates via the code.
    expect(body.error).toBe('Service temporarily unavailable');
  });

  it('tags the KINETIX_ERROR log record as infrastructure with status 503', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = fakeReqRes();
    const handler = withErrorHandling(async () => {
      throw neonError('Error connecting to database: fetch failed');
    });

    await handler(req, res);

    const logLine = spy.mock.calls[0]?.[0] as string;
    expect(logLine).toContain('KINETIX_ERROR');
    const record = JSON.parse(logLine.replace('KINETIX_ERROR ', ''));
    expect(record.status).toBe(503);
    expect(record.category).toBe('infrastructure');
  });

  it('detects DB-unavailability nested under `cause` (drizzle wraps the driver error)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = fakeReqRes();
    const handler = withErrorHandling(async () => {
      // drizzle throws a "Failed query" Error whose `cause` is the NeonDbError.
      const wrapped = new Error('Failed query: select ...') as Error & {
        cause?: unknown;
      };
      wrapped.cause = neonError('password authentication failed', '28P01');
      throw wrapped;
    });

    await handler(req, res);

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body ?? '{}').code).toBe('service_unavailable');
  });

  it('keeps a generic 500 for application bugs (deterministic SQL errors)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = fakeReqRes();
    const handler = withErrorHandling(async () => {
      throw neonError('column "foo" does not exist', '42703');
    });

    await handler(req, res);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body ?? '{}');
    expect(body.error).toBe('Internal server error');
    expect(body.code).toBeUndefined();
    const record = JSON.parse(
      (spy.mock.calls[0]?.[0] as string).replace('KINETIX_ERROR ', ''),
    );
    expect(record.status).toBe(500);
    expect(record.category).toBe('application');
  });
});
