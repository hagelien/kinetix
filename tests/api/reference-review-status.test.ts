import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import { findCitationsNeedingFullReview } from '../../api/_lib/reference-review-status';

// The helper issues one query: select().from().leftJoin().where() which resolves
// to the flagged rows (resolvable citations with no read-in-full review). The
// mock returns those rows; the chain just needs to be constructable.
function mockDb(flaggedRows: Array<{ id: number }>) {
  const where = vi.fn().mockResolvedValue(flaggedRows);
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, where };
}

describe('findCitationsNeedingFullReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty set and never touches the db for no ids', async () => {
    const { select } = mockDb([]);
    await expect(findCitationsNeedingFullReview([])).resolves.toEqual(
      new Set(),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('flags the resolvable citations the query returns', async () => {
    // The SQL already excludes freetext and citations with a read-in-full
    // review, so whatever rows come back are the flagged set.
    mockDb([{ id: 7 }, { id: 9 }]);
    await expect(findCitationsNeedingFullReview([7, 8, 9])).resolves.toEqual(
      new Set([7, 9]),
    );
  });

  it('returns an empty set when every cited reference is reviewed', async () => {
    mockDb([]);
    await expect(findCitationsNeedingFullReview([1, 2, 3])).resolves.toEqual(
      new Set(),
    );
  });

  it('dedupes and ignores non-positive ids before querying', async () => {
    const { where } = mockDb([]);
    await findCitationsNeedingFullReview([5, 5, 0, -1, 3.5]);
    // Only one query is built; invalid ids are filtered in JS beforehand.
    expect(where).toHaveBeenCalledTimes(1);
  });
});
