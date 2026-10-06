/**
 * The apply-time re-check of an ingested fact's unread papers
 * (`pendingEditCitesUnreadSources`) must serialize with that review evidence
 * disappearing — a pending review withdrawn, or a live one losing its
 * read-in-full attestation — so both kinds of row are locked through the
 * fact's commit, pending reviews first (the order a review approval writes
 * them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { lockPendingEditSourceReviews } from '../../api/_lib/agent-verifications.ts';

function recordingDb() {
  const locks: Array<{ table: string; mode: string }> = [];
  const db = {
    select: () => ({
      from: (table: PgTable) => ({
        where: () => ({
          orderBy: () => ({
            for: (mode: string) => {
              locks.push({ table: getTableName(table), mode });
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    }),
  };
  return { db, locks };
}

describe('lockPendingEditSourceReviews', () => {
  beforeEach(() => getDbMock.mockReset());

  it('locks pending reviews, then live reviews, FOR SHARE', async () => {
    const { db, locks } = recordingDb();
    getDbMock.mockReturnValue(db);
    await lockPendingEditSourceReviews({
      proposedMeta: { unverifiedReferenceIds: [7] },
      proposedValue: { attrs: { referenceIds: [7, 3] } },
      referenceIds: [7, 3],
      referenceId: 7,
    });
    expect(locks).toEqual([
      { table: 'pending_edits', mode: 'share' },
      { table: 'paper_reviews', mode: 'share' },
    ]);
  });

  it('takes no lock for an edit ingestion did not mark, or one citing nothing', async () => {
    const { db, locks } = recordingDb();
    getDbMock.mockReturnValue(db);
    // Cited references alone do not make an edit one ingestion marked.
    const cited = {
      proposedValue: { attrs: { referenceIds: [3] } },
      referenceIds: [3],
      referenceId: 3,
    };
    await lockPendingEditSourceReviews({ ...cited, proposedMeta: { source: 'x' } });
    await lockPendingEditSourceReviews({ ...cited, proposedMeta: null });
    await lockPendingEditSourceReviews({
      proposedMeta: { unverifiedReferenceIds: [] },
      proposedValue: null,
      referenceIds: null,
      referenceId: null,
    });
    expect(locks).toEqual([]);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

describe('the ingestion marker and the payload fingerprint', () => {
  // The marker is server-owned: a client cannot write it, so a request that
  // only forges or omits it must not read as a revision — that would stamp a
  // fresh `revisedAt` and clear a ruling or return against unchanged content.
  it('ignores the marker keys when fingerprinting a payload', async () => {
    const { pendingEditPayloadFingerprint } = await import(
      '../../api/_lib/pending-edit-review-token.ts'
    );
    const base = {
      proposedValue: { type: 'fact', attrs: { factId: 'f-1', referenceIds: [3] } },
      referenceIds: [3],
      referenceId: 3,
    };
    const stored = pendingEditPayloadFingerprint({
      ...base,
      proposedMeta: {
        editSummary: 'x',
        unverifiedReferenceIds: [3],
        unverifiedSourceKeys: ['S1'],
      },
    });
    for (const proposedMeta of [
      { editSummary: 'x' },
      { editSummary: 'x', unverifiedReferenceIds: [], unverifiedSourceKeys: [] },
    ]) {
      expect(pendingEditPayloadFingerprint({ ...base, proposedMeta })).toBe(stored);
    }
  });
});
