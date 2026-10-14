import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import {
  assertPubchemCidShadowsNoDrug,
  assertPubchemCidWritable,
  findPubchemCidShadows,
  insertDrug,
  ParameterApplyError,
} from '../../../api/_lib/drugs-helpers.js';

/**
 * Each `select()` chain resolves to the next queued row list, whether the
 * caller ends it at `.where()` or goes on to `.limit()`. `insert` records the
 * values it was handed and returns them as the new row.
 */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  const insertValues = vi.fn();
  getDbMock.mockReturnValue({
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () =>
        Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve(rows),
        });
      return chain;
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertValues(v);
        return { returning: () => Promise.resolve([{ id: 501, ...v }]) };
      },
    }),
  });
  return { insertValues, remaining: () => queue.length };
}

describe('assertPubchemCidWritable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to change an existing CID', async () => {
    queueSelects([{ pubchemCid: 2118 }]);
    await expect(assertPubchemCidWritable(42, 9999)).rejects.toMatchObject({
      statusHint: 409,
      code: 'pubchem_cid_change_refused',
    });
  });

  it('refuses to clear an existing CID', async () => {
    queueSelects([{ pubchemCid: 2118 }]);
    await expect(assertPubchemCidWritable(42, null)).rejects.toBeInstanceOf(
      ParameterApplyError,
    );
  });

  it('allows re-sending the same CID', async () => {
    queueSelects([{ pubchemCid: 2118 }]);
    await expect(assertPubchemCidWritable(42, 2118)).resolves.toBeUndefined();
  });

  it('allows a first CID that shadows no drug id', async () => {
    queueSelects([{ pubchemCid: null }], []);
    await expect(assertPubchemCidWritable(42, 2118)).resolves.toBeUndefined();
  });

  it('refuses a first CID equal to another CID-less drug\'s id', async () => {
    queueSelects([{ pubchemCid: null }], [{ id: 2118 }]);
    await expect(assertPubchemCidWritable(42, 2118)).rejects.toMatchObject({
      statusHint: 409,
      code: 'pubchem_cid_shadows_drug_id',
    });
  });
});

describe('assertPubchemCidShadowsNoDrug', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a CID equal to a CID-less drug\'s id, naming the drug', async () => {
    queueSelects([{ id: 77 }]);
    const err = await assertPubchemCidShadowsNoDrug(77, null).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ParameterApplyError);
    expect(err).toMatchObject({
      statusHint: 409,
      code: 'pubchem_cid_shadows_drug_id',
    });
    expect((err as Error).message).toContain('internal id of drug 77');
  });

  it('allows a CID that shadows nothing', async () => {
    queueSelects([]);
    await expect(assertPubchemCidShadowsNoDrug(2118, null)).resolves.toBeUndefined();
  });
});

describe('findPubchemCidShadows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not query for numbers no drug id can hold', async () => {
    const { remaining } = queueSelects([{ id: 1 }]);
    await expect(
      findPubchemCidShadows([0, -3, 1.5, 2147483648, Number.NaN], null),
    ).resolves.toEqual([]);
    expect(remaining()).toBe(1);
  });

  it('returns the shadowed ids sorted', async () => {
    queueSelects([{ id: 30 }, { id: 4 }]);
    await expect(findPubchemCidShadows([30, 4, 30, 999], null)).resolves.toEqual([
      4, 30,
    ]);
  });
});

describe('insertDrug', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a CID that shadows a CID-less drug before inserting anything', async () => {
    const { insertValues } = queueSelects([{ id: 12 }]);
    await expect(
      insertDrug({ names: { nb: 'Nytt stoff' } as never, pubchemCid: 12 }),
    ).rejects.toMatchObject({
      statusHint: 409,
      code: 'pubchem_cid_shadows_drug_id',
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('inserts a CID that shadows nothing', async () => {
    const { insertValues } = queueSelects([]);
    const row = await insertDrug({
      names: { nb: 'Nytt stoff' } as never,
      pubchemCid: 2118,
    });
    expect(row.pubchemCid).toBe(2118);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ pubchemCid: 2118 }),
    );
  });

  it('runs no shadow query for a CID-less drug', async () => {
    const { insertValues, remaining } = queueSelects([{ id: 1 }]);
    await insertDrug({ names: { nb: 'Nytt stoff' } as never });
    expect(remaining()).toBe(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
  });
});
