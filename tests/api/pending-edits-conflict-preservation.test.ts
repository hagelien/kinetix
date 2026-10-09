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

// The drug-lock protocol a `param_entry` revision runs under needs a real
// transaction; this file is about the conflict marker, and the protocol has
// its own integration tests (tests/integration/param-entry-payload-locks.test.ts).
vi.mock('../../api/_lib/param-entry-payload-locks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/param-entry-payload-locks.js')>()),
  withParamEntryPayloadLocks: async (_args: unknown, write: () => Promise<unknown>) => ({
    refused: null,
    value: await write(),
  }),
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

import handler from '../../api/pending-edits.ts';

const dialect = new PgDialect();

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
  // The agent-focus gate on the submitter branch asks whether the actor backs
  // an active agent, which joins `agents` to `users`. Answering `[]` is the
  // truthful fixture — user 12 here is a plain human contributor — and it keeps
  // these tests on the conflict-marker path they exist for.
  const agentLimit = vi.fn().mockResolvedValue([]);
  const agentWhere = vi.fn().mockReturnValue({ limit: agentLimit });
  const innerJoin = vi.fn().mockReturnValue({ where: agentWhere });
  // `getParameterEntryContentsByIds` (the staleness check's live-row lookup
  // for observationContext, #1257) joins citations onto parameter_entries.
  // Empty is a truthful fixture for these tests either way: none of them
  // exercise the observationContext resolution this join feeds, only the
  // conflict-marker logic, so "no live entry found" is a safe, inert answer.
  const leftJoinWhere = vi.fn().mockResolvedValue([]);
  const leftJoin = vi.fn().mockReturnValue({ where: leftJoinWhere });
  const from = vi.fn().mockReturnValue({ where, innerJoin, leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  const returning = vi.fn().mockResolvedValue([{ id: 7 }]);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  // A PATCH that genuinely revises the payload clears the proposal's
  // verifications, so the fixture has to answer that call as well.
  const del = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  getDbMock.mockReturnValue({ select, update, delete: del });
  return { set };
}

function pendingEdit(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    editType: 'wiki_fact',
    status: 'pending',
    submittedBy: 12,
    proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
    proposedMeta: null,
    referenceId: null,
    referenceIds: null,
    targetId: 3,
    parameter: null,
    sectionId: 'overview',
    fieldId: null,
    factStatement: 'A claim',
    factOperation: 'add',
    factTargetAnchor: null,
    ...overrides,
  };
}

function capturedProposedMeta(set: ReturnType<typeof vi.fn>) {
  expect(set).toHaveBeenCalledTimes(1);
  const written = set.mock.calls[0][0] as Record<string, unknown>;
  expect(written.proposedMeta).toBeInstanceOf(SQL);
  return dialect.sqlToQuery(written.proposedMeta as SQL);
}

/**
 * Whether this PATCH asked `nextProposedMetaPreservingConflict` to clear an
 * authorized, unchanged-since-snapshot conflict — i.e. `revisesPayload`.
 *
 * NOT a check of the generated SQL text: the CASE now decides in Postgres,
 * against the row's live `conflict`, which the mock never evaluates — so the
 * "THEN ... - 'conflict'" text is present in every query regardless of which
 * branch would actually fire (see `nextProposedMetaPreservingConflict`'s own
 * real-Postgres coverage in tests/integration/pending-edit-conflict-marker.test.ts).
 * `revisesPayload` is the first value ever interpolated into the template, so
 * it is always the first bound parameter.
 */
function revisesPayloadFlag(query: { params: unknown[] }): boolean {
  return query.params[0] === true;
}

// A concurrent approval can stamp a `conflict` marker onto a pending edit's
// proposedMeta without changing its status (markConflictingPendingEdits). The
// PATCH write must not let a stale snapshot erase a marker the actor never saw
// (#592), yet must still let an intentional rebase of a conflict the actor *did*
// see clear it (the review.conflictWarning recovery flow). The write therefore
// emits a SQL guard comparing the row's current conflict against the snapshot's.
describe('/api/pending-edits submitter conflict-marker preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
  });

  it('guards proposedMeta with a snapshot-aware conflict predicate', async () => {
    const { set } = mockDb(pendingEdit());
    const { res } = createResponse();

    await handler(createPatchRequest({ status: 'pending' }), res);

    const { sql, params } = capturedProposedMeta(set);
    // Re-reads and re-applies the row's conflict whenever it isn't an
    // authorized, unchanged-since-snapshot clear, so a concurrent flag cannot
    // be silently erased (#1258: nor can an unacknowledged one).
    expect(sql).toContain('jsonb_exists');
    expect(sql).toContain('IS NOT DISTINCT FROM');
    expect(sql).toContain('jsonb_build_object');
    // The actor's snapshot had no conflict, so the "seen" comparison value is
    // null — any conflict the row now holds is therefore preserved.
    expect(params).toContain(null);
  });

  it('binds the seen conflict so an intentional rebase can clear it', async () => {
    const seenConflict = {
      approvedEditId: 41,
      reviewerId: 9,
      flaggedAt: '2026-06-04T00:00:00.000Z',
    };
    const { set } = mockDb(
      pendingEdit({ proposedMeta: { conflict: seenConflict } }),
    );
    const { res } = createResponse();

    // Submitter resubmits a fresh proposedMeta (no conflict key) — the recovery
    // flow. The guard must compare against the conflict they already saw so the
    // DB CASE falls through to ELSE and the marker is dropped.
    await handler(
      createPatchRequest({ proposedMeta: { note: 'rebased' } }),
      res,
    );

    const { params } = capturedProposedMeta(set);
    expect(params).toContain(JSON.stringify(seenConflict));
    // The submitter's fresh meta (without a conflict key) is the ELSE value,
    // carrying the server's revision marker: this PATCH changed the payload,
    // and "when was it last actually revised" is what an upheld dispute is
    // measured against (`upheldRulingStands`).
    const elseMeta = params.find(
      (p) => typeof p === 'string' && p.includes('"note":"rebased"'),
    ) as string | undefined;
    expect(elseMeta).toBeDefined();
    expect(JSON.parse(elseMeta as string)).toMatchObject({
      note: 'rebased',
      revisedAt: expect.any(String),
    });
  });

  // Carrying a payload field is not the same as changing one: a PATCH that
  // echoes the stored proposal back verbatim is no revision, and must not
  // stamp a marker that would clear an upheld objection to that same content.
  it('stamps no revision marker when the payload is echoed back unchanged', async () => {
    // Step 1: a real revision, to learn what the row then holds. (A wiki_fact
    // PATCH materializes the fact body, so the stored value is not the bare
    // stub the fixture starts from — echoing *that* back would be a change.)
    const first = mockDb(pendingEdit({ proposedMeta: { note: 'as filed' } }));
    await handler(
      createPatchRequest({
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
        proposedMeta: { note: 'as filed' },
      }),
      createResponse().res,
    );
    const storedValue = first.set.mock.calls[0][0].proposedValue;

    // Step 2: resubmit exactly that, fields and all. The request carries a
    // full payload — `hasSubmitterPayloadChange` is true — but nothing in it
    // differs, so it is not a revision and stamps no marker.
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
    const { set } = mockDb(
      pendingEdit({
        proposedValue: storedValue,
        proposedMeta: { note: 'as filed' },
      }),
    );

    await handler(
      createPatchRequest({
        proposedValue: storedValue,
        proposedMeta: { note: 'as filed' },
      }),
      createResponse().res,
    );

    const { params } = capturedProposedMeta(set);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('revisedAt')),
    ).toBe(false);
  });

  // Clearing a conflict is what a REBASE earns, and a resubmission that changes
  // nothing has rebased nothing. The review card sends `proposedValue` alone
  // and leaves `proposedMeta` as it found it, so the marker travels in the
  // carried-forward meta — and deciding on "the request carried payload
  // fields" drops it for an author who simply pressed submit again, handing the
  // stale proposal back to the approval path the marker exists to stop.
  it('keeps a seen conflict when the resubmitted payload is unchanged', async () => {
    const seenConflict = { reason: 'direct_admin_write' };
    const first = mockDb(
      pendingEdit({ proposedMeta: { note: 'as filed', conflict: seenConflict } }),
    );
    await handler(
      createPatchRequest({
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
      }),
      createResponse().res,
    );
    const storedValue = first.set.mock.calls[0][0].proposedValue;

    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
    const { set } = mockDb(
      pendingEdit({
        proposedValue: storedValue,
        proposedMeta: { note: 'as filed', conflict: seenConflict },
      }),
    );

    // `proposedValue` only, echoing what is stored — exactly what the card
    // sends on a plain resubmit.
    await handler(
      createPatchRequest({ proposedValue: storedValue }),
      createResponse().res,
    );

    const query = capturedProposedMeta(set);
    // Not authorized to clear: no payload change happened at all.
    expect(revisesPayloadFlag(query)).toBe(false);
    expect(
      query.params.some(
        (p) => typeof p === 'string' && p.includes('direct_admin_write'),
      ),
    ).toBe(true);
  });

  // The same citation set has two spellings — a legacy row holds
  // `referenceId = N` with `referenceIds` null, while echoing that id back
  // arrives as `[N]` — and calling that a revision would clear an upheld
  // ruling over an unchanged proposal.
  it('treats a legacy singular reference and its echoed list as the same set', async () => {
    const { set } = mockDb(
      pendingEdit({
        proposedMeta: { note: 'as filed' },
        referenceId: 11,
        referenceIds: null,
      }),
    );
    const { res } = createResponse();

    await handler(createPatchRequest({ referenceId: 11 }), res);

    const { params } = capturedProposedMeta(set);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('revisedAt')),
    ).toBe(false);
  });

  it('still sees a genuine reference change', async () => {
    const { set } = mockDb(
      pendingEdit({
        proposedMeta: { note: 'as filed' },
        referenceId: 11,
        referenceIds: null,
      }),
    );
    const { res } = createResponse();

    await handler(createPatchRequest({ referenceId: 12 }), res);

    const { params } = capturedProposedMeta(set);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('revisedAt')),
    ).toBe(true);
  });

  // The marker decides whether an upheld objection still stands, so it is the
  // server's to write. It also lives in the one field the client hands over
  // wholesale, and the fingerprint ignores it — so a PATCH carrying nothing
  // but a post-dated marker is a revision by no measure, and must not be
  // stored as one.
  it('discards a client-supplied revision marker', async () => {
    const { set } = mockDb(pendingEdit({ proposedMeta: { note: 'as filed' } }));
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedMeta: {
          note: 'as filed',
          revisedAt: '3000-01-01T00:00:00.000Z',
        },
      }),
      res,
    );

    const { params } = capturedProposedMeta(set);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('3000-01-01')),
    ).toBe(false);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('revisedAt')),
    ).toBe(false);
  });

  it('stamps its own marker when a real revision smuggles one in', async () => {
    const { set } = mockDb(pendingEdit({ proposedMeta: { note: 'as filed' } }));
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedMeta: {
          note: 'rebased',
          revisedAt: '3000-01-01T00:00:00.000Z',
        },
      }),
      res,
    );

    const { params } = capturedProposedMeta(set);
    const elseMeta = params.find(
      (p) => typeof p === 'string' && p.includes('"note":"rebased"'),
    ) as string | undefined;
    expect(elseMeta).toBeDefined();
    const written = JSON.parse(elseMeta as string) as { revisedAt: string };
    expect(written.revisedAt).toEqual(expect.any(String));
    expect(written.revisedAt).not.toContain('3000-01-01');
  });

  // The counterpart: a bare resubmit changes nothing, so it must not stamp a
  // revision marker either — otherwise "resubmit the same content" would read
  // as a rewrite and clear an upheld objection against it.
  it('stamps no revision marker on a resubmit that changes nothing', async () => {
    const { set } = mockDb(pendingEdit({ proposedMeta: { note: 'as filed' } }));
    const { res } = createResponse();

    await handler(createPatchRequest({ status: 'pending' }), res);

    const { params } = capturedProposedMeta(set);
    expect(
      params.some((p) => typeof p === 'string' && p.includes('revisedAt')),
    ).toBe(false);
  });

  it('drops the seen conflict when revising proposedValue only (review card)', async () => {
    // PendingEditCard.handleReviseAndResubmit sends status + proposedValue but
    // no fresh proposedMeta, so nextMeta carries the conflict forward. A
    // payload revision must still strip it via the ELSE branch.
    const { set } = mockDb(
      pendingEdit({ proposedMeta: { conflict: { approvedEditId: 41 } } }),
    );
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        status: 'pending',
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
      }),
      res,
    );

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(true);
  });

  it('keeps the conflict on a plain resubmit with no payload change', async () => {
    // No payload change means no rebase: revisesPayload must be false, so a
    // stale edit cannot be made approvable without rebasing.
    const { set } = mockDb(
      pendingEdit({
        factOperation: 'replace',
        factTargetAnchor: { factId: 'fact-1' },
        proposedMeta: { conflict: { approvedEditId: 41 } },
      }),
    );
    const { res } = createResponse();

    await handler(createPatchRequest({ status: 'pending' }), res);

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(false);
  });
});

/**
 * A conflict marker says the entry moved under this proposal, which still holds
 * a full-replacement patch built against the old row. Clearing it is a claim:
 * "I have rebased." Only a change to what the proposal would WRITE can make
 * that claim — commentary about the proposal cannot.
 *
 * The signal was a whole-payload fingerprint, and `proposedMeta` is inside it.
 * So an author who owned a conflicted `param_entry` proposal could reword their
 * own `editSummary`, watch the marker vanish with the entry patch untouched,
 * and have the next approval overwrite the admin, import or merge write the
 * marker was announcing — reading and source quote together. Commentary
 * standing in for a rebase.
 */
// A new fact or a new section has no stale content to rebase: approval
// re-checks its section anchor against the live page. A plain resubmit is
// therefore the author's whole answer to a sibling-approval marker.
describe('/api/pending-edits — resubmitting an additive wiki edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
  });

  it('clears the marker on a plain resubmit of a new fact', async () => {
    const { set } = mockDb(
      pendingEdit({ proposedMeta: { conflict: { approvedEditId: 41 } } }),
    );
    await handler(createPatchRequest({ status: 'pending' }), createResponse().res);
    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(true);
  });

  it('clears the marker on a plain resubmit of a new section', async () => {
    const { set } = mockDb(
      pendingEdit({
        editType: 'wiki_section',
        factOperation: null,
        factStatement: null,
        proposedValue: {
          operation: 'add',
          headingText: 'Farmakologi',
          headingLevel: 2,
          position: 2,
        },
        proposedMeta: { conflict: { approvedEditId: 41 } },
      }),
    );
    await handler(createPatchRequest({ status: 'pending' }), createResponse().res);
    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(true);
  });

  it('keeps the marker on a plain resubmit of a section rename', async () => {
    const { set } = mockDb(
      pendingEdit({
        editType: 'wiki_section',
        factOperation: null,
        factStatement: null,
        proposedValue: { operation: 'edit', headingText: 'Nytt navn' },
        proposedMeta: { conflict: { approvedEditId: 41 } },
      }),
    );
    await handler(createPatchRequest({ status: 'pending' }), createResponse().res);
    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(false);
  });
});

describe('/api/pending-edits — only a rebase clears a conflict', () => {
  const conflict = { reason: 'direct_admin_write', id: 'marker-1' };

  // A `param_entry` update patch REPLACES the whole row, so every field is
  // stated — which is exactly why a stale one is dangerous enough to warrant a
  // conflict marker in the first place.
  const patch = (over: Record<string, unknown> = {}) => ({
    low: 8,
    high: 10,
    median: 9,
    unit: 'h',
    citationId: 5,
    ...over,
  });

  const conflictedEntryEdit = (overrides: Record<string, unknown> = {}) =>
    pendingEdit({
      editType: 'param_entry',
      parameter: 'halfLife',
      targetId: 88,
      sectionId: null,
      factStatement: null,
      factOperation: null,
      referenceId: 5,
      referenceIds: [5],
      proposedValue: { op: 'update', patch: patch() },
      proposedMeta: { editSummary: 'From the label.', conflict },
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
  });

  it('KEEPS the marker when only the edit summary is reworded', async () => {
    const { set } = mockDb(conflictedEntryEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedValue: { op: 'update', patch: patch() },
        proposedMeta: { editSummary: 'Reworded.', conflict },
      }),
      res,
    );

    // Not authorized to clear: nothing about this request revised what the
    // proposal would write.
    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(false);
  });

  it('still CLEARS the marker when the patch is rebased AND the marker id is acknowledged', async () => {
    const { set } = mockDb(conflictedEntryEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        // The reading now matches what the admin wrote: a real rebase.
        proposedValue: { op: 'update', patch: patch({ high: 12, median: 11 }) },
        proposedMeta: { editSummary: 'From the label.', conflict },
        // The id of the marker the review card showed before this revision
        // (#1258) — without it, content alone is not enough (see below).
        acknowledgedConflictId: conflict.id,
      }),
      res,
    );

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(true);
  });

  // #1258: revising WITHOUT acknowledging the marker id proves the author did
  // something, not that they reconciled with what they were warned about.
  it('KEEPS the marker when the patch is rebased but the marker id is not acknowledged', async () => {
    const { set } = mockDb(conflictedEntryEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedValue: { op: 'update', patch: patch({ high: 12, median: 11 }) },
        proposedMeta: { editSummary: 'From the label.', conflict },
        // No acknowledgedConflictId at all.
      }),
      res,
    );

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(false);
  });

  // A stale ack — the id of a marker superseded by a newer one — must not
  // pass either: the id the client saw is not the id on the row.
  it('KEEPS the marker when the acknowledged id does not match the current marker', async () => {
    const { set } = mockDb(conflictedEntryEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedValue: { op: 'update', patch: patch({ high: 12, median: 11 }) },
        proposedMeta: { editSummary: 'From the label.', conflict },
        acknowledgedConflictId: 'some-other-marker',
      }),
      res,
    );

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(false);
  });

  // The reference set is part of what the proposal asserts, so moving it is a
  // rebase too — and it is the change a contributor makes when the admin's
  // write was to re-cite the observation.
  it('CLEARS the marker when the cited source is rebased AND the marker id is acknowledged', async () => {
    const { set } = mockDb(conflictedEntryEdit());
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        referenceIds: [6],
        proposedValue: { op: 'update', patch: patch({ citationId: 6 }) },
        proposedMeta: { editSummary: 'From the label.', conflict },
        acknowledgedConflictId: conflict.id,
      }),
      res,
    );

    expect(revisesPayloadFlag(capturedProposedMeta(set))).toBe(true);
  });
});
