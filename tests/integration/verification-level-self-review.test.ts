/**
 * Evidence level for a trusted self-reviewing agent's own work.
 *
 * The 0–3 scale counts distinct agents, so a deployment running one agent the
 * operator runs personally is pinned at level 1 ("verified by its author
 * only") forever: level 2 needs a second identity that does not exist. When
 * that agent re-verifies its own claim against the sources, the verdict lands
 * on the SAME `(agent, target)` row as its submit-time stake — one row, so the
 * count never moves, and a genuinely re-checked value is displayed as weak
 * evidence.
 *
 * `authorSelfVerifiedRevisionIds` is what closes that gap, and it is a
 * three-way join (verification → agent → revision author) with clauses that
 * each have to hold. Real SQL, because a mocked summary cannot show the join
 * matching the wrong rows — and matching too many here would silently inflate
 * the evidence level of every agent-authored value in the database.
 *
 * Each case asserts the join AND the level it produces, so the test says what
 * a reader of the drug page would actually see. (`parameterVerificationLevels`
 * itself is not called: it resolves the live revision through
 * `getNeonClient()`, which the PGlite harness does not inject.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  drugParameterRevisions,
  users,
} from '../../db/schema.js';
import { authorSelfVerifiedRevisionIds } from '../../api/_lib/verification-levels.js';
import { computeVerificationLevel } from '../../src/lib/verificationLevel.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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

/**
 * One trusted agent, one drug, one parameter revision it authored, and the
 * implicit-approve row the apply path stamps on that revision.
 */
async function seedAgentAuthoredRevision(selfReviewEnabled: boolean) {
  const agentUserId = await seedUser(db, {
    email: 'solo@example.com',
    username: 'solo-agent',
    role: 'contributor',
  });
  const [agentRow] = await db
    .insert(agents)
    .values({
      userId: agentUserId,
      name: 'solo-agent',
      slug: 'solo-agent',
      status: 'active',
      selfReviewEnabled,
    })
    .returning({ id: agents.id });

  const drugId = await seedDrug(db, { slug: 'diazepam' });
  const [revision] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId,
      parameter: 'halfLife',
      newValue: { value: 40 },
      createdBy: agentUserId,
    })
    .returning({ id: drugParameterRevisions.id });

  await db.insert(agentVerifications).values({
    agentId: agentRow!.id,
    targetType: 'drug_parameter_revision',
    targetId: revision!.id,
    verdict: 'approve',
    rationaleMd: '',
    evidenceRefs: [],
    isImplicit: true,
  });

  return {
    agentId: agentRow!.id,
    agentUserId,
    drugId,
    revisionId: revision!.id,
  };
}

/** Promote the agent's implicit stake into an explicit, reasoned verdict. */
async function postExplicitSelfVerdict(revisionId: number) {
  await db
    .update(agentVerifications)
    .set({ isImplicit: false, rationaleMd: 'Etterprøvd mot primærkilden.' })
    .where(eq(agentVerifications.targetId, revisionId));
}

describe('verification level — trusted agent self-review', () => {
  /** The level a live value lands on, given the join's verdict about it. */
  async function levelFor(revisionId: number): Promise<number> {
    const selfVerified = await authorSelfVerifiedRevisionIds({
      targetType: 'drug_parameter_revision',
      revisionIds: [revisionId],
    });
    // One agent row on the revision — the submitter's — exactly as a
    // single-agent deployment produces.
    return computeVerificationLevel({
      agentApprovers: 1,
      hasHumanApprover: false,
      authorSelfVerified: selfVerified.has(revisionId),
    });
  }

  it('leaves an un-reviewed submission at level 1', async () => {
    const seeded = await seedAgentAuthoredRevision(true);

    // The flag is on, but the agent has only submitted — the row is still the
    // implicit stake, and no reasoned verdict exists to count.
    expect(await levelFor(seeded.revisionId)).toBe(1);
  });

  it('lifts the agent’s own re-verification to level 2', async () => {
    const seeded = await seedAgentAuthoredRevision(true);
    await postExplicitSelfVerdict(seeded.revisionId);

    expect(await levelFor(seeded.revisionId)).toBe(2);
  });

  it('keeps an untrusted agent’s self-verdict at level 1', async () => {
    // Same rows, same explicit verdict — only the admin's grant differs. This
    // is the future-agent case: something joins the pool that the operator
    // does not run and has not vouched for, and its own say-so must not lift
    // its own work.
    const seeded = await seedAgentAuthoredRevision(false);
    await postExplicitSelfVerdict(seeded.revisionId);

    expect(await levelFor(seeded.revisionId)).toBe(1);
  });

  it('gives a trusted agent no bonus on another author’s revision', async () => {
    // The bonus restores the second act a self-reviewer's single row hides.
    // Verifying a PEER's work hides nothing — that peer's own stake is already
    // a separate row — so counting it again would inflate.
    const seeded = await seedAgentAuthoredRevision(true);
    const peerUserId = await seedUser(db, {
      email: 'peer@example.com',
      username: 'peer-author',
      role: 'contributor',
    });
    await db
      .update(drugParameterRevisions)
      .set({ createdBy: peerUserId })
      .where(eq(drugParameterRevisions.id, seeded.revisionId));
    await postExplicitSelfVerdict(seeded.revisionId);

    expect(await levelFor(seeded.revisionId)).toBe(1);
  });

  it('does not lift a suspended agent’s self-verdict', async () => {
    const seeded = await seedAgentAuthoredRevision(true);
    await postExplicitSelfVerdict(seeded.revisionId);
    await db
      .update(agents)
      .set({ status: 'suspended' })
      .where(eq(agents.id, seeded.agentId));

    expect(await levelFor(seeded.revisionId)).toBe(1);
  });

  // The documented kill switch demotes the backing user and leaves
  // agents.status alone, so a level bonus keyed on status alone would survive
  // pulling it — the agent stops acting, but the evidence weight its own
  // verdict earned stays on the page.
  it('does not lift a self-verdict once the kill switch is pulled', async () => {
    const seeded = await seedAgentAuthoredRevision(true);
    await postExplicitSelfVerdict(seeded.revisionId);
    await db
      .update(users)
      .set({ role: 'authenticated' })
      .where(eq(users.id, seeded.agentUserId));

    expect(await levelFor(seeded.revisionId)).toBe(1);
  });

  it('does not lift a dispute verdict, only an approval', async () => {
    const seeded = await seedAgentAuthoredRevision(true);
    await db
      .update(agentVerifications)
      .set({ isImplicit: false, verdict: 'dispute', rationaleMd: 'Feil kilde.' })
      .where(eq(agentVerifications.targetId, seeded.revisionId));

    expect(await levelFor(seeded.revisionId)).toBe(1);
  });
});
