/**
 * Regression test for #1356: `assertReferencesJudged` must work from inside
 * `runInPoolTransaction()`, not just on the ordinary neon-http path.
 *
 * The bug was `db.batch()` — a neon-http-only method — called on whatever
 * `getDb()` returns. Outside a transaction that is the neon-http client,
 * which has `.batch()`; inside `runInPoolTransaction()` it is the
 * neon-serverless pool-transaction client, which does not, so
 * agent-consensus auto-apply (which runs the reference gate inside a pool
 * transaction — see `applyApprovedEdit`/`applyApprovedEditEffects` in
 * `api/_lib/pending-edits-helpers.ts`) failed on every call with
 * `TypeError: db.batch is not a function`, silently dropping the approved
 * edit instead of publishing it.
 *
 * The unit suite (`tests/api/reference-gate.test.ts`) mocks `getDb()` and so
 * cannot see this: `db.batch` exists on the mock regardless of which client
 * it is standing in for. Reproducing it needs a real query builder that lacks
 * `.batch()` on the transaction path — exactly what PGlite's drizzle instance
 * is (`db.batch` is `undefined` there too, in or out of a transaction), so
 * this harness is sufficient without a real Postgres server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { citations } from '../../db/schema.js';
import { runInPoolTransaction } from '../../api/_lib/db.js';
import {
  assertReferencesJudged,
  ReferenceGateError,
} from '../../api/_lib/pending-edits-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

describe('assertReferencesJudged inside runInPoolTransaction (#1356)', () => {
  it('passes a judged reference without throwing on db.batch', async () => {
    const citationId = await seedAdmissibleCitation(db);

    await expect(
      runInPoolTransaction(() => assertReferencesJudged([citationId])),
    ).resolves.toBeUndefined();
  });

  it('rejects an unjudged resolvable reference with the gate error, not a TypeError', async () => {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/unreviewed-pool-tx' })
      .returning({ id: citations.id });
    const citationId = citation!.id;

    const error = await runInPoolTransaction(() =>
      assertReferencesJudged([citationId]),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ReferenceGateError);
    expect(
      (error as InstanceType<typeof ReferenceGateError>).unjudgedCitationIds,
    ).toEqual([citationId]);
  });
});
