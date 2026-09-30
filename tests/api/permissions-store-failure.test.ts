import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What happens to a capability check when the matrix itself cannot be read.
 *
 * The distinction under test: an *unconfigured* store (no `getConfigDb` — the
 * unit-test seam) means the shipped defaults are the policy, while an
 * *unreachable* store means the policy is unknown and the check must deny,
 * since an admin may have raised the capability above its default.
 */

const { getConfigDbMock, withDbRetryMock } = vi.hoisted(() => ({
  getConfigDbMock: vi.fn(),
  withDbRetryMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  getConfigDb: getConfigDbMock,
  runInPoolTransaction: vi.fn(),
  withDbRetry: withDbRetryMock,
}));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: vi.fn() }));

import {
  callerCan,
  callerCanReadWikiPage,
  invalidatePermissionOverridesCache,
  loadPermissionOverrides,
  resetPermissionOverridesForTests,
} from '../../api/_lib/permissions-store.ts';

/** A query builder whose awaited result is `rows`. */
function builderFor(rows: unknown[]) {
  const builder = {
    select: () => builder,
    from: () => Promise.resolve(rows),
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPermissionOverridesForTests();
  // The real withDbRetry just runs the thunk (and retries transient errors).
  withDbRetryMock.mockImplementation((fn: () => Promise<unknown>) => fn());
});

describe('capability checks when the matrix is unreadable', () => {
  it('denies a check whose answer the matrix could change', async () => {
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });

    // contributor + edit.parameter.submit is exactly the case an override
    // could flip, so an unknown policy must not fall back to the default.
    expect(await callerCan('contributor', 'edit.parameter.submit')).toBe(false);
  });

  it('still admits an admin and still denies below the floor without reading', async () => {
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });

    // No override can take a capability away from admin...
    expect(await callerCan('admin', 'edit.parameter.submit')).toBe(true);
    // ...nor grant one below its floor.
    expect(await callerCan('contributor', 'edit.directWrite')).toBe(false);
    expect(getConfigDbMock).not.toHaveBeenCalled();
  });

  it('serves the last known matrix rather than denying, once one has loaded', async () => {
    getConfigDbMock.mockReturnValueOnce(
      builderFor([{ capability: 'review.edit.decide', minTier: 'contributor' }]),
    );
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(true);

    // Expire the cache, then fail the refresh.
    resetCacheOnly();
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(true);
  });

  it('denies draft visibility, but still serves published pages', async () => {
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });

    // Published content is public, so no policy read is involved at all.
    expect(await callerCanReadWikiPage('published', { role: 'editor' })).toBe(
      true,
    );
    // A draft is a real access decision; unknown policy denies.
    expect(await callerCanReadWikiPage('draft', { role: 'editor' })).toBe(false);
  });

  it('forgets the last known matrix once a write commits', async () => {
    getConfigDbMock.mockReturnValueOnce(
      builderFor([{ capability: 'review.edit.decide', minTier: 'contributor' }]),
    );
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(true);

    // A save has landed, so the matrix this instance remembers is stale — it
    // must not be served if the next read fails.
    invalidatePermissionOverridesCache();
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });
    expect(await callerCan('contributor', 'review.edit.decide')).toBe(false);
  });

  it('falls back to defaults for the display-only load', async () => {
    getConfigDbMock.mockImplementation(() => {
      throw new Error('connection reset');
    });
    expect(await loadPermissionOverrides()).toEqual({});
  });
});

/**
 * Expire the TTL cache while keeping the last-known matrix, which is what a
 * cold read after a successful one looks like.
 */
function resetCacheOnly(): void {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60_000);
  vi.useRealTimers();
}
