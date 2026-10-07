/**
 * The Kinetix space's policy pointer follows the policy's own version, and an
 * existing space created under an older version is advanced to it — `ensureSpace`
 * alone does nothing on conflict, so the pointer would otherwise keep naming a
 * retired policy while decisions are taken under the new one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ensureKinetixSpace,
  KINETIX_POLICY_VERSION,
  advanceSpacePolicyPointer,
  policyPointerIsOlder,
} from '../../api/_lib/knowledge-governance/backfill.js';
import { ensureSpace, findSpace } from '../../api/_lib/knowledge-governance/store/spaces.js';
import { KINETIX_SPACE } from '../../api/_lib/knowledge-governance/actor-context.js';
import {
  KINETIX_POLICY_ID,
  KINETIX_POLICY_VERSION as RULES_VERSION,
} from '../../src/lib/assurance/policy.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';

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

describe('the Kinetix space policy pointer', () => {
  it('names the policy version the rules are actually at', () => {
    expect(KINETIX_POLICY_VERSION).toBe(`${KINETIX_POLICY_ID}@${RULES_VERSION}`);
  });

  it('advances an existing space created under an older version', async () => {
    await ensureSpace(db as never, {
      slug: KINETIX_SPACE,
      name: 'Kinetix',
      activePolicyVersion: 'kinetix-consensus@v1',
    });

    const space = await ensureKinetixSpace(db as never);

    expect(space.activePolicyVersion).toBe(KINETIX_POLICY_VERSION);
    expect((await findSpace(db as never, KINETIX_SPACE))!.activePolicyVersion).toBe(
      KINETIX_POLICY_VERSION,
    );
  });

  it('never moves a newer pointer back', async () => {
    // An older build running beside a newer one during a deploy.
    const newer = `${KINETIX_POLICY_ID}@v${Number(RULES_VERSION.slice(1)) + 1}`;
    await ensureSpace(db as never, { slug: KINETIX_SPACE, name: 'Kinetix', activePolicyVersion: newer });

    await ensureKinetixSpace(db as never);

    expect((await findSpace(db as never, KINETIX_SPACE))!.activePolicyVersion).toBe(newer);
  });

  it('advances only an older version of the same policy', () => {
    expect(policyPointerIsOlder(null)).toBe(true);
    expect(policyPointerIsOlder(`${KINETIX_POLICY_ID}@v1`)).toBe(true);
    expect(policyPointerIsOlder(KINETIX_POLICY_VERSION)).toBe(false);
    expect(policyPointerIsOlder(`${KINETIX_POLICY_ID}@v99`)).toBe(false);
    expect(policyPointerIsOlder('some-other-policy@v1')).toBe(false);
    expect(policyPointerIsOlder('unparseable')).toBe(false);
  });

  // The comparison must be the write's own predicate. Two builds can both read
  // an old pointer; whichever writes second must not undo a newer one. Called
  // directly here — past the read-side pre-check — so only the UPDATE's own
  // guard stands between it and a downgrade.
  it('guards the write itself, not only the read before it', async () => {
    const newer = `${KINETIX_POLICY_ID}@v${Number(RULES_VERSION.slice(1)) + 1}`;
    const space = await ensureSpace(db as never, {
      slug: KINETIX_SPACE,
      name: 'Kinetix',
      activePolicyVersion: newer,
    });
    expect(await advanceSpacePolicyPointer(db as never, space.id)).toBe(false);
    expect((await findSpace(db as never, KINETIX_SPACE))!.activePolicyVersion).toBe(newer);

    for (const unreadable of ['unparseable', `${KINETIX_POLICY_ID}@vX`, 'other-policy@v1']) {
      await ensureSpace(db as never, { slug: KINETIX_SPACE, name: 'Kinetix' });
      await db.execute(
        sql`UPDATE kg_spaces SET active_policy_version = ${unreadable} WHERE id = ${space.id}`,
      );
      expect(await advanceSpacePolicyPointer(db as never, space.id)).toBe(false);
      expect((await findSpace(db as never, KINETIX_SPACE))!.activePolicyVersion).toBe(unreadable);
    }

    await db.execute(
      sql`UPDATE kg_spaces SET active_policy_version = ${`${KINETIX_POLICY_ID}@v1`} WHERE id = ${space.id}`,
    );
    expect(await advanceSpacePolicyPointer(db as never, space.id)).toBe(true);
    expect((await findSpace(db as never, KINETIX_SPACE))!.activePolicyVersion).toBe(
      KINETIX_POLICY_VERSION,
    );
  });
});
