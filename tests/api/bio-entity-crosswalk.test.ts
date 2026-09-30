import { describe, it, expect, vi } from 'vitest';
import { bioEntityIdsForSource } from '../../api/_lib/bioEntityCrosswalk';

/**
 * Minimal stand-in for the drizzle query builder: `select().from().where()`
 * resolves to the provided rows. Records the call so we can assert the helper
 * short-circuits an empty id list without touching the DB.
 */
function stubDb(rows: Array<{ sourceId: number; entityId: number }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select, from, where };
}

describe('bioEntityIdsForSource', () => {
  it('returns an empty map and issues no query for an empty id list', async () => {
    const { db, select } = stubDb([]);
    const result = await bioEntityIdsForSource(db, 'enzyme', []);
    expect(result.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it('skips the query when all ids are non-integers', async () => {
    const { db, select } = stubDb([]);
    const result = await bioEntityIdsForSource(db, 'enzyme', [
      NaN,
      undefined as unknown as number,
    ]);
    expect(result.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it('maps legacy source ids to bio_entity ids', async () => {
    const { db } = stubDb([
      { sourceId: 7, entityId: 101 },
      { sourceId: 9, entityId: 103 },
    ]);
    const result = await bioEntityIdsForSource(db, 'receptor_target', [7, 9, 7]);
    expect(result.get(7)).toBe(101);
    expect(result.get(9)).toBe(103);
    expect(result.size).toBe(2);
  });
});
