/**
 * Kinetix's governance tables, put through `assurance-core`'s store contract.
 *
 * The port is a TypeScript interface, and an interface states shapes and
 * nothing else. It cannot say that `currentAssessments` returns one row per
 * assessor, that a revision must not inherit the previous version's approvals,
 * or that a ruling closes a dispute — and those are exactly the properties the
 * review machinery in the package relies on. An adapter that compiles can be
 * wrong in every one of them, and the failure would surface as a review that
 * quietly counts a reviewer twice.
 *
 * So the contract is executed. It runs against real SQL, not a fake, because
 * every clause it checks is a claim about what these tables actually return.
 *
 * ## Why the harness looks like this
 *
 * `ConformanceSeed` returns the ids the host assigned and accepts none: kg_*
 * rows are serial-keyed and nothing may ask a caller to name a key it is about
 * to create. The same holds for the target — the suite says which object it
 * means, the adapter says which one it used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  conformanceFailures,
  conformanceSkipped,
  runStoreConformance,
  tallyAssurance,
  toAssessment,
  type ConformanceHarness,
} from 'assurance-core';
import {
  appendVersion,
  createProposal,
  ensureSpace,
  ensureTarget,
  recordAssessment,
  setProposalState,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  UNREADABLE_RISK_TAG,
  actorKindOf,
  authorKindOf,
  riskProfileIsMalformed,
  toRiskProfile,
} from '../../../api/_lib/knowledge-governance/store/assurance-port.js';
import {
  canonicalSnapshot,
  readHostField,
} from '../../../api/_lib/knowledge-governance/store/capability-snapshot.js';
import {
  capabilitiesOf,
  isImplicitAssessment,
  kinetixAssuranceStore,
  kinetixLegacySnapshots,
  tierCapabilities,
} from '../../../api/_lib/knowledge-governance/kinetix-compat.js';
import { observedAssuranceStore } from '../../../api/_lib/knowledge-governance/assurance-service.js';
import { KINETIX_APPLY_POLICY } from '../../../src/lib/assurance/policy.js';
import { HUMAN_AUTHOR, makeContext } from '../support/policy-context.js';
import {
  NON_CANONICAL_SNAPSHOT_METRIC,
  UNREADABLE_HISTORY_METRIC,
  readMetric,
  resetMetricsForTests,
} from '../../../api/_lib/knowledge-governance/metrics.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

/**
 * A fresh harness per check.
 *
 * The suite seeds conflicting fixtures under the same logical names on
 * purpose, so each check gets a truncated database. That is slower than
 * sharing one and is the only way the isolation claim means anything.
 */
async function makeHarness(): Promise<ConformanceHarness> {
  await resetIntegrationDb(db);
  const store = kinetixAssuranceStore(db);
  return {
    store,
    // Kinetix governs one space today, so the two clauses that need a second
    // one are reported as skipped rather than passed. `kg_targets` genuinely
    // holds several target types, so that filter is exercised.
    space: 'kinetix',
    targetType: 'pending_edit',
    otherTargetType: 'wiki_revision',
    // `recordRuling` leaves a superseded dispute open on purpose — the
    // replacement governs it — so this host can demonstrate the clause.
    supportsSupersededRulings: true,
    seed: {
      async proposal(input) {
        const space = await ensureSpace(db, {
          slug: input.target.space,
          name: input.target.space,
        });
        const target = await ensureTarget(db, {
          spaceId: space.id,
          targetType: input.target.type,
          targetKey: input.target.id,
        });
        const proposal = await createProposal(db, {
          spaceId: space.id,
          targetId: target.id,
          authorActorRef: input.author.actorRef,
          authorKind: input.author.kind,
          state: 'pending',
        });
        if (input.open === false) {
          await setProposalState(db, proposal.id, 'applied');
        }
        // `kg_proposals.created_at` defaults to `now()`, so every seeded row
        // would otherwise carry insertion time and the oldest-first check
        // would be comparing two identical timestamps — passing or failing on
        // insertion order rather than on the ordering the port requires.
        // Backdating here is what a host seeding historical rows does anyway.
        await db.execute(
          sql`UPDATE kg_proposals SET created_at = ${new Date(input.createdAt)} WHERE id = ${proposal.id}`,
        );
        return {
          proposalId: String(proposal.id),
          target: {
            space: space.slug,
            type: target.targetType,
            id: target.targetKey,
          },
        };
      },
      async version(input) {
        const version = await appendVersion(db, {
          proposalId: Number(input.proposalId),
          payload: { note: 'conformance' },
          payloadFingerprint: `fp-${input.proposalId}-${Date.now()}`,
          authorActorRef: 'user:1',
          actorKind: 'human',
          riskProfile: input.risk ?? { level: 'low', tags: [] },
          submittedAt:
            input.submittedAt === undefined
              ? new Date()
              : input.submittedAt === null
                ? null
                : new Date(input.submittedAt),
        });
        return {
          ref: {
            proposalId: input.proposalId,
            versionId: String(version.id),
          },
        };
      },
      async evidence(ref, state) {
        store.declareEvidence(ref, state);
      },
    },
  };
}

describe('the kg_* tables satisfy the AssuranceStore contract', () => {
  it('passes every applicable check, with nothing filtered out', async () => {
    const results = await runStoreConformance(makeHarness);
    expect(conformanceFailures(results)).toEqual([]);
    // Non-vacuity: an empty suite reports no failures either.
    expect(results.length).toBeGreaterThan(15);
  }, 120_000);

  it('leaves exactly the clause its single space cannot express', async () => {
    // Pinned, so a future skip has to be added deliberately rather than
    // arriving as a quietly shorter run.
    const skipped = conformanceSkipped(await runStoreConformance(makeHarness));
    expect(skipped.map((line) => line.split(' — ')[0])).toEqual([
      'a proposal in another space is not listed',
    ]);
  }, 120_000);
});

describe('reading a stored risk profile', () => {
  // `kg_proposal_versions.risk_profile` is untyped JSON written by whichever
  // adapter classified the version. A malformed one is not a crash but
  // something worse: `atLeastRisk` on a profile with no level answers false,
  // so every high-risk rule stops matching and the proposal publishes under
  // the low-risk bar.
  it('reads a well-formed profile through unchanged', () => {
    expect(toRiskProfile({ level: 'high', tags: ['entry_backed'] })).toEqual({
      level: 'high',
      tags: ['entry_backed'],
    });
    expect(riskProfileIsMalformed({ level: 'high', tags: [] })).toBe(false);
  });

  it('fails closed on a malformed profile, rather than down to low risk', () => {
    // The direction is the whole point. An earlier version returned
    // `LOW_RISK` here, which produced exactly the silent bypass the
    // validation exists to prevent — the proposal published under the relaxed
    // bar with a reassuring comment above the code. High-risk holds it until
    // someone looks.
    for (const bad of [{ level: 'critical' }, { tags: ['x'] }, 'high', 42, {}]) {
      const profile = toRiskProfile(bad);
      expect(profile.level, JSON.stringify(bad)).toBe('high');
      expect(profile.tags, JSON.stringify(bad)).toContain(UNREADABLE_RISK_TAG);
      expect(riskProfileIsMalformed(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it('carries the reason into the profile, not only into a separate call', () => {
    // A caller evaluating policy sees the tag without having to know that
    // `riskProfileIsMalformed` exists. A rule can match on it, and a
    // diagnostic can count them — a sudden crop means an adapter is writing a
    // shape this reader rejects, which is a data problem to fix rather than a
    // proposal to hold forever.
    expect(toRiskProfile({ level: 'nonsense' }).tags).toEqual([
      UNREADABLE_RISK_TAG,
    ]);
  });

  it('does not treat an absent profile as malformed', () => {
    // A version written before anything classified it has `null`. Holding
    // every unclassified row would be failing closed on the wrong thing.
    expect(riskProfileIsMalformed(null)).toBe(false);
    expect(riskProfileIsMalformed(undefined)).toBe(false);
    expect(toRiskProfile(null)).toEqual({ level: 'low', tags: [] });
  });

  it('keeps the readable tags when the list is malformed', () => {
    // Replacing the profile wholesale discarded `clinical_case` along with the
    // corruption, and no rule matches `risk_profile_unreadable` — so a
    // corrupted clinical case got the high-risk bar but not the
    // human-clinical-expert one. Keeping readable tags is safe in exactly one
    // direction, and it is this one: every rule in this policy is `require:`,
    // so a surviving tag can only tighten the gate, and even a spurious tag
    // introduced by the corruption tightens it.
    const profile = toRiskProfile({
      level: 'low',
      tags: ['clinical_case', null],
    });
    expect(profile.level).toBe('high');
    expect(profile.tags).toContain('clinical_case');
    expect(profile.tags).toContain(UNREADABLE_RISK_TAG);
  });

  it('salvages a tag from a scalar where a list belongs', () => {
    // The first salvage looked only inside an array, so `tags: 'clinical_case'`
    // dropped a perfectly legible tag and with it the clinical-expert
    // requirement. Asking "is it the shape I expected?" and giving up is how a
    // salvage routine loses the thing it exists to save.
    const profile = toRiskProfile({ level: 'low', tags: 'clinical_case' });
    expect(profile.level).toBe('high');
    expect(profile.tags).toContain('clinical_case');
    expect(profile.tags).toContain(UNREADABLE_RISK_TAG);
  });

  it('salvages nothing from a shape holding no tag', () => {
    // The bound: an object or a number contains nothing a tag rule could
    // match, so the marker stands alone rather than inventing a tag.
    for (const bad of [{ level: 'low', tags: {} }, { level: 'low', tags: 7 }]) {
      expect(toRiskProfile(bad).tags).toEqual([UNREADABLE_RISK_TAG]);
    }
  });

  it('keeps readable tags when it is the level that is unreadable', () => {
    const profile = toRiskProfile({ level: 'critical', tags: ['clinical_case'] });
    expect(profile.level).toBe('high');
    expect(profile.tags).toContain('clinical_case');
    expect(profile.tags).toContain(UNREADABLE_RISK_TAG);
  });

  it('does not duplicate the marker when the row already carries it', () => {
    const profile = toRiskProfile({
      level: 'nonsense',
      tags: [UNREADABLE_RISK_TAG],
    });
    expect(profile.tags.filter((t) => t === UNREADABLE_RISK_TAG)).toHaveLength(1);
  });

  it('fails closed on a malformed tag list rather than filtering it', () => {
    // Tags are as load-bearing as the level. The Kinetix policy requires a
    // human clinical expert on anything tagged `clinical_case`, so quietly
    // dropping a corrupted tag unmatches that rule — the same bypass the level
    // check exists to stop, one field over. An earlier version filtered
    // non-strings out and carried on.
    for (const bad of [
      { level: 'medium', tags: ['ok', 3, null] },
      { level: 'high', tags: null },
      { level: 'high', tags: 'clinical_case' },
      { level: 'high', tags: {} },
    ]) {
      const profile = toRiskProfile(bad);
      expect(profile.level, JSON.stringify(bad)).toBe('high');
      // The marker is always present. It is no longer the *only* tag: any tag
      // that could still be read is kept alongside it, because a tag can only
      // add a requirement and dropping one loses a gate. The `['ok', 3, null]`
      // case therefore keeps `ok`.
      expect(profile.tags, JSON.stringify(bad)).toContain(UNREADABLE_RISK_TAG);
      expect(riskProfileIsMalformed(bad), JSON.stringify(bad)).toBe(true);
    }
    expect(toRiskProfile({ level: 'medium', tags: ['ok', 3] }).tags).toEqual([
      'ok',
      UNREADABLE_RISK_TAG,
    ]);
    // Nothing readable to keep: the marker stands alone.
    expect(toRiskProfile({ level: 'high', tags: null }).tags).toEqual([
      UNREADABLE_RISK_TAG,
    ]);
  });

  it('accepts a profile with no tags at all', () => {
    // Absent is legitimate — plenty of changes carry no tag — and treating it
    // as corruption would hold them all.
    expect(toRiskProfile({ level: 'medium' })).toEqual({
      level: 'medium',
      tags: [],
    });
    expect(riskProfileIsMalformed({ level: 'medium' })).toBe(false);
  });
});

describe('reading a stored actor kind', () => {
  it('passes the four real kinds through', () => {
    for (const kind of ['human', 'agent', 'service', 'system'] as const) {
      expect(actorKindOf(kind)).toBe(kind);
    }
  });

  it('does not grant human status to an unreadable assessor kind', () => {
    // `human` is the one value that confers something on an assessor:
    // `humanApproval` is satisfied by kind alone, and the clinical-expert rule
    // reads it with a capability. A corrupt row defaulting to human could
    // satisfy a requirement whose whole purpose is putting a person in the
    // loop.
    for (const bad of ['', 'Human', 'HUMAN', 'bot', 'unknown', 'admin']) {
      expect(actorKindOf(bad), bad).not.toBe('human');
      expect(actorKindOf(bad), bad).toBe('service');
    }
  });

  it('reads an unreadable *author* kind as system, the other way', () => {
    // The same column, the reverse conclusion, and the reason is that failing
    // closed means "toward the more demanding outcome" — which differs by
    // role. Since kinetix-consensus v2 the demanding author rule is
    // `unattributed` (`when: { authorKind: 'system' }`, requires a human
    // approval); an unreadable author kind read as `human` or `service` would
    // match no author rule and publish on agent approvals alone.
    for (const bad of ['', 'Human', 'bot', 'unknown']) {
      expect(authorKindOf(bad), bad).toBe('system');
    }
    const context = makeContext({
      author: { ...HUMAN_AUTHOR, kind: authorKindOf('unknown') },
      assurance: { explicitApprovals: 4, independentApprovers: 4, agentApprovals: 4 },
    });
    expect(KINETIX_APPLY_POLICY.evaluate(context).allowed).toBe(false);
    for (const good of ['human', 'agent', 'service', 'system'] as const) {
      expect(authorKindOf(good)).toBe(good);
    }
  });

  it('applies the author direction to a stored proposal and version', async () => {
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    // Corrupt both author-kind columns, as a legacy import could.
    await db.execute(
      sql`UPDATE kg_proposals SET author_kind = 'editor' WHERE id = ${proposal.id}`,
    );
    await db.execute(
      sql`UPDATE kg_proposal_versions SET actor_kind = 'editor' WHERE id = ${version.id}`,
    );

    expect((await store.getProposal(String(proposal.id)))!.author.kind).toBe(
      'system',
    );
    expect(
      (await store.getVersion({
        proposalId: String(proposal.id),
        versionId: String(version.id),
      }))!.author.kind,
    ).toBe('system');
  }, 60_000);
});

describe('listing open proposals under a limit', () => {
  // The filters run in SQL, before `LIMIT`. When they ran in JavaScript over a
  // bounded over-fetch, a page came back short — or empty — whenever more
  // older proposals failed the predicate than the window held, while eligible
  // work sat just past it.
  it('fills the page even when many older proposals are excluded', async () => {
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });

    // Twelve by the caller, then two by someone else. With a limit of 2 and
    // the old four-times over-fetch, the window held only the caller's own
    // rows and the page came back empty.
    const seed = async (author: string, key: string, at: string) => {
      const target = await ensureTarget(db, {
        spaceId: space.id,
        targetType: 'pending_edit',
        targetKey: key,
      });
      const proposal = await createProposal(db, {
        spaceId: space.id,
        targetId: target.id,
        authorActorRef: author,
        authorKind: 'human',
        state: 'pending',
      });
      await db.execute(
        sql`UPDATE kg_proposals SET created_at = ${new Date(at)} WHERE id = ${proposal.id}`,
      );
    };
    for (let i = 0; i < 12; i += 1) {
      await seed('user:1', `mine:${i}`, `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    }
    await seed('user:2', 'theirs:1', '2020-02-01T00:00:00.000Z');
    await seed('user:2', 'theirs:2', '2020-02-02T00:00:00.000Z');

    const page = await store.listOpenProposals('kinetix', {
      excludeAuthorRef: 'user:1',
      limit: 2,
    });
    expect(page).toHaveLength(2);
    expect(page.map((p) => p.author.actorRef)).toEqual(['user:2', 'user:2']);
    expect(page.map((p) => p.target.id)).toEqual(['theirs:1', 'theirs:2']);
  }, 60_000);

  it('narrows by target type across the join', async () => {
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    for (const [type, key] of [
      ['pending_edit', 'pe:1'],
      ['wiki_revision', 'wr:1'],
    ] as const) {
      const target = await ensureTarget(db, {
        spaceId: space.id,
        targetType: type,
        targetKey: key,
      });
      await createProposal(db, {
        spaceId: space.id,
        targetId: target.id,
        authorActorRef: 'user:1',
        authorKind: 'human',
        state: 'pending',
      });
    }
    const wiki = await store.listOpenProposals('kinetix', {
      targetType: 'wiki_revision',
    });
    expect(wiki.map((p) => p.target.type)).toEqual(['wiki_revision']);
  }, 60_000);
});

describe('a version reference is validated as a pair', () => {
  /** Two proposals, each with one version. */
  async function twoProposals(): Promise<{
    store: KinetixAssuranceStore;
    a: { proposalId: string; versionId: string };
    b: { proposalId: string; versionId: string };
  }> {
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const made: Array<{ proposalId: string; versionId: string }> = [];
    for (const key of ['a', 'b']) {
      const target = await ensureTarget(db, {
        spaceId: space.id,
        targetType: 'pending_edit',
        targetKey: key,
      });
      const proposal = await createProposal(db, {
        spaceId: space.id,
        targetId: target.id,
        authorActorRef: 'user:1',
        authorKind: 'human',
        state: 'pending',
      });
      const version = await appendVersion(db, {
        proposalId: proposal.id,
        payload: {},
        payloadFingerprint: `fp-${key}`,
        authorActorRef: 'user:1',
        actorKind: 'human',
      });
      made.push({
        proposalId: String(proposal.id),
        versionId: String(version.id),
      });
    }
    return { store, a: made[0]!, b: made[1]! };
  }

  it('does not return one proposal’s assessments under another’s id', async () => {
    // Both halves exist, so nothing is malformed — which is what made this
    // quiet. Only `getVersion` checked the pairing; every other read trusted
    // the version id alone, so B's approvals came back labelled as A's.
    const { store, a, b } = await twoProposals();
    await store.recordAssessment({
      version: b,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(await store.currentAssessments(b)).toHaveLength(1);

    const crossed = { proposalId: a.proposalId, versionId: b.versionId };
    expect(await store.currentAssessments(crossed)).toEqual([]);
    expect(await store.assessmentsByActor('user:2', [crossed])).toEqual([]);
    expect(await store.disputes(crossed)).toEqual([]);
    expect(await store.evidenceState(crossed)).toEqual([]);
    expect(await store.latestDecision(crossed)).toBeNull();
    expect(await store.getVersion(crossed)).toBeNull();
  }, 60_000);

  it('refuses to write against a crossed reference', async () => {
    // A read of an unknown reference is legitimately empty; a write to one is
    // a caller mistake, and appending it under whichever proposal owns that
    // version id would put a verdict on the wrong change.
    const { store, a, b } = await twoProposals();
    const crossed = { proposalId: a.proposalId, versionId: b.versionId };
    await expect(
      store.recordAssessment({
        version: crossed,
        assessorRef: 'user:2',
        assessorKind: 'human',
        verdict: 'approve',
        recordedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/no version/);
    expect(await store.currentAssessments(b)).toEqual([]);
  }, 60_000);
});

describe('caller-supplied event times', () => {
  it('are persisted, not replaced by the column default', async () => {
    // Governance history gets imported and replayed. Letting `now()` win would
    // renumber the audit chronology and change time-ordered reads, while the
    // returned record reported a timestamp the caller never asked for.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    const T = '2019-06-01T12:00:00.000Z';

    await store.recordAssessment({
      version: ref,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      recordedAt: T,
    });
    expect((await store.currentAssessments(ref))[0]!.recordedAt).toBe(T);

    const dispute = await store.openDispute({
      version: ref,
      openedByRef: 'user:3',
      openedByKind: 'human',
      openedAt: T,
    });
    expect(dispute.openedAt).toBe(T);
    expect((await store.disputes(ref))[0]!.openedAt).toBe(T);

    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'upheld',
      ruledByRef: 'user:4',
      ruledAt: T,
    });
    expect((await store.disputeRulings(dispute.disputeId))[0]!.ruledAt).toBe(T);

    await store.recordDecision({
      version: ref,
      policyId: 'p',
      policyVersion: '1',
      allowed: false,
      inputFingerprint: 'f',
      mode: 'shadow',
      evaluatedAt: T,
    });
    expect((await store.latestDecision(ref))!.evaluatedAt).toBe(T);
  }, 60_000);
});

describe('reading a stored evaluation mode', () => {
  it('reports only an exact authoritative as authoritative', async () => {
    // Three things were wrong with `=== 'shadow' ? 'shadow' : 'authoritative'`
    // and only one was corruption: `advisory` is a real stored mode that
    // governs nothing, and it was reading as the one that publishes.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };

    for (const [stored, expected] of [
      ['authoritative', 'authoritative'],
      ['shadow', 'shadow'],
      ['advisory', 'shadow'],
      ['nonsense', 'shadow'],
      ['', 'shadow'],
    ] as const) {
      await db.execute(
        sql`DELETE FROM kg_policy_decisions WHERE proposal_version_id = ${version.id}`,
      );
      await db.execute(
        sql`INSERT INTO kg_policy_decisions
              (space_id, proposal_version_id, policy_id, policy_version,
               decision, input_fingerprint, evaluation_mode)
            VALUES (${space.id}, ${version.id}, 'p', '1', 'apply', 'f', ${stored})`,
      );
      expect((await store.latestDecision(ref))!.mode, stored).toBe(expected);
    }
  }, 60_000);
});

describe('replaying a dispute ruling out of order', () => {
  it('keeps the projection agreeing with the ordered history', async () => {
    // A bug the timestamp fix created: with every ruling stamped `now()`, the
    // row just inserted was always the latest. Once a caller can supply a
    // historical time, replaying an older `upheld` after a newer `superseded`
    // used to set `closedAt` from the older event — so the dispute read as
    // closed and stopped blocking publication, on a ruling history says was
    // overtaken.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    const dispute = await store.openDispute({
      version: ref,
      openedByRef: 'user:2',
      openedByKind: 'human',
      openedAt: '2020-01-01T00:00:00.000Z',
    });

    // Newer ruling first, then an older one — the import order that breaks a
    // projection written from the insert.
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'superseded',
      ruledByRef: 'user:3',
      ruledAt: '2020-06-01T00:00:00.000Z',
    });
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'upheld',
      ruledByRef: 'user:4',
      ruledAt: '2020-02-01T00:00:00.000Z',
    });

    // The supersession is still the latest, so the dispute is still open.
    expect((await store.disputes(ref))[0]!.open).toBe(true);
    const rulings = await store.disputeRulings(dispute.disputeId);
    expect(rulings.map((r) => r.ruling)).toEqual(['upheld', 'superseded']);
  }, 60_000);
});

describe('an unreadable dispute ruling', () => {
  it('does not close the dispute, and is not mislabelled', async () => {
    // `kg_dispute_rulings.ruling` is varchar(20) with no enum or check
    // constraint, so `KgDisputeRulingKind` is a claim about the column rather
    // than a guarantee from it. `!== 'superseded'` treated every unreadable
    // value as closing — and closing a dispute removes a publication block.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    const dispute = await store.openDispute({
      version: ref,
      openedByRef: 'user:2',
      openedByKind: 'human',
      openedAt: '2020-01-01T00:00:00.000Z',
    });

    // Written directly, because the typed path cannot produce one.
    await db.execute(
      sql`INSERT INTO kg_dispute_rulings (dispute_id, ruling, actor_ref, created_at)
          VALUES (${Number(dispute.disputeId)}, 'gibberish', 'user:3', '2020-06-01T00:00:00.000Z')`,
    );
    // Replaying an older, recognised ruling is what re-derives the projection.
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'upheld',
      ruledByRef: 'user:4',
      ruledAt: '2020-02-01T00:00:00.000Z',
    });

    // The unreadable ruling is chronologically latest, so nothing closes.
    expect((await store.disputes(ref))[0]!.open).toBe(true);

    // And it is omitted rather than reported as some other ruling: every
    // substitute would be a factual claim the row does not support.
    const rulings = await store.disputeRulings(dispute.disputeId);
    expect(rulings.map((r) => r.ruling)).toEqual(['upheld']);
  }, 60_000);
});

describe('dispute openness on read', () => {
  it('is derived from the rulings, not from a stale closedAt', async () => {
    // `recordRuling` repairs the projection, so the previous fix only covered
    // disputes whose rulings all arrived through it. A ruling imported
    // directly — or an existing one corrupted in place — leaves a non-null
    // `closedAt` that nothing re-derives, and reading it would report the
    // dispute closed and lift its publication block.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    const dispute = await store.openDispute({
      version: ref,
      openedByRef: 'user:2',
      openedByKind: 'human',
      openedAt: '2020-01-01T00:00:00.000Z',
    });
    // A legitimate closing ruling, through the typed path.
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'upheld',
      ruledByRef: 'user:3',
      ruledAt: '2020-02-01T00:00:00.000Z',
    });
    expect((await store.disputes(ref))[0]!.open).toBe(false);

    // Now corrupt that ruling in place. `recordRuling` never runs again, so
    // `closedAt` stays set — the exact state the write-path fix cannot reach.
    await db.execute(
      sql`UPDATE kg_dispute_rulings SET ruling = 'garbled' WHERE dispute_id = ${Number(dispute.disputeId)}`,
    );
    expect((await store.disputes(ref))[0]!.open).toBe(true);
  }, 60_000);

  it('reports a dispute with no rulings as open', async () => {
    // Non-vacuity for the derivation: an empty ruling history must not read
    // the same as an unreadable one by accident of both being "not closed".
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    await store.openDispute({
      version: ref,
      openedByRef: 'user:2',
      openedByKind: 'human',
      openedAt: '2020-01-01T00:00:00.000Z',
    });
    expect((await store.disputes(ref))[0]!.open).toBe(true);
  }, 60_000);
});

describe('reading rows the other writers produced', () => {
  /** One proposal with one version, and the ids to address it by. */
  async function seeded(): Promise<{
    store: KinetixAssuranceStore;
    spaceId: number;
    versionId: number;
    ref: { proposalId: string; versionId: string };
  }> {
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    return {
      store,
      spaceId: space.id,
      versionId: version.id,
      ref: { proposalId: String(proposal.id), versionId: String(version.id) },
    };
  }

  it('does not let an unreadable verdict count as an approval', async () => {
    // `kg_assessments.verdict` is varchar(16), and the tally handles `dispute`
    // and `abstain` explicitly while treating everything else as approval — so
    // a garbled value became an *explicit approval* able to satisfy a quorum.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human', 'garbled')`,
    );
    const [stored] = await store.currentAssessments(ref);
    expect(stored!.verdict).toBe('abstain');
    expect(stored!.verdict).not.toBe('approve');
  }, 60_000);

  it('does not let an unreadable verdict erase a dispute it supersedes', async () => {
    // The sharp case. `abstain` is right for an assessor who only ever
    // recorded an unreadable verdict. It is wrong when the unreadable row
    // *supersedes* a dispute: `currentAssessments` drops the superseded row,
    // so the objection does not merely go unstated — it disappears, and
    // `noDisputingAssessments()` passes on a hold a reviewer actually raised.
    const { store, spaceId, versionId, ref } = await seeded();
    // The dispute through the typed path, so its id is known.
    const disputeRow = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:2',
      actorKind: 'human',
      verdict: 'dispute',
    });
    // The unreadable revision only raw SQL can write.
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'garbled', ${disputeRow.id})`,
    );

    const standing = await store.currentAssessments(ref);
    expect(standing).toHaveLength(1);
    expect(standing[0]!.verdict).toBe('dispute');
  }, 60_000);

  it('does not restore an approval an unreadable row superseded', async () => {
    // This is the case that ended the reconstruction. The fallback returned
    // the last readable row up the chain whatever it said, so a garbled
    // successor resurrected the approval it replaced — with its kind and its
    // capabilities — and the core counted it toward quorum and a capability
    // gate as though the replacement never existed. The supersession link says
    // that approval no longer stands, and a reader that overrides it is
    // guessing in the direction that publishes.
    const { store, spaceId, versionId, ref } = await seeded();
    const approval = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:1',
      actorKind: 'human',
      verdict: 'approve',
      independenceGroup: 'author',
      capabilitySnapshot: ['clinical_expert'],
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:1', 'human',
                  'garbled', ${approval.id})`,
    );

    const [standing] = await store.currentAssessments(ref);
    expect(standing!.verdict).toBe('abstain');
    expect(standing!.implicit).toBe(false);
    expect(standing!.assuranceCapabilities).toBeUndefined();
  }, 60_000);

  it('yields no approval at all from a history it cannot read', async () => {
    // The property that replaces the reconstruction, and the one that actually
    // holds the version: a corrupt history contributes zero approvals, so
    // `independentApprovalsFromPool()` cannot be met however small the pool —
    // `effectiveIndependentQuorum` is `min(target, max(1, eligible))` and so
    // never zero. Two perfectly readable approvals from two different actors
    // stop counting because a third row nobody can read is in the same
    // history.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:1', 'agent',
                  'approve', ${JSON.stringify(['model_tier:flagship'])}),
                 (${spaceId}, 'proposal_version', ${versionId}, 'agent:2', 'agent',
                  'approve', ${JSON.stringify(['model_tier:flagship'])})`,
    );
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:3', 'agent', 'garbled')`,
    );

    const rows = await store.currentAssessments(ref);
    const profile = tallyAssurance(rows.map(toAssessment));
    expect(profile.explicitApprovals).toBe(0);
    expect(profile.implicitApprovals).toBe(0);
    expect(profile.independentApprovers).toBe(0);
    expect(profile.approvalCapabilities).toEqual([]);
    // Every assessor still appears — held, not erased. An audit reads this
    // table to find out what happened, and dropping the rows would hide it.
    expect(rows.map((r) => r.assessorRef).sort()).toEqual([
      'agent:1',
      'agent:2',
      'agent:3',
    ]);
  }, 60_000);

  it('keeps a readable dispute standing inside a corrupt history', async () => {
    // The one thing that survives, because it is a real objection from a real
    // actor and dropping it would fail open. Supersession is ignored here on
    // purpose: obeying a link in a history whose links cannot be trusted is
    // how an unreadable row came to delete the dispute it claimed to replace.
    const { store, spaceId, versionId, ref } = await seeded();
    const dispute = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:4',
      actorKind: 'human',
      verdict: 'dispute',
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:4', 'human',
                  'garbled', ${dispute.id})`,
    );

    const rows = await store.currentAssessments(ref);
    const mine = rows.filter((r) => r.assessorRef === 'user:4');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.verdict).toBe('dispute');
    expect(tallyAssurance(rows.map(toAssessment)).disputingAssessors).toBe(1);
  }, 60_000);

  it('counts the version whose history it cannot read', async () => {
    // A hold nobody can see is a proposal that quietly stops moving, so the
    // refusal is surfaced rather than only enacted.
    resetMetricsForTests();
    const { spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:8', 'agent', 'garbled')`,
    );
    // Built through the host's wiring, not the bare constructor: the store
    // reports through a callback and the counter is the host's end of it, so
    // testing the store alone would prove only that a callback exists.
    await observedAssuranceStore(db).currentAssessments(ref);
    expect(readMetric(UNREADABLE_HISTORY_METRIC, ref.proposalId)).toBeGreaterThan(0);
  }, 60_000);

  it('counts a snapshot in no shape it recognises, and grants nothing from it', async () => {
    // The quieter failure of the two. An unreadable *history* holds the
    // version, so it announces itself by nothing moving; an unreadable
    // *snapshot* only means this approval carries no capabilities, and the
    // version publishes on its other approvals. So a corrupt row and an
    // assessor with genuinely no standing produced the same silent empty list
    // and nobody ever looked.
    resetMetricsForTests();
    const { spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:9', 'agent',
                  'approve', ${'"nonsense"'}::jsonb)`,
    );

    const rows = await observedAssuranceStore(db).currentAssessments(ref);
    const mine = rows.find((r) => r.assessorRef === 'agent:9');
    // Still a readable approval — the history is fine, only the snapshot is
    // not — and it confers no qualification, which is the safe direction.
    expect(mine?.verdict).toBe('approve');
    expect(mine?.assuranceCapabilities ?? []).toEqual([]);
    expect(
      readMetric(NON_CANONICAL_SNAPSHOT_METRIC, ref.proposalId),
    ).toBeGreaterThan(0);
  }, 60_000);

  it('does not count a canonical snapshot that simply confers nothing', async () => {
    // The bound: "this assessor had no capabilities" is an ordinary fact and
    // must not raise the counter, or the signal is noise from its first day.
    // Both spellings of it — the canonical empty list, and the absent snapshot
    // that is the column's own default. The second is the more dangerous to get
    // wrong, being the commonest row in the table.
    resetMetricsForTests();
    const { spaceId, versionId, ref } = await seeded();
    const empty = JSON.stringify(canonicalSnapshot({}));
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:10', 'agent',
                  'approve', ${empty}::jsonb)`,
    );
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:11', 'agent',
                  'approve')`,
    );

    await observedAssuranceStore(db).currentAssessments(ref);
    expect(readMetric(NON_CANONICAL_SNAPSHOT_METRIC, ref.proposalId)).toBe(0);
  }, 60_000);

  it('recognises the shapes this host really wrote, and only those', () => {
    // The counter's usefulness is entirely in what it does *not* fire on. Every
    // one of these is a row Kinetix wrote before the canonical shape existed,
    // and each states no qualification rather than being unreadable.
    for (const legacy of [
      // `mirrorAssessment` stored `verifierTier ?? null`, and the source column
      // is nullable: an agent admitted without a tier looks like this.
      { modelTier: null, isImplicit: false },
      // `mirrorHumanApproval` wrote neither capability field.
      { isImplicit: false, source: 'approval_stamp' },
      // An SDK actor with no assurance standing.
      { capabilities: ['edit_wiki'], assuranceCapabilities: [] },
    ]) {
      expect(kinetixLegacySnapshots.readCapabilities(legacy), JSON.stringify(legacy)).toEqual(
        [],
      );
    }

    // And the ones nobody wrote. A misspelled key is not a shape; reading it as
    // an ordinary unqualified approval is what the counter exists to stop.
    for (const corrupt of [
      { modelTire: 'flagship' },
      { modelTier: 42 },
      { assuranceCapabilities: 'clinical_expert' },
      // A mirror row that lost its tier: every agent-side writer paired
      // `isImplicit` with `modelTier`, so this one is damaged rather than
      // being the human stamp's shape.
      { modelTire: 'flagship', isImplicit: false },
      { isImplicit: true },
      'nonsense',
    ]) {
      expect(kinetixLegacySnapshots.readCapabilities(corrupt), JSON.stringify(corrupt)).toBeNull();
    }
  });

  it('counts a capability list with a non-string in it', async () => {
    // The all-or-nothing rule already withheld the whole list; what it did not
    // do was say so. Collapsed to an empty list the snapshot read as canonical
    // and readable, so the one corruption that rule exists to catch was the
    // single case the counter never saw.
    resetMetricsForTests();
    const { spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:12', 'agent',
                  'approve', ${'{"assuranceCapabilities":["clinical_expert",42]}'}::jsonb)`,
    );

    const rows = await observedAssuranceStore(db).currentAssessments(ref);
    expect(
      rows.find((r) => r.assessorRef === 'agent:12')?.assuranceCapabilities ?? [],
    ).toEqual([]);
    expect(
      readMetric(NON_CANONICAL_SNAPSHOT_METRIC, ref.proposalId),
    ).toBeGreaterThan(0);
  }, 60_000);

  it('leaves a well-formed history alone', async () => {
    // The bound on all four above, and the one that matters most: this must
    // not become "any history with a supersession link is suspect". A normal
    // revision — an approval superseded by the same actor's dispute — still
    // resolves to the dispute, and an untouched approval still carries its
    // capabilities and still counts.
    resetMetricsForTests();
    const { store, spaceId, versionId, ref } = await seeded();
    const first = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:11',
      actorKind: 'human',
      verdict: 'approve',
    });
    await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:11',
      actorKind: 'human',
      verdict: 'dispute',
      supersedesAssessmentId: first.id,
    });
    await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'agent:12',
      actorKind: 'agent',
      verdict: 'approve',
      capabilitySnapshot: ['model_tier:flagship'],
    });

    const rows = await store.currentAssessments(ref);
    expect(rows).toHaveLength(2);
    const reviser = rows.find((r) => r.assessorRef === 'user:11');
    expect(reviser!.verdict).toBe('dispute');
    const approver = rows.find((r) => r.assessorRef === 'agent:12');
    expect(approver!.verdict).toBe('approve');
    expect(approver!.assuranceCapabilities).toEqual(['model_tier:flagship']);
    const profile = tallyAssurance(rows.map(toAssessment));
    expect(profile.explicitApprovals).toBe(1);
    expect(profile.approvalCapabilities).toEqual(['model_tier:flagship']);
    // Nothing was flagged: a clean history is not a corrupt one.
    expect(readMetric(UNREADABLE_HISTORY_METRIC, ref.proposalId)).toBe(0);
  }, 60_000);

  it('follows the supersession chain, not the actor’s last readable row', async () => {
    // An actor with two branches: a dispute, an unrelated later approval, then
    // an unreadable row that explicitly supersedes the *dispute*. Picking "the
    // last readable row by this actor" chose the approval and erased the
    // objection; only the pointer says which position was replaced.
    const { store, spaceId, versionId, ref } = await seeded();
    const dispute = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:2',
      actorKind: 'human',
      verdict: 'dispute',
    });
    await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:2',
      actorKind: 'human',
      verdict: 'approve',
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'garbled', ${dispute.id})`,
    );

    // Asserting the array *contains* a dispute is not enough, and that was the
    // bug: `tallyAssurance` collapses several rows from one assessor to the
    // last, so `[recovered dispute, later approval]` published anyway. The
    // property is one position per assessor, and that position failing closed.
    const standing = await store.currentAssessments(ref);
    const mine = standing.filter((a) => a.assessorRef === 'user:2');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.verdict).toBe('dispute');
  }, 60_000);

  it('keeps a dispute whose supersession chain is a cycle', async () => {
    // A cycle cannot be written by anything here — the column is append-only
    // and a row can only name an id that exists — but a self-superseding row
    // is one import away. Marking both ends superseded removed *every*
    // position for that assessor, so the objection did not lose an argument;
    // it left without one, and publication proceeded.
    const { store, spaceId, versionId, ref } = await seeded();
    const dispute = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:5',
      actorKind: 'human',
      verdict: 'dispute',
    });
    await db.execute(
      sql`UPDATE kg_assessments SET supersedes_assessment_id = ${dispute.id}
          WHERE id = ${dispute.id}`,
    );

    const standing = await store.currentAssessments(ref);
    const objector = standing.find((a) => a.assessorRef === 'user:5');
    expect(objector).toBeDefined();
    expect(objector!.verdict).toBe('dispute');
  }, 60_000);

  it('collapses tied approvals to what every branch supports', async () => {
    // Two standing explicit approvals from one assessor rank the same, and
    // keeping whichever came first was arbitrary in the direction of
    // privilege: if that row carried a capability the other branch did not,
    // the collapsed position satisfied a gate the record cannot support.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:6', 'human',
                  'approve', ${JSON.stringify(['clinical_expert', 'model_tier:flagship'])}),
                 (${spaceId}, 'proposal_version', ${versionId}, 'user:6', 'human',
                  'approve', ${JSON.stringify(['model_tier:flagship'])})`,
    );

    const standing = await store.currentAssessments(ref);
    const mine = standing.filter((a) => a.assessorRef === 'user:6');
    expect(mine).toHaveLength(1);
    // Only what both branches carry. `clinical_expert` is in one, so the
    // collapsed position cannot claim it.
    expect(mine[0]!.assuranceCapabilities).toEqual(['model_tier:flagship']);
  }, 60_000);

  it('collapses a disputed assessor kind to one that claims nothing', async () => {
    // "Not human" is not safe: `agent` qualifies too, feeding `agentApprovals`
    // which the Kinetix projection reads into a verification level. So keeping
    // the first non-human kind still let insertion order decide.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:9', 'agent', 'approve'),
                 (${spaceId}, 'proposal_version', ${versionId}, 'agent:9', 'system', 'approve')`,
    );
    const [mine] = (await store.currentAssessments(ref)).filter(
      (a) => a.assessorRef === 'agent:9',
    );
    expect(mine!.assessorKind).toBe('service');
  }, 60_000);

  it('keeps a kind every tied branch agrees on', async () => {
    // The bound: unanimity is preserved, so this does not quietly downgrade
    // every tied assessor to `service`.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:10', 'agent', 'approve'),
                 (${spaceId}, 'proposal_version', ${versionId}, 'agent:10', 'agent', 'approve')`,
    );
    const [mine] = (await store.currentAssessments(ref)).filter(
      (a) => a.assessorRef === 'agent:10',
    );
    expect(mine!.assessorKind).toBe('agent');
  }, 60_000);

  it('drops capabilities entirely when tied branches share none', async () => {
    // The bound: an empty intersection has to mean none, not "whatever the
    // first row happened to carry".
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:7', 'human',
                  'approve', ${JSON.stringify(['clinical_expert'])}),
                 (${spaceId}, 'proposal_version', ${versionId}, 'user:7', 'human',
                  'approve', ${JSON.stringify(['model_tier:flagship'])})`,
    );
    const [mine] = (await store.currentAssessments(ref)).filter(
      (a) => a.assessorRef === 'user:7',
    );
    expect(mine!.assuranceCapabilities).toBeUndefined();
  }, 60_000);

  it('keeps a dispute a cross-actor supersession would have displaced', async () => {
    // The store helper drops any row whose id is named by *any* other row's
    // `supersedesAssessmentId`. So B's unreadable row pointing at A's dispute
    // removed A's row, and the guard against borrowing across actors then left
    // only B's abstention — the objection gone, not overruled.
    const { store, spaceId, versionId, ref } = await seeded();
    const theirs = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:3',
      actorKind: 'human',
      verdict: 'dispute',
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:4', 'human',
                  'garbled', ${theirs.id})`,
    );

    const standing = await store.currentAssessments(ref);
    const objector = standing.find((a) => a.assessorRef === 'user:3');
    expect(objector!.verdict).toBe('dispute');
    // And the row that tried to supersede it still speaks only for its own
    // author, with no position it can support.
    const other = standing.find((a) => a.assessorRef === 'user:4');
    expect(other!.verdict).toBe('abstain');
  }, 60_000);

  it('resolves the same way through the bulk read as through the single one', async () => {
    // Two reads of the same rows must not disagree about whether an objection
    // stands. `assessmentsByActor` kept passing no history — the parameter
    // defaulted to `[]` — so it reported `abstain` where `currentAssessments`
    // reported `dispute`, and every batch consumer lost the objection.
    const { store, spaceId, versionId, ref } = await seeded();
    const dispute = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:2',
      actorKind: 'human',
      verdict: 'dispute',
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'garbled', ${dispute.id})`,
    );

    const single = await store.currentAssessments(ref);
    const bulk = await store.assessmentsByActor('user:2', [ref]);
    expect(single[0]!.verdict).toBe('dispute');
    expect(bulk[0]!.verdict).toBe('dispute');
    expect(bulk[0]!.verdict).toBe(single[0]!.verdict);
  }, 60_000);

  it('does not follow a chain into another actor’s assessment', async () => {
    // Attributing one person's verdict to another would be a worse error than
    // abstaining, so the walk stops when the assessor changes.
    const { store, spaceId, versionId, ref } = await seeded();
    const theirs = await recordAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: versionId,
      actorRef: 'user:3',
      actorKind: 'human',
      verdict: 'approve',
    });
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             supersedes_assessment_id)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:4', 'human',
                  'garbled', ${theirs.id})`,
    );
    const standing = await store.currentAssessments(ref);
    const other = standing.find((a) => a.assessorRef === 'user:4');
    expect(other!.verdict).toBe('abstain');
  }, 60_000);

  it('still abstains when there is no readable verdict to fall back to', async () => {
    // The other half: with nothing earlier to stand on, an unreadable verdict
    // must not be promoted to a dispute either. Fabricating an objection
    // nobody raised would hold publication and say so in the decision record.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human', 'garbled')`,
    );
    const [stored] = await store.currentAssessments(ref);
    expect(stored!.verdict).toBe('abstain');
  }, 60_000);

  it('keeps an unreadable implicit marker implicit', async () => {
    // `=== true` reported a legacy `isImplicit: "true"` as an explicit review,
    // which is how an author's submit-time stake reaches the quorum meant to
    // be independent of them.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:1', 'human',
                  'approve', ${JSON.stringify({ isImplicit: 'true' })})`,
    );
    const [stored] = await store.currentAssessments(ref);
    expect(stored!.implicit).toBe(true);
  }, 60_000);

  it('treats an absent marker as explicit, not implicit', async () => {
    // The bound on the above: most assessments carry no marker at all, and
    // reading those as implicit would discard every genuine review.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'approve', ${JSON.stringify({ modelTier: 'flagship' })})`,
    );
    const [stored] = await store.currentAssessments(ref);
    expect(stored!.implicit).toBe(false);
  }, 60_000);

  it('honours the implicit marker the mirror and backfill write', async () => {
    // Those writers set `capability_snapshot.isImplicit` and leave
    // `independence_group` null. Reading only the group reported an author's
    // own submission stake as an explicit review, which is how it ends up
    // counting toward a quorum meant to exclude them.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:1', 'human',
                  'approve', ${JSON.stringify({ modelTier: null, isImplicit: true })})`,
    );
    const [stored] = await store.currentAssessments(ref);
    expect(stored!.implicit).toBe(true);
  }, 60_000);

  it('never reports a dispute as implicit, whichever marker carries it', async () => {
    // The tally skips an implicit assessment before it looks at the verdict,
    // so an implicit dispute is an objection no reader ever sees: it counts as
    // an implicit approval, nothing disputes the version, and publication
    // proceeds over a recorded objection. Both writers' markers are checked,
    // because either one alone would erase it.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             independence_group)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:1', 'human',
                  'dispute', 'author')`,
    );
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'dispute', ${JSON.stringify({ isImplicit: true })})`,
    );
    const rows = await store.currentAssessments(ref);
    expect(rows.map((r) => r.verdict)).toEqual(['dispute', 'dispute']);
    expect(rows.map((r) => r.implicit)).toEqual([false, false]);
    // The property that actually matters: the tally still sees both objections.
    expect(tallyAssurance(rows.map(toAssessment)).disputingAssessors).toBe(2);
  }, 60_000);

  it('never reports an abstention or an unreadable verdict as implicit', async () => {
    // Neither is an approval, so neither has an approval stake to be implicit
    // about. An unreadable verdict reads as `abstain`, and the marker goes with
    // the verdict the reader ends up reporting, not the one on disk.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             independence_group)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:1', 'human',
                  'abstain', 'author')`,
    );
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             independence_group)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'user:2', 'human',
                  'garbled', 'author')`,
    );
    const rows = await store.currentAssessments(ref);
    expect(rows.map((r) => r.verdict)).toEqual(['abstain', 'abstain']);
    expect(rows.map((r) => r.implicit)).toEqual([false, false]);
  }, 60_000);

  it('drops an implicit marker the caller pairs with a dispute', async () => {
    // Normalised on write as well as on read: the raw column is read by the
    // mirror and the SDK too, and a row left contradictory on disk would go on
    // hiding the objection from every reader that is not this one.
    const { store, ref, versionId } = await seeded();
    const recorded = await store.recordAssessment({
      version: ref,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'dispute',
      implicit: true,
      recordedAt: new Date().toISOString(),
    });
    expect(recorded.implicit).toBe(false);
    expect(recorded.verdict).toBe('dispute');
    const groups = await db.execute(
      sql`SELECT independence_group FROM kg_assessments
          WHERE subject_id = ${versionId} AND actor_ref = 'user:2'`,
    );
    expect(groups.rows.map((r) => r.independence_group)).toEqual([null]);
  }, 60_000);

  it('still records an implicit approval as implicit', async () => {
    // The bound on the three above: the marker is dropped only where it
    // contradicts the verdict. An author's submit-time approval keeps it, and
    // stays out of the quorum meant to be independent of them.
    const { store, ref } = await seeded();
    const recorded = await store.recordAssessment({
      version: ref,
      assessorRef: 'user:1',
      assessorKind: 'human',
      verdict: 'approve',
      implicit: true,
      recordedAt: new Date().toISOString(),
    });
    expect(recorded.implicit).toBe(true);
    const rows = await store.currentAssessments(ref);
    const profile = tallyAssurance(rows.map(toAssessment));
    expect(profile.implicitApprovals).toBe(1);
    expect(profile.explicitApprovals).toBe(0);
  }, 60_000);

  it('round-trips the canonical shape, and keeps host data out of the gates', () => {
    // What every writer in the repository now produces. The legacy shapes below
    // are about rows already on disk; this is the one a new write has.
    const snapshot = canonicalSnapshot({
      // The tier is translated by the host before it gets here — the store
      // takes capabilities and knows nothing about tiers.
      assuranceCapabilities: ['clinical_expert', ...tierCapabilities('flagship')],
      host: { agentSlug: 'verifier-1' },
    });
    expect(snapshot).toEqual({
      assuranceCapabilities: ['clinical_expert', 'model_tier:flagship'],
      host: { agentSlug: 'verifier-1' },
    });
    // A tier and the capability it becomes are one claim, stated once: a
    // mirrored row and a natively recorded one qualify identically rather
    // than through two different fields.
    expect(capabilitiesOf(snapshot)).toEqual([
      'clinical_expert',
      'model_tier:flagship',
    ]);

    // `host` is carried and never interpreted. A field the store might read is
    // a field a host can influence a gate with.
    expect(capabilitiesOf(canonicalSnapshot({ host: { assuranceCapabilities: ['x'] } })))
      .toBeUndefined();
    expect(readHostField(snapshot, 'agentSlug')).toBe('verifier-1');
    // And a historical row kept the same data at the top level.
    expect(readHostField({ agentSlug: 'verifier-1' }, 'agentSlug')).toBe('verifier-1');
  });

  it('reads the implicit marker from the column and from a historical row', () => {
    // Canonical rows use `independence_group`; the mirror and backfill used to
    // put an `isImplicit` field in the snapshot. Both are read here, in one
    // place, because they were read in two that disagreed: the port consulted
    // both and the consensus reader only the snapshot, so a port-native
    // implicit approval counted toward a quorum meant to be independent of its
    // author.
    expect(
      isImplicitAssessment({ independenceGroup: 'author', capabilitySnapshot: null }),
    ).toBe(true);
    expect(
      isImplicitAssessment({ independenceGroup: null, capabilitySnapshot: { isImplicit: true } }),
    ).toBe(true);
    // Present but unreadable means implicit: `=== true` alone reported a legacy
    // `isImplicit: "true"` as an explicit review.
    expect(
      isImplicitAssessment({ independenceGroup: null, capabilitySnapshot: { isImplicit: 'true' } }),
    ).toBe(true);
    // Absent means "not implicit" — most assessments simply have no marker,
    // and treating that as implicit would discard every genuine review.
    expect(
      isImplicitAssessment({
        independenceGroup: null,
        capabilitySnapshot: canonicalSnapshot({
          assuranceCapabilities: tierCapabilities('mid'),
        }),
      }),
    ).toBe(false);
  });

  it('decodes every capability-snapshot shape the table holds', () => {
    // Three writers, three shapes. Understanding only the newest silently
    // stripped server-owned standing off every mirrored or SDK-written row, so
    // a qualifying approval stopped satisfying the capability gates.
    expect(capabilitiesOf(['model_tier:flagship'])).toEqual([
      'model_tier:flagship',
    ]);
    expect(
      capabilitiesOf({
        capabilities: ['edit_wiki'],
        assuranceCapabilities: ['clinical_expert'],
      }),
    ).toEqual(['clinical_expert']);
    expect(capabilitiesOf({ modelTier: 'flagship', isImplicit: false })).toEqual([
      'model_tier:flagship',
    ]);

    // `capabilities` is descriptive and no gate reads it. Promoting it here
    // would turn an action permission into a publication qualification.
    expect(capabilitiesOf({ capabilities: ['edit_wiki'] })).toBeUndefined();

    // A partially malformed list is not partly trusted. Filtering the bad
    // entries out and keeping the rest grants rather than withholds: the
    // survivor could satisfy `humanApprovalWithCapability` off a snapshot
    // nothing can vouch for.
    expect(capabilitiesOf(['clinical_expert', null])).toBeUndefined();
    expect(
      capabilitiesOf({ assuranceCapabilities: ['clinical_expert', 42] }),
    ).toBeUndefined();

    // A present field decides the shape and never falls through to another.
    // The old chain tried `modelTier` when `assuranceCapabilities` was not an
    // array, so a malformed hybrid granted the flagship capability anyway.
    expect(
      capabilitiesOf({ assuranceCapabilities: null, modelTier: 'flagship' }),
    ).toBeUndefined();
    expect(
      capabilitiesOf({ assuranceCapabilities: 'clinical_expert', modelTier: 'flagship' }),
    ).toBeUndefined();
    // A malformed tier with no capability field is still nothing.
    expect(capabilitiesOf({ modelTier: 42 })).toBeUndefined();

    // Nothing to read stays nothing.
    expect(capabilitiesOf(null)).toBeUndefined();
    expect(capabilitiesOf({ modelTier: null, isImplicit: true })).toBeUndefined();
    expect(capabilitiesOf({})).toBeUndefined();
  });

  it('gives a mirrored tier the same standing as a natively written one', async () => {
    // The point of decoding `modelTier`: a mirrored row and a port-native row
    // must qualify identically, or the same agent's approval counts for
    // different things depending on which path recorded it.
    const { store, spaceId, versionId, ref } = await seeded();
    await db.execute(
      sql`INSERT INTO kg_assessments
            (space_id, subject_type, subject_id, actor_ref, actor_kind, verdict,
             capability_snapshot)
          VALUES (${spaceId}, 'proposal_version', ${versionId}, 'agent:7', 'agent',
                  'approve', ${JSON.stringify({ modelTier: 'flagship', isImplicit: false })})`,
    );
    await store.recordAssessment({
      version: ref,
      assessorRef: 'agent:8',
      assessorKind: 'agent',
      verdict: 'approve',
      assuranceCapabilities: ['model_tier:flagship'],
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    const stored = await store.currentAssessments(ref);
    const mirrored = stored.find((a) => a.assessorRef === 'agent:7');
    const native = stored.find((a) => a.assessorRef === 'agent:8');
    expect(mirrored!.assuranceCapabilities).toEqual(['model_tier:flagship']);
    expect(native!.assuranceCapabilities).toEqual(['model_tier:flagship']);
  }, 60_000);
});

describe('a superseded dispute', () => {
  it('keeps its own word and stays open', async () => {
    // The store leaves it open on purpose: a replacement dispute governs, so
    // the objection is neither settled nor abandoned. Reporting the ruling as
    // `withdrawn` produced "withdrawn but open", which told a caller nothing
    // and could not be distinguished from a complaint the opener dropped.
    await resetIntegrationDb(db);
    const store = kinetixAssuranceStore(db);
    const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    const target = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pe:1',
    });
    const proposal = await createProposal(db, {
      spaceId: space.id,
      targetId: target.id,
      authorActorRef: 'user:1',
      authorKind: 'human',
      state: 'pending',
    });
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'fp',
      authorActorRef: 'user:1',
      actorKind: 'human',
    });
    const ref = {
      proposalId: String(proposal.id),
      versionId: String(version.id),
    };
    const dispute = await store.openDispute({
      version: ref,
      openedByRef: 'user:2',
      openedByKind: 'human',
      openedAt: '2020-01-01T00:00:00.000Z',
    });
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'superseded',
      ruledByRef: 'user:3',
      ruledAt: '2020-01-02T00:00:00.000Z',
    });

    expect((await store.disputes(ref))[0]!.open).toBe(true);
    expect((await store.disputeRulings(dispute.disputeId))[0]!.ruling).toBe(
      'superseded',
    );

    // And a ruling that does close still closes.
    const second = await store.openDispute({
      version: ref,
      openedByRef: 'user:4',
      openedByKind: 'human',
      openedAt: '2020-01-03T00:00:00.000Z',
    });
    await store.ruleDispute({
      disputeId: second.disputeId,
      ruling: 'rejected',
      ruledByRef: 'user:3',
      ruledAt: '2020-01-04T00:00:00.000Z',
    });
    const all = await store.disputes(ref);
    expect(all.find((d) => d.disputeId === second.disputeId)!.open).toBe(false);
  }, 60_000);
});
