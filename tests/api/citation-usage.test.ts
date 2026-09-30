import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import {
  collectUsedCitationIdsForDrug,
  filterUsedCitationIds,
} from '../../api/_lib/citation-usage';

/**
 * filterUsedCitationIds collapses every visibility source into one SQL UNION,
 * so the mock only needs to model the execute result returned by that query.
 */
function mockDb(opts: { rows?: { citation_id: number }[] }) {
  const execute = vi.fn().mockResolvedValue({ rows: opts.rows ?? [] });
  getDbMock.mockReturnValue({ execute });
  return { execute };
}

describe('filterUsedCitationIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty set without touching the db for no candidates', async () => {
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [])).resolves.toEqual(new Set());
  });

  it('treats a citation with an open PDF request as anchored', async () => {
    const { execute } = mockDb({ rows: [{ citation_id: 462 }] });
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [462])).resolves.toEqual(
      new Set([462]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('treats a citation with a paper review as anchored', async () => {
    mockDb({ rows: [{ citation_id: 576 }] });
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [576])).resolves.toEqual(
      new Set([576]),
    );
  });

  it('returns every requested citation proven by scalar or array anchors', async () => {
    mockDb({ rows: [{ citation_id: 101 }, { citation_id: 202 }] });
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [101, 202, 303])).resolves.toEqual(
      new Set([101, 202]),
    );
  });

  it('still excludes a citation with no anchor anywhere', async () => {
    mockDb({});
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [999])).resolves.toEqual(new Set());
  });

  it('ignores PDF-request/review rows outside the requested candidates', async () => {
    // A stray row whose citationId is not in the candidate list must not leak
    // into the visible set; the SQL query enforces that before returning rows.
    mockDb({});
    const db = getDbMock();
    await expect(filterUsedCitationIds(db, [462])).resolves.toEqual(new Set());
  });
});

describe('collectUsedCitationIdsForDrug', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collects drug citation anchors with one SQL query', async () => {
    const { execute } = mockDb({
      rows: [{ citation_id: 101 }, { citation_id: 202 }, { citation_id: 202 }],
    });
    const db = getDbMock();

    await expect(collectUsedCitationIdsForDrug(db, 42)).resolves.toEqual(
      new Set([101, 202]),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.select).toBeUndefined();
  });
});
