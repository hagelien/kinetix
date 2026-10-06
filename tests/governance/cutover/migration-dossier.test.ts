/**
 * Phase 9: the migration dossier.
 *
 * Phase 9 is "repeat Phase 8 one target at a time", and each cutover needs
 * evidence before it. This is the machine-checkable half of that evidence, and
 * the tests that matter are the ones where it says **no** — a gate that only
 * ever agrees is a rubber stamp.
 *
 * Four refusals carry it, and one of them is the subtle one: a target type
 * nothing has exercised produces zero divergences, which reads exactly like a
 * clean sweep unless the observation count is reported beside it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, ne } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  parameterEntries,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import {
  assessReadiness,
  buildDossier,
  describeDossier,
  surveyEditTypes,
} from '../../../api/_lib/knowledge-governance/dossier.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  collectConsensusFacts,
  evaluateShadowPolicy,
} from '../../../api/_lib/knowledge-governance/policy-shadow.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import {
  seedAdmissibleCitation,
  seedDrug,
  seedUser,
} from '../../integration/setup/seed.js';

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
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

interface World {
  editId: number;
  authorId: number;
  verifierUserId: number;
}

/** A wiki_fact edit that clears the gate, optionally left unapproved. */
async function seedWorld(
  opts: { approvals?: number; editType?: string; humanAuthor?: boolean } = {},
): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  if (!opts.humanAuthor) {
    await db.insert(agents).values({
      userId: authorId,
      name: 'author-agent',
      slug: 'author-agent',
      status: 'active',
    });
  }

  const verifierIds: number[] = [];
  for (const n of [1, 2]) {
    const userId = await seedUser(db, {
      email: `verifier${n}@example.com`,
      username: `verifier-${n}`,
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `verifier-${n}`,
        slug: `verifier-${n}`,
        status: 'active',
        modelTier: n === 1 ? 'flagship' : 'mid',
      })
      .returning({ id: agents.id });
    verifierIds.push(agent!.id);
  }

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: 'diazepam',
      title: 'Diazepam',
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
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'fact-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  const approvals = opts.approvals ?? 2;
  if (approvals > 0) {
    await db.insert(agentVerifications).values(
      verifierIds.slice(0, approvals).map((agentId, i) => ({
        agentId,
        targetType: 'pending_edit' as const,
        targetId: edit!.id,
        verdict: 'approve' as const,
        verifierTier: i === 0 ? 'flagship' : 'mid',
      })),
    );
  }

  return { editId: edit!.id, authorId, verifierUserId: verifierIds[0]! };
}

/**
 * Mirror the proposal version *and* every verdict against it.
 *
 * Mirroring only the version leaves the scanner reporting `missing_assessment`
 * for each verdict — correctly, which is why the dossier refuses on it. A
 * fixture that mirrored half the state would make the positive control below
 * unreachable for the wrong reason.
 */
async function mirror(editId: number): Promise<void> {
  const outcome = await mirrorProposalVersion({
    targetType: 'pending_edit',
    targetId: editId,
    legacyPendingEditId: editId,
  });
  expect(outcome.mirrored).toBe(true);

  const verdicts = await db
    .select({
      id: agentVerifications.id,
      verdict: agentVerifications.verdict,
      isImplicit: agentVerifications.isImplicit,
      agentUserId: agents.userId,
    })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(eq(agentVerifications.targetId, editId));
  for (const verdict of verdicts) {
    const mirrored = await mirrorAssessment({
      targetType: 'pending_edit',
      targetId: editId,
      legacyVerificationId: verdict.id,
      actorRef: `user:${verdict.agentUserId}`,
      verdict: verdict.verdict as 'approve' | 'dispute' | 'abstain',
      isImplicit: verdict.isImplicit,
    });
    expect(mirrored.mirrored).toBe(true);
  }
}

async function enableMirroring(): Promise<void> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();
}

describe('buildDossier', () => {
  it('reports coverage, policy observations and reconciliation together', async () => {
    await enableMirroring();
    const world = await seedWorld();
    await mirror(world.editId);

    const dossier = await buildDossier('wiki_fact', { db });
    expect(dossier.editType).toBe('wiki_fact');
    expect(dossier.authorityKey).toBe('pending_edit:wiki_fact');
    expect(dossier.eligible).toBe(true);
    expect(dossier.coverage).toMatchObject({ rows: 1, mirrored: 1, ratio: 1 });
    expect(dossier.policy.observed).toBe(1);
    expect(dossier.policy.severity1).toHaveLength(0);
  });

  it('agrees with the generic engine on a person’s proposal that clears consensus', async () => {
    // Both engines now publish a person's proposal at quorum; a dossier whose
    // legacy reconstruction still held every human author would report a
    // severity-1 divergence and block cutover on a disagreement that is not
    // there.
    await enableMirroring();
    const world = await seedWorld({ humanAuthor: true });
    await mirror(world.editId);

    const dossier = await buildDossier('wiki_fact', { db });
    expect(dossier.policy.observed).toBe(1);
    expect(dossier.policy.severity1).toHaveLength(0);
  });

  it('reads the target’s own authority key, not the coarse one', async () => {
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'compare',
      updatedBy: null,
    });
    invalidateMigrationStateCache();
    const dossier = await buildDossier('wiki_fact', { db });
    expect(dossier.currentMode).toBe('compare');
  });

  it('compares only open rows', async () => {
    // A decided edit's legacy outcome is history. Re-deriving it from today's
    // tally would compare the engine against a gate that ran under other facts.
    await enableMirroring();
    const world = await seedWorld();
    await mirror(world.editId);
    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, world.editId));

    const dossier = await buildDossier('wiki_fact', { db });
    expect(dossier.coverage.rows).toBe(1);
    expect(dossier.policy.observed).toBe(0);
  });
});

// The payload precondition has to be visible to the COMPARISON, not just
// enforced by the legacy gate. The dossier re-derives the legacy outcome from
// the gathered facts to decide whether the generic engine may take over; a
// precondition the facts do not carry is one the comparison silently forgives,
// and it would report agreement on exactly the edits where the engine is looser
// than Kinetix — a severity-1 divergence recorded as `none`.
describe('buildDossier — the source-quote precondition', () => {
  async function seedEntryEdit(quote: string | null): Promise<number> {
    const world = await seedWorld({ approvals: 0 });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: 1,
        parameter: 'halfLife',
        proposedValue: {
          op: 'create',
          input: {
            parameter: 'halfLife',
            median: 9,
            unit: 'h',
            ...(quote ? { quote } : {}),
          },
        },
        submittedBy: world.authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });
    // Full quorum with a flagship approval: everything the tally can supply is
    // present, so the quote is the only variable left.
    const verifiers = await db
      .select({ id: agents.id })
      .from(agents)
      .where(ne(agents.userId, world.authorId));
    await db.insert(agentVerifications).values(
      verifiers.slice(0, 2).map((a, i) => ({
        agentId: a.id,
        targetType: 'pending_edit' as const,
        targetId: edit!.id,
        verdict: 'approve' as const,
        verifierTier: i === 0 ? 'flagship' : 'mid',
      })),
    );
    return edit!.id;
  }

  it('is a gathered fact, and the generic engine holds on it', async () => {
    await enableMirroring();
    const editId = await seedEntryEdit(null);
    await mirror(editId);

    const facts = await collectConsensusFacts(editId);
    expect(facts?.lacksSourceQuote).toBe(true);
    // The generic engine must hold for the same reason Kinetix does, not merely
    // be ordered behind a guard. If this reads `apply`, the engine is looser
    // than the gate it is meant to replace.
    expect(evaluateShadowPolicy(facts!).outcome).toBe('hold');
    expect(evaluateShadowPolicy(facts!).reasons.join(',')).toContain('human');

    // …and the two sides agree, which is what the dossier is deciding. An
    // unmodelled precondition would show here: legacy would read `apply`
    // against a holding engine and land in `conservative`.
    const dossier = await buildDossier('param_entry', { db });
    expect(dossier.policy.observed).toBe(1);
    expect(dossier.policy.severity1).toHaveLength(0);
    expect(dossier.policy.conservative).toHaveLength(0);
  });

  // The fact has to be the LIVE gate's fact. An entry update may omit the quote
  // because the stored one survives, and the gate consults the write before
  // holding — so a fact read off the payload alone would say "unquoted" for a
  // proposal the gate publishes. Because the dossier feeds one fact to both the
  // generic policy AND its reconstruction of the legacy outcome, the two would
  // then agree on a value neither engine produces: false parity, which is the
  // one thing the dossier must never report.
  it('resolves an update’s inherited quote the way the gate does', async () => {
    await enableMirroring();
    const world = await seedWorld({ approvals: 0 });
    const drugId = await seedDrug(db, { slug: 'kq', names: { nb: 'KQ' } });
    const citationId = await seedAdmissibleCitation(db, {
      identifier: '24500275',
    });
    const [entry] = await db
      .insert(parameterEntries)
      .values({
        drugId,
        parameter: 'halfLife',
        unit: 'h',
        low: '8',
        high: '10',
        median: '9',
        origin: 'contributor',
        createdBy: world.authorId,
        citationId,
        sourceQuote: 'The mean terminal half-life was 9 h.',
      })
      .returning({ id: parameterEntries.id });

    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: entry!.id,
        parameter: 'halfLife',
        // A comments-only revision: carries no quote, and stales nothing.
        proposedValue: {
          op: 'update',
          patch: {
            unit: 'h',
            low: 8,
            high: 10,
            median: 9,
            citationId,
            comments: 'Typo fixed.',
          },
        },
        submittedBy: world.authorId,
        status: 'pending',
      })
      .returning({ id: pendingEdits.id });

    const facts = await collectConsensusFacts(edit!.id);
    // Not "lacking": the entry keeps its sentence through this write.
    expect(facts?.lacksSourceQuote).toBe(false);
  });

  it('lets the identical edit through once it carries a quote', async () => {
    await enableMirroring();
    const editId = await seedEntryEdit('The mean terminal half-life was 9 h.');
    await mirror(editId);

    const facts = await collectConsensusFacts(editId);
    expect(facts?.lacksSourceQuote).toBe(false);
    // Same world, same verdicts — so the hold above is attributable to the
    // quote and to nothing else in the fixture.
    expect(evaluateShadowPolicy(facts!).outcome).toBe('apply');

    const dossier = await buildDossier('param_entry', { db });
    expect(dossier.policy.observed).toBe(1);
    expect(dossier.policy.severity1).toHaveLength(0);
    expect(dossier.policy.conservative).toHaveLength(0);
  });
});

describe('assessReadiness refuses', () => {
  it('when nothing has been observed', async () => {
    // The subtle one. Zero divergences out of zero observations and zero out
    // of four hundred are the same number and not the same evidence.
    const verdict = await assessReadiness('wiki_fact', { db });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('untested rather than safe');
  });

  it('when mirror coverage is incomplete', async () => {
    await enableMirroring();
    const world = await seedWorld();
    // Deliberately not mirrored: judging the type from the rows that happened
    // to mirror is survivorship bias with a publication decision on the end.
    const verdict = await assessReadiness('wiki_fact', { db });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('mirror coverage is 0/1');
    expect(world.editId).toBeGreaterThan(0);
  });

  it('when the edit type is not eligible in this build', async () => {
    await enableMirroring();
    const world = await seedWorld({ editType: 'parameter' });
    await mirror(world.editId);
    const verdict = await assessReadiness('parameter', { db });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('reviewed code change');
  });

  it('when a reconciliation divergence is outstanding', async () => {
    await enableMirroring();
    const world = await seedWorld();
    await mirror(world.editId);
    // A verdict that was never mirrored: the scanner reports it, and the
    // dossier must not treat the rest of its evidence as trustworthy.
    await db.insert(agentVerifications).values({
      agentId: 1,
      targetType: 'pending_edit',
      targetId: world.editId,
      verdict: 'abstain',
      rationaleMd: 'Ikke sikker på denne verdien i det hele tatt.',
    });

    const verdict = await assessReadiness('wiki_fact', { db });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('reconciliation divergence');
  });

  it('reports every blocker at once, so one pass fixes them all', async () => {
    const verdict = await assessReadiness('clinical_case', { db });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.length).toBeGreaterThan(1);
  });
});

describe('assessReadiness allows', () => {
  it('a fully mirrored, fully agreeing, eligible target', async () => {
    // The positive control. Without it every refusal above could be satisfied
    // by a function that always says no.
    await enableMirroring();
    const world = await seedWorld();
    await mirror(world.editId);

    const verdict = await assessReadiness('wiki_fact', { db });
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ready).toBe(true);
  });

  it('a held row, as long as both sides hold it', async () => {
    // Agreement is what is being measured, not publication. A type where every
    // row is legitimately held is as ready as one where every row publishes.
    await enableMirroring();
    const world = await seedWorld({ approvals: 0 });
    await mirror(world.editId);

    const verdict = await assessReadiness('wiki_fact', { db });
    expect(verdict.dossier.policy.observed).toBe(1);
    expect(verdict.dossier.policy.severity1).toHaveLength(0);
    expect(verdict.ready).toBe(true);
  });
});

describe('reporting', () => {
  it('renders a summary that states the verdict and its reasons', async () => {
    const verdict = await assessReadiness('wiki_fact', { db });
    const text = describeDossier(verdict);
    expect(text).toContain('pending_edit:wiki_fact');
    expect(text).toContain('VERDICT: not ready');
    expect(text).toContain('mirror coverage');
  });

  it('surveys every edit type present, sorted', async () => {
    await enableMirroring();
    await seedWorld();
    const otherAuthorId = await seedUser(db, {
      email: 'other@example.com',
      username: 'other-author',
      role: 'contributor',
    });
    await db.insert(pendingEdits).values({
      editType: 'bio_entity',
      proposedValue: { op: 'create' },
      submittedBy: otherAuthorId,
      status: 'pending',
    });
    const survey = await surveyEditTypes({ db });
    expect(survey.map((v) => v.dossier.editType)).toEqual([
      'bio_entity',
      'wiki_fact',
    ]);
    // Neither is ready — one is ineligible, the other unmirrored.
    expect(survey.every((v) => !v.ready)).toBe(true);
  });
});
