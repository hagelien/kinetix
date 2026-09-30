import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  getDbMock,
  getUserFromRequestMock,
  applyApprovedEditMock,
  isActiveAgentUserMock,
  isSelfReviewAgentUserMock,
  hasOpenDisputeMock,
  unresolvedDisputeVerdictCountMock,
  upheldDisputeStandsMock,
  summariseVerificationsMock,
  notifyContributionFeedbackMock,
} = vi.hoisted(() => ({
  notifyContributionFeedbackMock: vi.fn(),
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  applyApprovedEditMock: vi.fn(),
  isActiveAgentUserMock: vi.fn(),
  isSelfReviewAgentUserMock: vi.fn(),
  hasOpenDisputeMock: vi.fn(),
  unresolvedDisputeVerdictCountMock: vi.fn(),
  upheldDisputeStandsMock: vi.fn(),
  summariseVerificationsMock: vi.fn(),
}));

vi.mock('../../api/_lib/agent-verifications.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../api/_lib/agent-verifications.js')>();
  return {
    ...actual,
    isActiveAgentUser: isActiveAgentUserMock,
    isSelfReviewAgentUser: isSelfReviewAgentUserMock,
    summariseVerificationsForTargets: summariseVerificationsMock,
  };
});

vi.mock('../../api/_lib/notifications.js', async (importActual) => ({
  ...(await importActual<typeof import('../../api/_lib/notifications.js')>()),
  notifyContributionFeedback: notifyContributionFeedbackMock,
}));

vi.mock('../../api/_lib/disputes.js', () => ({
  hasOpenDispute: hasOpenDisputeMock,
  unresolvedDisputeVerdictCount: unresolvedDisputeVerdictCountMock,
  upheldDisputeStands: upheldDisputeStandsMock,
  upheldDisputeResolvedAt: vi.fn(async () => new Map()),
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
  applyApprovedEdit: applyApprovedEditMock,
  assertReferencesJudged: vi.fn(),
  assertReferencesJudgedForActor: vi.fn(),
  ReferenceGateError: class ReferenceGateError extends Error {
    constructor(public readonly unjudgedCitationIds: number[] = []) {
      super('reference gate failed');
    }
  },
  WikiFactApprovalError: class WikiFactApprovalError extends Error {
    statusHint = 400;
  },
  PendingEditReviewTokenMismatchError: class PendingEditReviewTokenMismatchError extends Error {
    statusHint = 409;
    code = 'pending_edit_review_token_mismatch';
  },
}));

import handler from '../../api/pending-edits.ts';
import { pendingEditReviewToken } from '../../api/_lib/pending-edit-review-token.ts';

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
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        return res;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function mockDbWithPendingEdit(
  edit: Record<string, unknown>,
  updateResult: Array<Record<string, unknown>> = [{ id: 7 }],
) {
  const limit = vi.fn().mockResolvedValue([edit]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const returning = vi.fn().mockResolvedValue(updateResult);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  getDbMock.mockReturnValue({ select, update });
  return { update, updateWhere, returning, set };
}

function pendingEdit(status: 'draft' | 'pending' | 'returned') {
  return {
    id: 7,
    editType: 'wiki_fact',
    status,
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
    submittedAt: new Date('2026-06-12T01:00:00.000Z'),
  };
}

describe('/api/pending-edits reviewer status guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 99,
      role: 'editor',
    });
    // Default: neither the reviewer nor the submitter backs an agent.
    isActiveAgentUserMock.mockResolvedValue(false);
    // Default: nobody is cleared to review their own work.
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    // Default: nothing is contested.
    hasOpenDisputeMock.mockResolvedValue(false);
    summariseVerificationsMock.mockResolvedValue(new Map());
    unresolvedDisputeVerdictCountMock.mockResolvedValue(0);
    // Default: no objection has been upheld against the current payload.
    upheldDisputeStandsMock.mockResolvedValue(false);
    notifyContributionFeedbackMock.mockResolvedValue({ notified: true });
  });

  it('tells the submitter about a rejection, with the reviewer comment', async () => {
    const edit = pendingEdit('pending');
    mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        rejectionComment: 'The cited table reports a different population.',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(notifyContributionFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 12,
        actorUserId: 99,
        type: 'edit_rejected',
        bodyMd: 'The cited table reports a different population.',
      }),
    );
  });

  it('does not let reviewers approve draft edits', async () => {
    const db = mockDbWithPendingEdit(pendingEdit('draft'));
    const { res, state } = createResponse();

    await handler(createPatchRequest({ status: 'approved' }), res);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_not_reviewable',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not let reviewers reject returned edits before resubmission', async () => {
    const db = mockDbWithPendingEdit(pendingEdit('returned'));
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_not_reviewable',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects approval when the review token is stale', async () => {
    const db = mockDbWithPendingEdit(pendingEdit('pending'));
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: 'stale-review-token',
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_review_token_mismatch',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects reviewer rejection when the review token is stale', async () => {
    const db = mockDbWithPendingEdit(pendingEdit('pending'));
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        reviewToken: 'stale-review-token',
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_review_token_mismatch',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects reviewer return when the review token is stale', async () => {
    const db = mockDbWithPendingEdit(pendingEdit('pending'));
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        returnComment: 'Please revise',
        reviewToken: 'stale-review-token',
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_review_token_mismatch',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects reviewer rejection when the row changes before the write', async () => {
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit, []);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_update_conflict',
    });
    expect(db.update).toHaveBeenCalled();
    expect(db.returning).toHaveBeenCalled();
  });

  // Agents verify human submissions (that is how they stop waiting unseen),
  // but approving one is a moderator's decision. An agent holding an editor
  // role must not take that decision through the review path either.
  it('blocks an agent reviewer from approving a human-submitted edit', async () => {
    const AGENT_USER_ID = 8;
    getUserFromRequestMock.mockResolvedValue({
      userId: AGENT_USER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockImplementation(
      async (userId: number) => userId === AGENT_USER_ID,
    );
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_moderation_of_human_edit_not_allowed',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  it('still lets an agent reviewer moderate another agent’s edit', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 8, role: 'editor' });
    isActiveAgentUserMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(db.update).toHaveBeenCalled();
  });

  // Nobody approves their own proposal. This is the rule the admin panel's
  // self-review switch is an exception to — with the switch off (the default),
  // an editor-tier agent PATCHing its own edit is refused like anyone else.
  it('blocks a submitter from approving their own edit by default', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'approval_self_not_allowed',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // …and with agents.self_review_enabled on for that agent, it goes through.
  // Note what still has to hold: the caller is an editor (canReview), so the
  // flag alone does not confer moderation rights on a contributor-tier agent.
  it('lets a self-review agent approve its own edit', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockImplementation(
      async (userId: number) => userId === SUBMITTER_ID,
    );
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    // The approval itself is what we are asserting; the enrichment read that
    // follows needs a fuller DB than this harness mocks.
    expect(state.statusCode).not.toBe(403);
    expect(applyApprovedEditMock).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('lets a self-review agent return its own edit', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        returnComment: 'Needs a second source',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(db.update).toHaveBeenCalled();
  });

  // Safety-critical: a clinical case is published by a human expert, never by
  // agent consensus (applyOnAgentConsensus refuses it). Self-review must not
  // become a way around that via the moderator path, with the author signing
  // off its own case.
  it('never lets a self-review agent approve its own clinical_case', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    const edit = { ...pendingEdit('pending'), editType: 'clinical_case' };
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'approval_self_not_allowed',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('never lets a self-review agent approve its own model-structure entry', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    const edit = {
      ...pendingEdit('pending'),
      editType: 'param_entry',
      parameter: 'dispositionModel',
      proposedValue: { op: 'create', categoricalValue: 'one-compartment' },
    };
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'approval_self_not_allowed',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // An objection is held for a person. A human moderator may overrule one —
  // that judgment is what a moderator is for — but here the moderator would be
  // the disputed edit's own author.
  it('blocks self-approval while a dispute is open against the edit', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    hasOpenDisputeMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // The mirror into the unified disputes table is a separate write from the
  // verdict, so a bare dispute verdict has to block on its own too.
  it('blocks self-approval on a dispute verdict with no mirrored row', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    hasOpenDisputeMock.mockResolvedValue(false);
    unresolvedDisputeVerdictCountMock.mockResolvedValue(1);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // The counterpart, and the reason the count is of *unresolved* verdicts: a
  // moderator who rules on the objection closes the disputes row, but nothing
  // can close the verdict behind it. Reading the raw verdict tally left the
  // block standing with nothing on the page left to resolve.
  it('lets the author approve once a moderator has ruled on the dispute', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    hasOpenDisputeMock.mockResolvedValue(false);
    unresolvedDisputeVerdictCountMock.mockResolvedValue(0);
    // The verdict itself is still on the record — it is testimony, not a
    // ticket — so the raw tally still reports it.
    summariseVerificationsMock.mockResolvedValue(
      new Map([[7, { approveCount: 0, disputeCount: 1 }]]),
    );
    const edit = pendingEdit('pending');
    mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    // The approval runs: the 403 is gone and the edit is applied. (The mock db
    // has no join support for the post-apply enrichment, so the response code
    // itself is not the assertion here — the same shape the sibling
    // self-approval tests use.)
    expect(state.statusCode).not.toBe(403);
    expect(applyApprovedEditMock).toHaveBeenCalled();
  });

  // …but only when the ruling FREED the proposal. Upholding an objection says
  // it was right, so the one disposition its author may not choose next is
  // approval — otherwise sustaining a dispute against your own edit would be a
  // one-click route to publishing it.
  it('refuses self-approval when the dispute was upheld', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    hasOpenDisputeMock.mockResolvedValue(false);
    unresolvedDisputeVerdictCountMock.mockResolvedValue(0);
    upheldDisputeStandsMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'self_approval_blocked_by_upheld_dispute',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // Returning it is the disposition an upheld objection points at, so that
  // path must stay open — blocking it would trade one dead end for another.
  it('still lets the author return an edit whose dispute was upheld', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    hasOpenDisputeMock.mockResolvedValue(false);
    unresolvedDisputeVerdictCountMock.mockResolvedValue(0);
    upheldDisputeStandsMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        returnComment: 'Innsigelsen har rett — henter fulltekst først.',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(db.update).toHaveBeenCalled();
  });

  // review.edit.decideOwn (default `admin`) is the human grant. Same identity
  // check as above, different answer, because the tier now says yes.
  it('lets an admin approve their own edit', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(applyApprovedEditMock).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('lets an admin return their own edit', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        returnComment: 'Parking this until I have the second source',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(db.update).toHaveBeenCalled();
  });

  // Self-review for agents stays the per-agent grant. Were an agent token ever
  // to carry a role holding decideOwn — today the auth clamp to `editor` stops
  // that, tomorrow an admin lowering the tier would not — it must not become a
  // blanket self-review switch for every agent at once.
  it('does not let the human self-decide grant cover an agent caller', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
    isSelfReviewAgentUserMock.mockResolvedValue(false);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'approval_self_not_allowed',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // The submitter-update branch runs first and only knows how to move a row to
  // pending/draft, so a decision sent alongside a payload change used to be
  // swallowed: 200, payload saved, status untouched. Now that a submitter can
  // legitimately decide, that shape is refused instead of half-applied.
  it('refuses a self-decision sent together with a payload revision', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_decision_with_payload_change',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
  });

  // Withdrawing keeps both of its shapes: `rejected` alone is the own-cancel,
  // and `rejected` with a payload is the submitter revision it always was.
  it('still treats a payload change sent with status rejected as a revision', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(400);
    expect(db.update).toHaveBeenCalled();
  });

  // An admin may overrule a dispute — but not by approving the edit the
  // dispute was raised against. Resolve it first; that is a separate, recorded
  // act. The distinct code is what lets the UI say so.
  it('blocks an admin’s self-approval while a dispute is open', async () => {
    const SUBMITTER_ID = 12;
    getUserFromRequestMock.mockResolvedValue({
      userId: SUBMITTER_ID,
      role: 'admin',
    });
    isActiveAgentUserMock.mockResolvedValue(false);
    hasOpenDisputeMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'self_decision_blocked_by_dispute',
    });
    expect(applyApprovedEditMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // Moderating someone ELSE's edit never consults the self-decide grant, so an
  // open dispute against it stays a moderator's call, exactly as before.
  it('still lets an admin approve a disputed edit submitted by someone else', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 99, role: 'admin' });
    isActiveAgentUserMock.mockResolvedValue(false);
    hasOpenDisputeMock.mockResolvedValue(true);
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).not.toBe(403);
    expect(applyApprovedEditMock).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  // The flag is read off the CALLER's own agent row, so it can never excuse
  // moderating someone else's work — the human-edit rule is untouched.
  it('does not let a self-review agent moderate a human contributor’s edit', async () => {
    const AGENT_USER_ID = 8;
    getUserFromRequestMock.mockResolvedValue({
      userId: AGENT_USER_ID,
      role: 'editor',
    });
    isActiveAgentUserMock.mockImplementation(
      async (userId: number) => userId === AGENT_USER_ID,
    );
    isSelfReviewAgentUserMock.mockResolvedValue(true);
    const edit = pendingEdit('pending'); // submittedBy: 12, a human
    const db = mockDbWithPendingEdit(edit);
    const { res, state } = createResponse();

    await handler(
      createPatchRequest({
        status: 'approved',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_moderation_of_human_edit_not_allowed',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  // The agent dispute loop tells a submitter to answer a peer objection by
  // PATCHing the corrected payload. That revision must stay in the queue: a
  // silent demotion to `draft` pulls the edit out of both the moderator queue
  // and the verification queue, and nothing scans `draft` — a good revision
  // would simply disappear.
  it('keeps a revised pending edit pending when no status is requested', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
    // Empty update result stops the handler right after the write, with the
    // `set` payload already captured.
    const db = mockDbWithPendingEdit(
      {
        ...pendingEdit('pending'),
        factOperation: 'remove',
        factTargetAnchor: { factId: 'fact-1' },
      },
      [],
    );
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
        referenceIds: [5],
      }),
      res,
    );

    expect(db.set).toHaveBeenCalledTimes(1);
    expect(db.set.mock.calls[0][0]).toMatchObject({ status: 'pending' });
  });

  it('still demotes to draft when the submitter asks for it', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
    const db = mockDbWithPendingEdit(
      {
        ...pendingEdit('pending'),
        factOperation: 'remove',
        factTargetAnchor: { factId: 'fact-1' },
      },
      [],
    );
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        status: 'draft',
        proposedValue: { type: 'fact', attrs: { factId: 'fact-1' } },
        referenceIds: [5],
      }),
      res,
    );

    expect(db.set).toHaveBeenCalledTimes(1);
    expect(db.set.mock.calls[0][0]).toMatchObject({ status: 'draft' });
  });

  it('rejects submitter updates when the row changed before the write', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 12,
      role: 'contributor',
    });
    const db = mockDbWithPendingEdit(pendingEdit('pending'), []);
    const { res, state } = createResponse();

    await handler(createPatchRequest({ status: 'draft' }), res);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pending_edit_update_conflict',
    });
    expect(db.update).toHaveBeenCalled();
    expect(db.returning).toHaveBeenCalled();
  });

  // The reviewer write is locked on (id, status, submitted_at): the
  // reviewToken check upstream only covers the row as this request read it, so
  // a submitter revision landing in the read→write gap would otherwise be
  // returned or rejected on content the reviewer never saw. submitted_at must
  // be compared **truncated** — the DB `now()` default stores microseconds
  // while drizzle reads a millisecond Date back, so a plain
  // `eq(submittedAt, edit.submittedAt)` never matches a freshly-submitted row
  // and would fail every review with a spurious conflict. That the truncated
  // form matches real rows is covered in
  // tests/integration/pending-edit-reviewer-lock.test.ts.
  function capturedUpdateWhereSql(updateWhere: ReturnType<typeof vi.fn>) {
    expect(updateWhere).toHaveBeenCalledTimes(1);
    const predicate = updateWhere.mock.calls[0][0];
    expect(predicate).toBeInstanceOf(SQL);
    return new PgDialect().sqlToQuery(predicate as SQL).sql;
  }

  it('locks the return write on a truncated submitted_at', async () => {
    const edit = pendingEdit('pending');
    // Force the post-update conflict branch so the handler stops before the
    // (DB-hitting) enrichment step — the WHERE predicate is captured all the
    // same, which is all this assertion needs.
    const db = mockDbWithPendingEdit(edit, []);
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        status: 'returned',
        returnComment: 'Please revise',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    const sql = capturedUpdateWhereSql(db.updateWhere);
    expect(sql).toContain('status');
    expect(sql).toContain("date_trunc('milliseconds'");
    expect(sql).toContain('submitted_at');
  });

  it('locks the reject write on a truncated submitted_at', async () => {
    const edit = pendingEdit('pending');
    const db = mockDbWithPendingEdit(edit, []);
    const { res } = createResponse();

    await handler(
      createPatchRequest({
        status: 'rejected',
        rejectionReason: 'low_quality',
        reviewToken: pendingEditReviewToken(edit),
      }),
      res,
    );

    const sql = capturedUpdateWhereSql(db.updateWhere);
    expect(sql).toContain('status');
    expect(sql).toContain("date_trunc('milliseconds'");
    expect(sql).toContain('submitted_at');
  });
});
