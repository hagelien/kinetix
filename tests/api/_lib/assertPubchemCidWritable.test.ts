import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import {
  assertPubchemCidWritable,
  ParameterApplyError,
} from '../../../api/_lib/drugs-helpers.js';

/** Each `select()` chain resolves to the next queued row list. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  getDbMock.mockReturnValue({
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
  });
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
