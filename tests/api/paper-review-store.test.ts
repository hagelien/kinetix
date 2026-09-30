import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  clearVerificationsForTargetMock,
  recordImplicitAgentApprovalMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  clearVerificationsForTargetMock: vi.fn(),
  recordImplicitAgentApprovalMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  clearVerificationsForTarget: clearVerificationsForTargetMock,
  recordImplicitAgentApproval: recordImplicitAgentApprovalMock,
}));
// The review write now reconciles caches for parameters citing the paper; that
// path has its own integration coverage, so stub it here to keep this a focused
// unit test of the review upsert against the mock DB.
vi.mock('../../api/_lib/parameter-entries-store.js', () => ({
  recomputeSummariesCitingCitation: vi.fn(async () => undefined),
}));

import {
  recordPaperReview,
  listPaperReviewHistory,
} from '../../api/_lib/paper-review-store.ts';
import {
  paperReviews,
  paperReviewRevisions,
} from '../../db/schema.ts';

describe('recordPaperReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVerificationsForTargetMock.mockResolvedValue(0);
    recordImplicitAgentApprovalMock.mockResolvedValue({ id: 1 });
  });

  it('upserts the live review, appends a revision, and resets peer signals', async () => {
    const captured: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const insert = vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        captured.push({ table, values });
        if (table === paperReviews) {
          return {
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([{ id: 5 }]),
            }),
          };
        }
        return { returning: () => Promise.resolve([{ id: 7 }]) };
      },
    }));
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn(() => ({ where: deleteWhere }));
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: () => ({ where: updateWhere }) }));
    // The prior-score lookup: no existing review → [] → priorScore null.
    const selectLimit = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: selectLimit }) }),
    }));
    getDbMock.mockReturnValue({ insert, delete: del, update, select });

    const result = await recordPaperReview({
      citationId: 12,
      authorUserId: 42,
      input: {
        reviewMarkdown: 'Vurdering',
        overallScore: 88,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
        editSummary: 'Justert etter fulltekst',
      },
    });

    expect(result).toEqual({ id: 5, citationId: 12, revisionId: 7 });

    const reviewInsert = captured.find((c) => c.table === paperReviews);
    expect(reviewInsert?.values).toMatchObject({
      citationId: 12,
      reviewMarkdown: 'Vurdering',
      overallScore: 88,
      readInFull: true,
      createdBy: 42,
    });

    const revInsert = captured.find((c) => c.table === paperReviewRevisions);
    expect(revInsert?.values).toMatchObject({
      paperReviewId: 5,
      citationId: 12,
      reviewMarkdown: 'Vurdering',
      editSummary: 'Justert etter fulltekst',
      createdBy: 42,
    });

    // Stale peer verdicts wiped + author's implicit approval re-stamped, both
    // against the live paper_reviews row.
    expect(clearVerificationsForTargetMock).toHaveBeenCalledWith({
      targetType: 'paper_review',
      targetId: 5,
    });
    expect(recordImplicitAgentApprovalMock).toHaveBeenCalledWith({
      userId: 42,
      targetType: 'paper_review',
      targetId: 5,
    });
    // A read-in-full review means the paper was obtained, so the open PDF
    // request for the citation is closed.
    expect(update).toHaveBeenCalled();
    expect(updateWhere).toHaveBeenCalled();
  });

  it('leaves the open PDF request alone for a not-read-in-full review', async () => {
    // `readInFull: false` is an abstract-only review or a withdrawn
    // attestation — the full text is precisely what is still missing, so
    // cancelling the request would retract the one signal that gets it
    // supplied while every citing fact stays blocked by
    // `reference_not_judged`. Nothing reopens a request afterwards.
    const insert = vi.fn((table: unknown) => ({
      values: () => {
        if (table === paperReviews) {
          return {
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([{ id: 5 }]),
            }),
          };
        }
        return { returning: () => Promise.resolve([{ id: 7 }]) };
      },
    }));
    const del = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: () => ({ where: updateWhere }) }));
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
    }));
    getDbMock.mockReturnValue({ insert, delete: del, update, select });

    await recordPaperReview({
      citationId: 12,
      authorUserId: 42,
      input: {
        reviewMarkdown: 'Kun sammendrag tilgjengelig',
        overallScore: null,
        conclusionSupport: null,
        reviewConfidence: 'low',
        readInFull: false,
        editSummary: null,
      },
    });

    expect(update).not.toHaveBeenCalled();
    expect(updateWhere).not.toHaveBeenCalled();
  });
});

describe('listPaperReviewHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps revision rows newest-first with author + ISO timestamps', async () => {
    const rows = [
      {
        id: 3,
        reviewMarkdown: 'Nyeste',
        overallScore: 90,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
        editSummary: 'Oppdatert',
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        authorId: 42,
        authorUsername: 'agent',
        authorDisplayName: 'Kinetix Agent',
        authorRole: 'contributor',
        isAgent: true,
      },
    ];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const leftJoin2 = vi.fn().mockReturnValue({ where });
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 });
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 });
    const select = vi.fn().mockReturnValue({ from });
    getDbMock.mockReturnValue({ select });

    const result = await listPaperReviewHistory(12);

    expect(result).toEqual([
      {
        id: 3,
        reviewMarkdown: 'Nyeste',
        overallScore: 90,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
        editSummary: 'Oppdatert',
        createdAt: '2026-07-01T10:00:00.000Z',
        author: {
          id: 42,
          username: 'agent',
          displayName: 'Kinetix Agent',
          role: 'contributor',
          isAgent: true,
        },
      },
    ]);
  });
});
