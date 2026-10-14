/**
 * Entity creation must hold the "Bioentiteter" hub row through its commit
 * (issue #191). The hub lookup in `ensureEntityHubPage` share-locks the row, so
 * a concurrent PUT or DELETE of the hub page waits for the new monograph to
 * commit under it, and one that commits first is seen by the locked read.
 * PGlite has one connection and cannot reproduce the interleaving, so this
 * pins the lock itself: the lookup is a `FOR SHARE` read on `wiki_pages`, and
 * the usability check runs on what that locked read returned.
 */
import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ensureEntityHubPage } from '../../api/_lib/monograph-helpers.ts';

type HubRow = { id: number; pageType: string; status: string };

function recordingDb(hub: HubRow) {
  const locks: Array<{ table: string; mode: string }> = [];
  const db = {
    select: () => ({
      from: (table: PgTable) => ({
        where: () => ({
          limit: () => ({
            for: (mode: string) => {
              locks.push({ table: getTableName(table), mode });
              return Promise.resolve([hub]);
            },
          }),
        }),
      }),
    }),
    insert: () => {
      throw new Error('an existing hub must not be re-inserted');
    },
  };
  return {
    db: db as unknown as Parameters<typeof ensureEntityHubPage>[0],
    locks,
  };
}

describe('ensureEntityHubPage', () => {
  it('share-locks the hub row it reuses', async () => {
    const { db, locks } = recordingDb({
      id: 42,
      pageType: 'topic',
      status: 'published',
    });
    await expect(ensureEntityHubPage(db, 1)).resolves.toBe(42);
    expect(locks).toEqual([{ table: 'wiki_pages', mode: 'share' }]);
  });

  it('refuses a hub the locked read finds demoted', async () => {
    const { db, locks } = recordingDb({
      id: 42,
      pageType: 'topic',
      status: 'draft',
    });
    await expect(ensureEntityHubPage(db, 1)).rejects.toThrow(
      /must be a published topic page/,
    );
    expect(locks).toEqual([{ table: 'wiki_pages', mode: 'share' }]);
  });
});
