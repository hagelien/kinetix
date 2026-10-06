/**
 * The Kinetix space's policy pointer follows the policy's own version, and an
 * existing space created under an older version is advanced to it — `ensureSpace`
 * alone does nothing on conflict, so the pointer would otherwise keep naming a
 * retired policy while decisions are taken under the new one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureKinetixSpace,
  KINETIX_POLICY_VERSION,
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
});
