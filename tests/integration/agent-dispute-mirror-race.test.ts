/**
 * The agent-dispute mirror bridge after a target-version race (issue #1324).
 *
 * `POST /api/agent-verifications` commits an agent's `dispute` verdict first,
 * then mirrors it into the unified `disputes` table
 * (`mirrorAgentDisputeVerdict`, in api/_lib/agent-verifications.ts). A target
 * that moves in the small window between those two writes throws
 * `StaleDisputeTargetError` from the mirror attempt. Two different things can
 * cause that move, and only one of them should leave the mirror unwritten:
 *
 *  - a payload revision, which also wipes the verdict itself
 *    (`clearVerificationsForTarget`) — nothing is left to mirror, and the
 *    "revise in place" reconciliation handles the rest;
 *  - a status-only change, such as a moderator's bare `pending -> returned`
 *    with no payload edit — the verdict survives and still blocks consensus
 *    (`unresolvedDisputeVerdictCount`), so skipping the mirror here would
 *    leave it with no `disputes` row for a moderator to ever see or resolve.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, agentVerifications, disputes, pendingEdits } from '../../db/schema.js';
import { mirrorAgentDisputeVerdict } from '../../api/_lib/agent-verifications.js';
import { verificationTargetVersion } from '../../api/_lib/verification-targets.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

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

async function seedAgent(slug: string) {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [row] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active' })
    .returning({ id: agents.id });
  return { userId, agentId: row!.id };
}

async function seedPendingEdit(authorUserId: number) {
  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: 'param_entry',
      targetId: 1,
      parameter: 'volumeOfDistribution',
      proposedValue: {
        op: 'create',
        input: { value: 0.35, quote: 'A representative distribution-phase quote.' },
      },
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  return edit!.id;
}

async function recordDisputeVerdict(agentId: number, editId: number) {
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId,
      targetType: 'pending_edit',
      targetId: editId,
      verdict: 'dispute',
      rationaleMd: 'Disputing the claimed distribution-phase quote.',
      evidenceRefs: [],
      isImplicit: false,
    })
    .returning({ id: agentVerifications.id });
  return row!.id;
}

describe('mirrorAgentDisputeVerdict (#1324)', () => {
  it('retries against the current version when a bare status flip raced the mirror', async () => {
    const disputer = await seedAgent('disputer');
    const author = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const editId = await seedPendingEdit(author);

    // The version the agent read before posting its verdict.
    const versionAtRead = (await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    }))!;
    // Its verdict already committed, exactly as the route does before calling
    // the mirror bridge.
    const verificationId = await recordDisputeVerdict(disputer.agentId, editId);

    // A moderator's bare return lands in the window before the mirror write:
    // status changes, payload and submittedAt do not, so the verdict survives.
    await db
      .update(pendingEdits)
      .set({ status: 'returned' })
      .where(eq(pendingEdits.id, editId));
    const versionAfterReturn = (await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    }))!;
    expect(versionAfterReturn).not.toBe(versionAtRead);

    const mirrored = await mirrorAgentDisputeVerdict({
      targetType: 'pending_edit',
      targetId: editId,
      createdBy: disputer.userId,
      reasonMd: 'Disputing the claimed distribution-phase quote.',
      evidenceRefs: [],
      targetVersion: versionAtRead,
      verificationId,
    });

    expect(mirrored?.inserted).toBe(true);
    const [row] = await db
      .select()
      .from(disputes)
      .where(eq(disputes.targetId, editId));
    expect(row).toMatchObject({
      status: 'open',
      source: 'agent',
      targetVersion: versionAfterReturn,
    });
    // The verdict that was at risk of being left stranded is still on record.
    const [verdict] = await db
      .select({ id: agentVerifications.id })
      .from(agentVerifications)
      .where(eq(agentVerifications.id, verificationId));
    expect(verdict).toBeDefined();
  });

  it('skips the mirror without retrying once the verdict itself was cleared by a revision', async () => {
    const disputer = await seedAgent('disputer');
    const author = await seedUser(db, {
      email: 'author2@example.com',
      username: 'author2',
      role: 'contributor',
    });
    const editId = await seedPendingEdit(author);
    const versionAtRead = (await verificationTargetVersion({
      targetType: 'pending_edit',
      targetId: editId,
    }))!;
    const verificationId = await recordDisputeVerdict(disputer.agentId, editId);

    // A payload revision bumps `submittedAt` (so the version token moves)
    // and wipes every verdict on the target (`clearVerificationsForTarget`)
    // — simulated directly here, matching both effects of a real revision.
    await db
      .update(pendingEdits)
      .set({
        proposedValue: { op: 'create', input: { value: 0.5 } } as never,
        submittedAt: new Date(),
      })
      .where(eq(pendingEdits.id, editId));
    await db.delete(agentVerifications).where(eq(agentVerifications.id, verificationId));

    const mirrored = await mirrorAgentDisputeVerdict({
      targetType: 'pending_edit',
      targetId: editId,
      createdBy: disputer.userId,
      reasonMd: 'Disputing the claimed distribution-phase quote.',
      evidenceRefs: [],
      targetVersion: versionAtRead,
      verificationId,
    });

    expect(mirrored).toBeNull();
    const rows = await db.select().from(disputes).where(eq(disputes.targetId, editId));
    expect(rows).toHaveLength(0);
  });
});
