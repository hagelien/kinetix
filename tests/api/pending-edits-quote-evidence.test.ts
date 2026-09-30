import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  // The submitter revise runs its write and verdict wipe in one transaction;
  // with the DB mocked, the transaction is just the callback.
  inTransaction: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/pending-edits-helpers.js', () => ({
  applyApprovedEdit: vi.fn(),
  assertReferencesJudged: vi.fn(),
  assertReferencesJudgedForActor: vi.fn(),
  ReferenceGateError: class ReferenceGateError extends Error {},
  WikiFactApprovalError: class WikiFactApprovalError extends Error {
    statusHint = 400;
  },
  PendingEditReviewTokenMismatchError: class PendingEditReviewTokenMismatchError extends Error {
    statusHint = 409;
    code = 'pending_edit_review_token_mismatch';
  },
}));

import handler, {
  withCanonicalEntryQuote,
} from '../../api/pending-edits.ts';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.ts';
import { sourceQuoteSchema } from '../../src/lib/parameterEntries.ts';

const dialect = new PgDialect();

const QUOTE = 'The mean terminal half-life was 9 h.';

function createPatchRequest(body: Record<string, unknown>): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = '/api/pending-edits?id=7';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(raw.length),
  };
  return req;
}

function createResponse() {
  const res = {
    headersSent: false,
    writeHead: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as ServerResponse;
  return { res };
}

function mockDb(edit: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([edit]);
  const where = vi.fn().mockReturnValue({ limit });
  // User 12 is a plain human contributor, so the agent-focus gate's join
  // answers with no rows.
  const agentLimit = vi.fn().mockResolvedValue([]);
  const agentWhere = vi.fn().mockReturnValue({ limit: agentLimit });
  const innerJoin = vi.fn().mockReturnValue({ where: agentWhere });
  const from = vi.fn().mockReturnValue({ where, innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  const returning = vi.fn().mockResolvedValue([{ id: 7 }]);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  getDbMock.mockReturnValue({ select, update });
  return { set };
}

/** A high-risk `parameter` proposal that records the sentence it was read off. */
function quotedParameterEdit(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    editType: 'parameter',
    status: 'pending',
    submittedBy: 12,
    proposedValue: { min: 8, max: 10, unit: 'h' },
    proposedMeta: { sourceQuote: QUOTE, editSummary: 'From the label.' },
    referenceId: 5,
    referenceIds: [5],
    targetId: 3,
    parameter: 'halfLife',
    sectionId: null,
    fieldId: null,
    factStatement: null,
    factOperation: null,
    factTargetAnchor: null,
    ...overrides,
  };
}

/**
 * The metadata the PATCH would write, as text. It is emitted as a SQL
 * expression (the conflict-marker guard), so the quote — if it survived — shows
 * up among the bound parameters rather than in a plain object.
 */
function writtenMetaText(set: ReturnType<typeof vi.fn>): string {
  expect(set).toHaveBeenCalledTimes(1);
  const written = set.mock.calls[0][0] as Record<string, unknown>;
  const meta = written.proposedMeta;
  if (meta instanceof SQL) {
    const { sql, params } = dialect.sqlToQuery(meta);
    return sql + JSON.stringify(params);
  }
  return JSON.stringify(meta);
}

/**
 * The other half of the stale-quote rule: it must not cost a proposal the
 * evidence it legitimately has.
 *
 * Staleness is decided by whether the quote is still evidence for what the
 * proposal says — the value and the sources it was read from. The signal that
 * was closest to hand is broader than that: `pendingEditPayloadFingerprint`
 * covers the whole of `proposedMeta`, which is right for `revisedAt` and wrong
 * here, because reworded curator notes are commentary about the proposal rather
 * than part of what the sentence attests. Deciding on the broad signal strips a
 * good quote from a metadata-only edit — and then the gate holds the proposal
 * for lacking the very quote it just removed.
 */
describe('/api/pending-edits — a metadata-only revision keeps its quote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
  });

  it('keeps the quote when the author only rewords the edit summary', async () => {
    const { set } = mockDb(quotedParameterEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedMeta: { sourceQuote: QUOTE, editSummary: 'Reworded.' },
      }),
      res,
    );

    expect(writtenMetaText(set)).toContain(QUOTE);
  });

  it('still drops the quote when the value itself moves', async () => {
    const { set } = mockDb(quotedParameterEdit());
    const { res } = createResponse();

    // The same echoed metadata, but the number under it has changed: the
    // sentence describes the value it used to be.
    await handler(
      createPatchRequest({
        proposedValue: { min: 10, max: 12, unit: 'h' },
        proposedMeta: { sourceQuote: QUOTE, editSummary: 'From the label.' },
      }),
      res,
    );

    expect(writtenMetaText(set)).not.toContain(QUOTE);
  });

  // The reviewer's return-with-changes had the same gap, wider: its flag is
  // true merely because the request CARRIED a `proposedMeta`, so a reviewer
  // sending the proposal back with a note and nothing else would have stripped
  // a quote that is still perfectly good evidence — and handed the author a
  // proposal they now cannot get published.
  it('keeps the quote when a reviewer returns it with only a note', async () => {
    const edit = quotedParameterEdit();
    const { set } = mockDb(edit);
    const { res } = createResponse();
    getUserFromRequestMock.mockResolvedValue({ userId: 40, role: 'editor' });

    await handler(
      createPatchRequest({
        status: 'returned',
        reviewToken: pendingEditReviewToken(edit as never),
        proposedMeta: {
          sourceQuote: QUOTE,
          editSummary: 'From the label.',
          reviewerNote: 'Please cite the fasted arm explicitly.',
        },
      }),
      res,
    );

    expect(writtenMetaText(set)).toContain(QUOTE);
  });
});

/**
 * The reviewer's screen and the audit record have to be the same words.
 *
 * `/api/parameter-entries` parses its payload — `quote` included — so a
 * proposal queued there is canonical from the start. The two generic paths that
 * REWRITE `proposedValue` validated it and then stored the original object, so
 * the raw text survived until approval re-parsed it. Mostly cosmetic for stray
 * whitespace; not cosmetic at all for a bidi control, which reverses the run
 * after it: a reviewer is shown one reading, approves what they read, and a
 * different one is recorded as the provenance they approved.
 */
describe('withCanonicalEntryQuote', () => {
  const update = (quote: unknown) => ({
    op: 'update',
    patch: { median: 12, quote },
  });

  it('strips a bidi control before the payload is stored', () => {
    const attack = '\u202EPeak was 12 mg/L\u202C';
    const out = withCanonicalEntryQuote(update(attack)) as {
      patch: { quote: string };
    };
    expect(out.patch.quote).toBe('Peak was 12 mg/L');
    // Which is what approval would have stored anyway — that is the point: the
    // row now holds it too, so the card cannot show anything else.
    expect(sourceQuoteSchema.parse(attack)).toBe(out.patch.quote);
  });

  it('normalizes a create payload the same way', () => {
    const out = withCanonicalEntryQuote({
      op: 'create',
      input: { median: 12, quote: '  Peak was\n\t12 mg/L  ' },
    }) as { input: { quote: string } };
    expect(out.input.quote).toBe('Peak was 12 mg/L');
  });

  it('folds a quote with nothing visible in it to an explicit clear', () => {
    const out = withCanonicalEntryQuote(update('\u200B \u00AD')) as {
      patch: { quote: unknown };
    };
    expect(out.patch.quote).toBeNull();
  });

  // Silence is not a clear, and a payload that says nothing about the quote
  // must come back untouched or the preserve rule loses its input.
  it('leaves a payload that states no quote exactly as it was', () => {
    const value = { op: 'update', patch: { median: 12 } };
    expect(withCanonicalEntryQuote(value)).toBe(value);
  });

  it('leaves an explicit null alone', () => {
    const out = withCanonicalEntryQuote(update(null)) as {
      patch: { quote: unknown };
    };
    expect(out.patch.quote).toBeNull();
  });

  // A non-string is the payload validator's to refuse, with its own message.
  it('does not swallow a malformed quote', () => {
    const value = update(42);
    expect(withCanonicalEntryQuote(value)).toBe(value);
  });

  it('leaves a delete and a non-entry payload alone', () => {
    for (const value of [{ op: 'delete' }, { low: 1, high: 2 }, null]) {
      expect(withCanonicalEntryQuote(value)).toBe(value);
    }
  });
});
