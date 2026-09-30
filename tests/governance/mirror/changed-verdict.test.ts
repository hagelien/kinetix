/**
 * A reviewer that changes its mind, mirrored.
 *
 * ## The bug this exists for
 *
 * `recordVerification` upserts on `(agent_id, target_type, target_id)`: a
 * reviewer that revises its judgment rewrites the same row and keeps the same
 * legacy id. `mirrorAssessment` used to treat the presence of a legacy link as
 * proof the current verdict had been mirrored, so the correction never reached
 * the generic side at all.
 *
 * The consequence was not a silent inconsistency in a table nobody reads.
 * `linkageIsComplete` compares row counts, and one stale generic assessment
 * still matches one legacy verdict — so the linkage looked complete, no
 * fallback fired, and under `generic_read` a monograph badge went on being
 * served from a withdrawn approval. An approve-to-dispute correction was
 * invisible to every reader. §1.7 forbids the migration loosening a gate in
 * exactly that direction.
 *
 * ## What replaced it
 *
 * The mirror compares the whole judgment — verdict, rationale, and the tier
 * snapshot the flagship gate reads — against the actor's current assessment,
 * and records a correction by **superseding** rather than by overwriting. The
 * legacy table loses the earlier judgment; the generic one keeps both, which is
 * the whole reason §5.7 made assessments append-only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentVerifications, agents, drugParameterRevisions } from '../../../db/schema.js';
import { recordVerification } from '../../../api/_lib/agent-verifications.js';
import {
  linkageIsComplete,
  resolveVerificationLevel,
} from '../../../api/_lib/knowledge-governance/assurance-service.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  currentAssessments,
  findByLegacy,
  latestVersion,
  listAssessments,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
});

interface World {
  revisionId: number;
  reviewerUserId: number;
  reviewerAgentId: number;
}

async function seedWorld(modelTier: string | null = 'flagship'): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  const reviewerUserId = await seedUser(db, {
    email: 'reviewer@example.com',
    username: 'reviewer',
    role: 'contributor',
  });
  const [reviewerAgent] = await db
    .insert(agents)
    .values({
      userId: reviewerUserId,
      name: 'reviewer',
      slug: 'reviewer',
      status: 'active',
      modelTier,
    })
    .returning({ id: agents.id });

  const drugId = await seedDrug(db, { slug: 'diazepam' });
  const [revision] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId,
      parameter: 'halfLife',
      oldValue: { value: 20 },
      newValue: { value: 30 },
      createdBy: authorId,
    })
    .returning({ id: drugParameterRevisions.id });

  await advance('shadow');
  await mirrorProposalVersion({
    targetType: 'drug_parameter_revision',
    targetId: revision!.id,
  });

  return {
    revisionId: revision!.id,
    reviewerUserId,
    reviewerAgentId: reviewerAgent!.id,
  };
}

async function advance(mode: 'shadow' | 'generic_read'): Promise<void> {
  await setMigrationMode({
    targetType: 'drug_parameter_revision',
    mode,
    updatedBy: null,
  });
  invalidateMigrationStateCache();
}

/**
 * Record a verdict through the real helper and mirror it.
 *
 * `recordVerification` is what makes this test about the actual bug: it is the
 * upsert, so the second call returns the same legacy id as the first.
 */
async function verdictAndMirror(
  world: World,
  verdict: 'approve' | 'dispute' | 'abstain',
  rationaleMd = '',
): Promise<{ legacyId: number; mirrored: boolean; skipped?: string }> {
  const { id } = await recordVerification({
    agentId: world.reviewerAgentId,
    targetType: 'drug_parameter_revision',
    targetId: world.revisionId,
    verdict,
    rationaleMd,
    evidenceRefs: [],
  });
  const outcome = await mirrorAssessment({
    targetType: 'drug_parameter_revision',
    targetId: world.revisionId,
    legacyVerificationId: id,
    actorRef: `user:${world.reviewerUserId}`,
    verdict,
    rationaleMd,
  });
  return { legacyId: id, ...outcome };
}

async function versionId(world: World): Promise<number> {
  const link = await findByLegacy(db, 'drug_parameter_revision', world.revisionId);
  const version = await latestVersion(db, link!.genericId);
  return version!.id;
}

describe('the legacy row really does keep its id', () => {
  it('upserts a changed verdict in place', async () => {
    // The premise everything below rests on, asserted rather than assumed: if
    // a revision produced a NEW legacy id the old mirror logic would have been
    // correct and this whole suite would be testing nothing.
    const world = await seedWorld();
    const first = await verdictAndMirror(world, 'approve');
    const second = await verdictAndMirror(world, 'dispute', 'Kilden oppgir 20–50 timer.');
    expect(second.legacyId).toBe(first.legacyId);

    const rows = await db
      .select({ id: agentVerifications.id, verdict: agentVerifications.verdict })
      .from(agentVerifications)
      .where(eq(agentVerifications.targetId, world.revisionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('dispute');
  });
});

describe('a changed verdict reaches the generic side', () => {
  it('supersedes rather than overwriting, keeping both judgments', async () => {
    const world = await seedWorld();
    await verdictAndMirror(world, 'approve');
    const revised = await verdictAndMirror(
      world,
      'dispute',
      'Kilden oppgir 20–50 timer.',
    );
    expect(revised.mirrored).toBe(true);

    const subject = { subjectType: 'proposal_version' as const, subjectId: await versionId(world) };
    const all = await listAssessments(db, subject);
    expect(all).toHaveLength(2);

    const current = await currentAssessments(db, subject);
    expect(current).toHaveLength(1);
    expect(current[0]!.verdict).toBe('dispute');
    expect(current[0]!.rationaleMd).toBe('Kilden oppgir 20–50 timer.');
    // The withdrawn approval is still on the record, pointed at by its
    // replacement. The legacy table lost it; this is where it survives.
    const superseded = all.find((a) => a.id !== current[0]!.id)!;
    expect(superseded.verdict).toBe('approve');
    expect(current[0]!.supersedesAssessmentId).toBe(superseded.id);
  });

  it('is still a no-op when nothing actually changed', async () => {
    // The behaviour the old early return got right, and which the fix must not
    // trade away: re-mirroring an unchanged verdict writes nothing.
    const world = await seedWorld();
    await verdictAndMirror(world, 'approve');
    const again = await verdictAndMirror(world, 'approve');
    expect(again.mirrored).toBe(false);
    expect(again.skipped).toBe('already_mirrored');
    expect(
      await listAssessments(db, {
        subjectType: 'proposal_version',
        subjectId: await versionId(world),
      }),
    ).toHaveLength(1);
  });

  it('notices a rationale rewritten behind an unchanged verdict', async () => {
    // Same verdict, different published reasoning. What the reviewer told the
    // next reader changed, so the record must change with it.
    const world = await seedWorld();
    await verdictAndMirror(world, 'dispute', 'Kilden dekker ikke påstanden.');
    const revised = await verdictAndMirror(
      world,
      'dispute',
      'Kilden oppgir 20–50 timer, ikke 30.',
    );
    expect(revised.mirrored).toBe(true);
    const current = await currentAssessments(db, {
      subjectType: 'proposal_version',
      subjectId: await versionId(world),
    });
    expect(current[0]!.rationaleMd).toBe('Kilden oppgir 20–50 timer, ikke 30.');
  });

  it('notices a tier re-snapshotted behind an unchanged verdict', async () => {
    // The case the flagship high-risk gate reads. An admin downgrades the
    // agent, the agent re-verdicts, and `recordVerification` re-stamps
    // `verifier_tier` under its row lock — an identical `approve` now carries
    // different weight, and a mirror comparing only the verdict would keep
    // serving the flagship snapshot.
    const world = await seedWorld('flagship');
    await verdictAndMirror(world, 'approve');
    await db
      .update(agents)
      .set({ modelTier: 'mid' })
      .where(eq(agents.id, world.reviewerAgentId));

    const revised = await verdictAndMirror(world, 'approve');
    expect(revised.mirrored).toBe(true);
    const current = await currentAssessments(db, {
      subjectType: 'proposal_version',
      subjectId: await versionId(world),
    });
    expect(
      (current[0]!.capabilitySnapshot as { assuranceCapabilities: string[] })
        .assuranceCapabilities,
    ).toEqual(['model_tier:mid']);
  });
});

describe('the reader sees the correction', () => {
  it('serves the dispute, generically, rather than the withdrawn approval', async () => {
    // The whole point. Before the fix this served `disputed: false` from the
    // stale approval, generically and with no fallback, because the linkage
    // count still balanced.
    const world = await seedWorld();
    await verdictAndMirror(world, 'approve');
    await verdictAndMirror(world, 'dispute', 'Kilden oppgir 20–50 timer.');
    await advance('generic_read');

    const resolved = await resolveVerificationLevel({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      db,
    });
    expect(resolved.source).toBe('generic');
    expect(resolved.info.disputed).toBe(true);
    // …and it agrees with what legacy would have said, which is the parity
    // claim the read cutover rests on.
    expect(resolved.info).toEqual(resolved.legacy);
  });

  it('keeps the linkage complete, so a correction does not force a fallback', async () => {
    // The other half of the fix. `linkageIsComplete` counts *current*
    // assessments: counting every row ever written would see two generic rows
    // behind one legacy verdict, call the linkage broken, and fall back to
    // legacy forever after any reviewer ever changed its mind. Safe, and
    // useless — the read cutover would quietly stop being a cutover.
    const world = await seedWorld();
    await verdictAndMirror(world, 'approve');
    await verdictAndMirror(world, 'dispute', 'Kilden oppgir 20–50 timer.');
    expect(
      await linkageIsComplete(db, {
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
      }),
    ).toBe(true);
  });
});
