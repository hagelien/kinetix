import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  getConfigDb: vi.fn(),
  runInPoolTransaction: vi.fn(),
  withDbRetry: vi.fn(),
  afterTransactionCommit: vi.fn(),
}));

import { hasParameterBag } from '../../api/pending-edits.ts';

/**
 * Approving a `wiki_new` draft that carries parameter values publishes
 * drug-parameter revisions, so the approval requires `edit.parameter.submit`
 * on top of the page-approval capability — the same rule the create endpoint
 * applies. This is the predicate that decides whether the extra check runs.
 */
describe('hasParameterBag', () => {
  it('is true only for a bag with values in it', () => {
    expect(hasParameterBag({ parameters: { halfLife: { min: 1 } } })).toBe(true);
  });

  it.each([
    ['no meta at all', null],
    ['meta without the key', { title: 'Kokain' }],
    ['an empty bag', { parameters: {} }],
    ['a null bag', { parameters: null }],
    ['a non-object bag', { parameters: 'halfLife' }],
  ])('is false for %s', (_label, meta) => {
    expect(hasParameterBag(meta)).toBe(false);
  });
});
