/**
 * Phase 8: the first authoritative cutover.
 *
 * Everything before this phase watched. Here, for `wiki_fact` and only when it
 * has been deliberately advanced, the generic engine decides — and Kinetix
 * still performs the mutation, so what moves is the authority, not the
 * machinery.
 *
 * Four properties carry the phase:
 *
 *  1. **Inert by default.** A fresh database publishes exactly as it did
 *     before. Nothing about this phase happens until somebody advances a row.
 *  2. **Authority is never inherited.** Advancing the coarse `pending_edit`
 *     key must not carry thirteen edit types with it — `clinical_case`
 *     included, which Kinetix refuses to auto-publish at all.
 *  3. **The commit is the line.** Before it, a generic failure falls back to
 *     the legacy gate. After it, the same mutation is never replayed.
 *  4. **Rollback works.** Both levers, at runtime, without a deploy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  kgPublicationEvents,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import { applyOnAgentConsensus } from '../../../api/agent-verifications.js';
import {
  CUTOVER_ELIGIBLE_EDIT_TYPES,
  applyAuthorityKey,
  resolveApplyAuthority,
} from '../../../api/_lib/knowledge-governance/cutover.js';
import { publishOnAgentConsensus } from '../../../api/_lib/knowledge-governance/publication.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { mirrorProposalVersion } from '../../../api/_lib/knowledge-governance/mirror.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  findByLegacy,
  latestDecisionForVersion,
  latestVersion,
  listPublicationEvents,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  delete process.env[FORCE_LEGACY_ENV];
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

interface World {
  editId: number;
  pageId: number;
  authorId: number;
  verifierUserId: number;
  verifierAgentId: number;
}

/**
 * A wiki_fact edit from an agent, with one flagship approval — the smallest
 * state that clears the consensus gate in a two-agent pool.
 */
async function seedApprovableFact(
  opts: { editType?: string } = {},
): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier-agent',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });
  const [verifierAgent] = await db
    .insert(agents)
    .values({
      userId: verifierUserId,
      name: 'verifier-agent',
      slug: 'verifier-agent',
      status: 'active',
      modelTier: 'flagship',
    })
    .returning({ id: agents.id });
  // A second independent verifier: with three active agents the pool-adapted
  // quorum is the full design target of 2, which is the state a real cutover
  // runs in — a degraded single-approval pool would prove less.
  const secondVerifierUserId = await seedUser(db, {
    email: 'verifier2@example.com',
    username: 'verifier-agent-2',
    role: 'contributor',
  });
  const [secondVerifierAgent] = await db
    .insert(agents)
    .values({
      userId: secondVerifierUserId,
      name: 'verifier-agent-2',
      slug: 'verifier-agent-2',
      status: 'active',
      modelTier: 'mid',
    })
    .returning({ id: agents.id });

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
      // A drug monograph with the v2 section structure, so the fact splices
      // into a real `pk` section. `applyApprovedWikiFact` branches on
      // pageType, and a topic page would send this down the flat-doc path
      // where `pk` is not a section at all.
      pageType: 'drug_monograph',
      content: { version: 2, sections: { pk: { body: { type: 'doc', content: [] } } } },
      status: 'published',
      createdBy: authorId,
      updatedBy: authorId,
    })
    .returning({ id: wikiPages.id });

  const [edit] = await db
    .insert(pendingEdits)
    .values({
      editType: opts.editType ?? 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 30 timer.',
      // A real fact node: `applyApprovedWikiFact` splices this into the page,
      // so a placeholder payload would fail inside the apply transaction and
      // the test would be exercising the failure path everywhere.
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'fact-halflife-1', referenceIds: [] },
        content: [
          { type: 'text', text: 'Halveringstiden er 30 timer.' },
        ],
      },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  await db.insert(agentVerifications).values([
    {
      agentId: verifierAgent!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      verifierTier: 'flagship',
    },
    {
      agentId: secondVerifierAgent!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      verifierTier: 'mid',
    },
  ]);

  return {
    editId: edit!.id,
    pageId: page!.id,
    authorId,
    verifierUserId,
    verifierAgentId: verifierAgent!.id,
  };
}

/** Advance wiki_fact to generic_authoritative and mirror the edit. */
async function cutOver(world: World): Promise<number> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  await setMigrationMode({
    targetType: applyAuthorityKey('wiki_fact'),
    mode: 'generic_authoritative',
    updatedBy: 1,
  });
  invalidateMigrationStateCache();
  const mirrored = await mirrorProposalVersion({
    targetType: 'pending_edit',
    targetId: world.editId,
    legacyPendingEditId: world.editId,
  });
  expect(mirrored.mirrored).toBe(true);
  const link = await findByLegacy(db, 'pending_edit', world.editId);
  const version = await latestVersion(db, link!.genericId);
  return version!.id;
}

describe('inert until deliberately advanced', () => {
  it('falls back for every edit type on a fresh database', async () => {
    const world = await seedApprovableFact();
    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('fell_back');
    expect(await countPublicationEvents()).toBe(0);
  });

  it('still auto-applies through the legacy gate', async () => {
    // The seam must be invisible when it is off: the same consensus that
    // published before this phase still publishes, by the same path.
    const world = await seedApprovableFact();
    const applied = await applyOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(applied).toBe(true);
    expect(await editStatus(world.editId)).toBe('approved');
    // Legacy published it, so no authoritative decision was recorded.
    expect(await countPublicationEvents()).toBe(0);
  });

  it('costs no state read for an edit type this build cannot cut over', async () => {
    // The eligibility list is checked first precisely so the common case —
    // twelve of the thirteen edit types — never touches the table.
    const authority = await resolveApplyAuthority('parameter');
    expect(authority).toEqual({
      authoritative: false,
      key: 'pending_edit:parameter',
      withheld: 'not_eligible',
    });
  });
});

describe('authority is never inherited', () => {
  it('does not grant authority from the coarse pending_edit key', async () => {
    // The trap this guards: advancing `pending_edit` to generic_authoritative
    // would otherwise carry all thirteen edit types, clinical_case included.
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'shadow',
      updatedBy: null,
    });
    await setMigrationMode({
      targetType: 'pending_edit',
      mode: 'generic_read',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    const authority = await resolveApplyAuthority('wiki_fact');
    expect(authority.authoritative).toBe(false);
    expect(authority.withheld).toBe('mode');
  });

  it.each(['clinical_case', 'parameter', 'param_entry', 'wiki_new'])(
    'refuses authority for %s even when its own row says otherwise',
    async (editType) => {
      // A hand-edited or mistaken row must not be able to advance a type whose
      // phase has not been reached and whose parity evidence does not exist.
      await setMigrationMode({
        targetType: applyAuthorityKey(editType),
        mode: 'generic_authoritative',
        updatedBy: 1,
      });
      invalidateMigrationStateCache();
      const authority = await resolveApplyAuthority(editType);
      expect(authority.authoritative).toBe(false);
      expect(authority.withheld).toBe('not_eligible');
    },
  );

  it('lists only wiki_fact as eligible in this build', () => {
    expect([...CUTOVER_ELIGIBLE_EDIT_TYPES]).toEqual(['wiki_fact']);
  });
});

describe('publishing authoritatively', () => {
  it('applies the edit and records an authoritative decision plus event', async () => {
    const world = await seedApprovableFact();
    const versionId = await cutOver(world);

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('applied');

    // Kinetix performed the mutation, by the same path as before.
    expect(await editStatus(world.editId)).toBe('approved');

    const decision = await latestDecisionForVersion(db, versionId, 'authoritative');
    expect(decision?.decision).toBe('apply');
    const events = await listPublicationEvents(db, versionId);
    expect(events.map((e) => e.action)).toEqual(['applied']);
    expect(events[0]!.appliedRevisionRef).toBe(`pending_edit:${world.editId}`);
  });

  it('keeps the legacy pending_edits row updated for the moderator UI', async () => {
    // The compatibility requirement: the moderator UI, the admin tooling and an
    // older instance mid-rolling-deploy all read this row, and a force-legacy
    // rollback has to land on something they recognise.
    const world = await seedApprovableFact();
    await cutOver(world);
    await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    const [row] = await db
      .select({ status: pendingEdits.status, reviewedBy: pendingEdits.reviewedBy })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, world.editId));
    expect(row!.status).toBe('approved');
    expect(row!.reviewedBy).toBe(world.verifierUserId);
  });

  it('holds — and records the hold — when the policy is not satisfied', async () => {
    const world = await seedApprovableFact();
    // Remove the only approval, so the quorum is unmet.
    await db
      .delete(agentVerifications)
      .where(eq(agentVerifications.targetId, world.editId));
    const versionId = await cutOver(world);

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('held');
    expect(result.unmet.length).toBeGreaterThan(0);
    // Issue #1375: an unmet quorum is the one case that legitimately still
    // reads as `quorum_unmet` — the regression this pins is that a *different*
    // unmet requirement (see apply-gate-parity.test.ts) no longer collapses
    // to this same generic value.
    expect(result.holdReason).toBe('quorum_unmet');
    expect(await editStatus(world.editId)).toBe('pending');

    const decision = await latestDecisionForVersion(db, versionId, 'authoritative');
    expect(decision?.decision).toBe('hold');
  });

  it('does not re-decide a hold through the legacy gate', async () => {
    // §1.7 permits the engine to tighten Kinetix and never to relax it. If a
    // generic hold fell through to legacy, the legacy gate could publish what
    // the generic engine just refused.
    const world = await seedApprovableFact();
    await db
      .delete(agentVerifications)
      .where(eq(agentVerifications.targetId, world.editId));
    await cutOver(world);
    expect(
      await applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.verifierUserId,
      }),
    ).toBe(false);
    expect(await editStatus(world.editId)).toBe('pending');
  });
});

describe('the commit is the line', () => {
  it('never applies the same version twice', async () => {
    const world = await seedApprovableFact();
    const versionId = await cutOver(world);

    const first = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(first.outcome).toBe('applied');

    const second = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(second.outcome).toBe('already_applied');
    expect(await listPublicationEvents(db, versionId)).toHaveLength(1);
  });

  it('reports already_applied as "not applied by this request"', async () => {
    // `autoApplied` answers "did this verdict publish it", so a second caller
    // must get false — not an exception, and not a claim it published.
    const world = await seedApprovableFact();
    await cutOver(world);
    await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(
      await applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.verifierUserId,
      }),
    ).toBe(false);
  });

  it('falls back when the proposal was never mirrored', async () => {
    // Advanced but unmirrored is a misconfiguration, not a licence to decide
    // from nothing. Falling back leaves the legacy gate in charge and lets the
    // reconciliation scanner surface the missing proposal.
    const world = await seedApprovableFact();
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('fell_back');
    expect(result.reason).toContain('no mirrored proposal');

    // …and the legacy gate then publishes it, unchanged.
    expect(
      await applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.verifierUserId,
      }),
    ).toBe(true);
    expect(await editStatus(world.editId)).toBe('approved');
  });

  it('leaves the edit pending when the apply transaction fails', async () => {
    // A fault inside the unit of work is reported as itself, never replayed
    // through legacy: this layer cannot prove no effect escaped, and replaying
    // is exactly the double-apply the plan forbids.
    const world = await seedApprovableFact();
    const versionId = await cutOver(world);
    // Corrupt the payload *after* mirroring, so the policy still says apply and
    // the fault lands inside `applyApprovedEdit`'s transaction. Injecting the
    // failure by dropping a table would work too, and would poison every later
    // test in the file — the harness resets rows between tests, not schema.
    await db
      .update(pendingEdits)
      .set({ proposedValue: { nope: true } })
      .where(eq(pendingEdits.id, world.editId));

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('failed');
    expect(await editStatus(world.editId)).toBe('pending');
    expect(await listPublicationEvents(db, versionId)).toHaveLength(0);
  });
});

describe('rollback', () => {
  it('retreating the migration state restores the legacy gate at runtime', async () => {
    const world = await seedApprovableFact();
    await cutOver(world);
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'legacy_only',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('fell_back');
    expect(result.authority?.withheld).toBe('mode');
  });

  it('the kill switch overrides an advanced row', async () => {
    const world = await seedApprovableFact();
    await cutOver(world);
    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();

    const result = await publishOnAgentConsensus({
      pendingEditId: world.editId,
      approverUserId: world.verifierUserId,
    });
    expect(result.outcome).toBe('fell_back');
  });

  it('a rolled-back target still publishes through legacy', async () => {
    // The rollback exercise the exit gate asks for: after retreating, the
    // ordinary consensus path works exactly as it did before the cutover.
    const world = await seedApprovableFact();
    await cutOver(world);
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'legacy_only',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();

    expect(
      await applyOnAgentConsensus({
        pendingEditId: world.editId,
        approverUserId: world.verifierUserId,
      }),
    ).toBe(true);
    expect(await editStatus(world.editId)).toBe('approved');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function editStatus(editId: number): Promise<string> {
  const [row] = await db
    .select({ status: pendingEdits.status })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId));
  return row!.status;
}

async function countPublicationEvents(): Promise<number> {
  const rows = await db.select({ id: kgPublicationEvents.id }).from(kgPublicationEvents);
  return rows.length;
}
