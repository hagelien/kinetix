/**
 * `/api/pdf-inbox` — the guards around linking a bulk-dropped PDF.
 *
 * The behaviour of an attach lives in `tests/integration/pdf-inbox.test.ts`,
 * against the real schema. What this file covers is the boundary: who may
 * reach the route at all, what happens to a malformed request, and — the one
 * that matters most — that the *editor* capability for replacing stored full
 * text is resolved for the caller and handed to the store, rather than being
 * assumed or skipped because a contributor already got this far.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  callerCanMock,
  attachInboxItemMock,
  discardInboxItemMock,
  recordAttachFailureMock,
  saveMatchMock,
  matchInboxItemMock,
  retryPendingBlobDeletionsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  callerCanMock: vi.fn(),
  attachInboxItemMock: vi.fn(),
  discardInboxItemMock: vi.fn(),
  recordAttachFailureMock: vi.fn(),
  saveMatchMock: vi.fn(),
  matchInboxItemMock: vi.fn(),
  retryPendingBlobDeletionsMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  callerCan: callerCanMock,
}));
vi.mock('../../api/_lib/pdf-inbox-store.js', async () => {
  // The real error class, so the route's `instanceof` branch is exercised
  // rather than mocked away — mapping a failure code to a status is the whole
  // job of the code under test here.
  const actual = await vi.importActual<
    typeof import('../../api/_lib/pdf-inbox-store.js')
  >('../../api/_lib/pdf-inbox-store.js');
  return {
    InboxAttachError: actual.InboxAttachError,
    attachInboxItem: attachInboxItemMock,
    discardInboxItem: discardInboxItemMock,
    recordAttachFailure: recordAttachFailureMock,
    retryPendingBlobDeletions: retryPendingBlobDeletionsMock,
    saveMatch: saveMatchMock,
  };
});
vi.mock('../../api/_lib/pdf-inbox-match.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/pdf-inbox-match.js')
  >('../../api/_lib/pdf-inbox-match.js');
  return { ...actual, matchInboxItem: matchInboxItemMock };
});

import handler from '../../api/pdf-inbox.ts';
import { InboxAttachError } from '../../api/_lib/pdf-inbox-store.js';

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string; headers: Record<string, unknown> };
} {
  const state = { statusCode: 200, body: '', headers: {} as Record<string, unknown> };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', ...headers };
  return req;
}

/**
 * Enough of a drizzle chain for both shapes this route uses: the count and the
 * citation hydration await `where()` directly, while the listing continues
 * into `orderBy().limit()`. A promise carrying those two methods satisfies
 * both without the test having to know which call is which.
 */
function chain(rows: unknown[]): Promise<unknown[]> {
  const settled = Promise.resolve(rows) as Promise<unknown[]> & {
    orderBy: () => Promise<unknown[]>;
    limit: () => Promise<unknown[]>;
  };
  settled.orderBy = () => chain(rows);
  settled.limit = () => Promise.resolve(rows);
  return settled;
}

function mockDb(rows: unknown[] = []) {
  const where = vi.fn(() => chain(rows));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, from, where };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequestMock.mockResolvedValue({ userId: 3, role: 'contributor' });
  callerCanMock.mockResolvedValue(true);
  // The route treats both as fire-and-forget (`.catch(...)`), so they must
  // return a promise even when the test does not care what they record.
  recordAttachFailureMock.mockResolvedValue(undefined);
  saveMatchMock.mockResolvedValue(undefined);
  retryPendingBlobDeletionsMock.mockResolvedValue(0);
  mockDb();
});

describe('authorization', () => {
  it('requires a session', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(request('GET', '/api/pdf-inbox'), res);
    expect(state.statusCode).toBe(401);
  });

  it('requires the resolve capability', async () => {
    callerCanMock.mockResolvedValue(false);
    const { res, state } = createResponse();
    await handler(request('GET', '/api/pdf-inbox'), res);
    expect(state.statusCode).toBe(403);
  });

  it('checks authorization before doing any work', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1&citationId=2'), res);
    expect(attachInboxItemMock).not.toHaveBeenCalled();
  });
});

describe('cross-origin', () => {
  // Attaching and discarding both mutate; a cookie-authenticated POST from
  // another origin must be refused before the session is even looked up.
  for (const method of ['POST', 'DELETE']) {
    it(`rejects a cross-origin ${method}`, async () => {
      const { res, state } = createResponse();
      await handler(
        request(method, '/api/pdf-inbox?id=1&citationId=2', {
          host: 'kinetix.no',
          origin: 'https://evil.example',
        }),
        res,
      );
      expect(state.statusCode).toBe(403);
      expect(JSON.parse(state.body).code).toBe('cross_origin_request_rejected');
      expect(getUserFromRequestMock).not.toHaveBeenCalled();
    });
  }
});

describe('GET', () => {
  it('returns the pending count', async () => {
    mockDb([{ count: 4 }]);
    const { res, state } = createResponse();
    await handler(request('GET', '/api/pdf-inbox?countOnly=1'), res);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ count: 4 });
    // A badge poll must not be cached, or it reports a stale queue.
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('refuses a status it does not recognise', async () => {
    const { res, state } = createResponse();
    await handler(request('GET', '/api/pdf-inbox?status=everything'), res);
    expect(state.statusCode).toBe(400);
  });
});

describe('POST attach', () => {
  it('rejects a missing or malformed id', async () => {
    for (const url of [
      '/api/pdf-inbox?citationId=2',
      '/api/pdf-inbox?id=0&citationId=2',
      '/api/pdf-inbox?id=abc&citationId=2',
      '/api/pdf-inbox?id=-1&citationId=2',
    ]) {
      const { res, state } = createResponse();
      await handler(request('POST', url), res);
      expect(state.statusCode).toBe(400);
    }
    expect(attachInboxItemMock).not.toHaveBeenCalled();
  });

  it('rejects a missing citationId', async () => {
    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1'), res);
    expect(state.statusCode).toBe(400);
  });

  it('passes the caller’s replace capability through to the store', async () => {
    // The crux: `pdfInbox.resolve` is a contributor capability and gets the
    // caller this far, but overwriting stored full text is editor-gated
    // everywhere else. The route resolves that separately and hands the answer
    // down, so a contributor cannot reach a replacement through the bulk path.
    callerCanMock.mockImplementation(async (_role: string, cap: string) =>
      cap !== 'citation.pdf.replace',
    );
    attachInboxItemMock.mockResolvedValue({ citationId: 2, replaced: false });

    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1&citationId=2'), res);

    expect(state.statusCode).toBe(200);
    expect(attachInboxItemMock).toHaveBeenCalledWith({
      itemId: 1,
      citationId: 2,
      userId: 3,
      mayReplace: false,
      auto: false,
    });
  });

  it('reports an editor-only replacement as 403, and records why', async () => {
    attachInboxItemMock.mockRejectedValue(
      new InboxAttachError('pdf_replace_requires_editor'),
    );
    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1&citationId=2'), res);
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('pdf_replace_requires_editor');
    // A bulk run fails item by item; an item that failed silently would look
    // exactly like one nobody has got to yet.
    expect(recordAttachFailureMock).toHaveBeenCalledWith(
      1,
      'pdf_replace_requires_editor',
    );
  });

  it('maps a vanished item to 404 and an already-linked one to 409', async () => {
    attachInboxItemMock.mockRejectedValueOnce(
      new InboxAttachError('inbox_item_not_found'),
    );
    const first = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1&citationId=2'), first.res);
    expect(first.state.statusCode).toBe(404);

    attachInboxItemMock.mockRejectedValueOnce(
      new InboxAttachError('inbox_item_not_pending'),
    );
    const second = createResponse();
    await handler(request('POST', '/api/pdf-inbox?id=1&citationId=2'), second.res);
    expect(second.state.statusCode).toBe(409);
  });
});

describe('POST autoAttach', () => {
  it('never lets a sweep replace stored full text', async () => {
    // The caller may well hold the editor capability — a bulk action is the
    // last place to let it apply silently to fifty papers.
    callerCanMock.mockResolvedValue(true);
    mockDb([{ id: 9, extracted: { doi: '10.1/x' } }]);
    matchInboxItemMock.mockResolvedValue({
      candidates: [
        {
          citationId: 4,
          via: 'doi',
          score: 1,
          citationType: 'doi',
          citationIdentifier: '10.1/x',
          citationMetadata: null,
          hasPdf: false,
        },
      ],
      confidence: 'exact',
      citationId: 4,
    });
    attachInboxItemMock.mockResolvedValue({ citationId: 4, replaced: false });

    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?action=autoAttach'), res);

    expect(state.statusCode).toBe(200);
    expect(attachInboxItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ mayReplace: false, auto: true }),
    );
  });

  it('re-runs the match rather than trusting the stored grade', async () => {
    // The stored grade is a snapshot of a corpus that has since changed —
    // which is the entire reason to run a sweep.
    mockDb([{ id: 9, extracted: { doi: '10.1/x' } }]);
    matchInboxItemMock.mockResolvedValue({
      candidates: [],
      confidence: 'none',
      citationId: null,
    });
    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?action=autoAttach'), res);
    expect(matchInboxItemMock).toHaveBeenCalled();
    expect(saveMatchMock).toHaveBeenCalledWith(9, expect.anything());
    expect(attachInboxItemMock).not.toHaveBeenCalled();
    expect(JSON.parse(state.body).attached).toEqual([]);
  });

  /** id -> whether `matchInboxItem` should report an exact, attachable match. */
  function itemsWithMatches(ids: number[], matchable: Set<number>) {
    matchInboxItemMock.mockImplementation(async (_db, extracted) => {
      const id = Number(/item(\d+)/.exec((extracted as { doi: string }).doi)?.[1]);
      if (!matchable.has(id)) {
        return { candidates: [], confidence: 'none', citationId: null };
      }
      return {
        candidates: [
          {
            citationId: id,
            via: 'doi',
            score: 1,
            citationType: 'doi',
            citationIdentifier: `10.1/item${id}`,
            citationMetadata: null,
            hasPdf: false,
          },
        ],
        confidence: 'exact',
        citationId: id,
      };
    });
    attachInboxItemMock.mockImplementation(async ({ citationId }) => ({
      citationId,
      replaced: false,
    }));
    return ids.map((id) => ({ id, extracted: { doi: `10.1/item${id}` } }));
  }

  it('reaches a match sitting behind a run of unmatchable items instead of stalling on them', async () => {
    // Fifty-four unmatchable items (scans, DOIs with no citation yet) ahead of
    // one exact match — beyond the old fixed 50-row scan window, where this
    // match would never have been inspected by any sweep.
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    mockDb(itemsWithMatches(ids, new Set([55])));

    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?action=autoAttach'), res);

    expect(attachInboxItemMock).toHaveBeenCalledTimes(1);
    expect(attachInboxItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 55, citationId: 55 }),
    );
    const body = JSON.parse(state.body);
    expect(body.attached).toEqual([{ itemId: 55, citationId: 55 }]);
    // The whole inbox was reached and nothing was left unscanned behind it.
    expect(body.scanned).toBe(60);
    expect(body.truncated).toBe(false);
  });

  it('stops once it has attached a batch worth, leaving the rest for the next sweep', async () => {
    // All 55 items are matchable; the sweep should stop after linking 50 of
    // them rather than continuing through the whole inbox in one call.
    const ids = Array.from({ length: 55 }, (_, i) => i + 1);
    mockDb(itemsWithMatches(ids, new Set(ids)));

    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?action=autoAttach'), res);

    expect(attachInboxItemMock).toHaveBeenCalledTimes(50);
    expect(matchInboxItemMock).toHaveBeenCalledTimes(50);
    const body = JSON.parse(state.body);
    expect(body.attached).toHaveLength(50);
    expect(body.scanned).toBe(50);
    expect(body.truncated).toBe(true);
  });
});

describe('POST autoAttach cleanup', () => {
  it('retries objects an earlier discard failed to delete, and reports how many', async () => {
    // A failed delete leaves licensed full text in the store behind a UI that
    // says it is gone. The sweep is where somebody is actually working the
    // inbox, so it is where the retry runs — and the count comes back rather
    // than disappearing into a log.
    retryPendingBlobDeletionsMock.mockResolvedValue(2);
    mockDb([]);
    const { res, state } = createResponse();
    await handler(request('POST', '/api/pdf-inbox?action=autoAttach'), res);

    expect(retryPendingBlobDeletionsMock).toHaveBeenCalled();
    expect(JSON.parse(state.body).cleaned).toBe(2);
  });
});

describe('DELETE', () => {
  it('discards a pending item', async () => {
    discardInboxItemMock.mockResolvedValue(undefined);
    const { res, state } = createResponse();
    await handler(request('DELETE', '/api/pdf-inbox?id=5'), res);
    expect(state.statusCode).toBe(200);
    expect(discardInboxItemMock).toHaveBeenCalledWith(5);
  });

  it('refuses to discard anything that is no longer pending', async () => {
    // An attached item no longer owns its bytes; discarding it would take a
    // paper's full text with it.
    discardInboxItemMock.mockRejectedValue(
      new InboxAttachError('inbox_item_not_pending'),
    );
    const { res, state } = createResponse();
    await handler(request('DELETE', '/api/pdf-inbox?id=5'), res);
    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('inbox_item_not_pending');
  });
});

describe('method handling', () => {
  it('rejects an unsupported method', async () => {
    const { res, state } = createResponse();
    await handler(request('PUT', '/api/pdf-inbox'), res);
    expect(state.statusCode).toBe(405);
  });
});
