/**
 * Phase 13: validating the abstraction against a second, non-pharmacology
 * domain.
 *
 * The plan calls this phase **mandatory before declaring the abstraction
 * reusable**, and sets one hard constraint: the second domain implements only
 * adapters and policy definitions, and *"if it must modify core code for domain
 * vocabulary, that is evidence the abstraction is still Kinetix-shaped."*
 *
 * `adr-domain.ts` is an Architecture Decision Records domain — different target
 * schema, different evidence types (a passing test, a benchmark, a superseded
 * ADR — none of them citations), different risk rules (blast radius and
 * reversibility, not whether a value feeds a calculation), human and agent
 * contributors, and a mix of content that auto-publishes and content that needs
 * a named human.
 *
 * These tests answer §13's four abstraction questions with assertions rather
 * than with an opinion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADR_SPACE,
  ADR_TARGET_TYPE,
  ARCHITECT_CAPABILITY,
  AdrStore,
  IRREVERSIBLE_TAG,
  WIDE_BLAST_RADIUS_TAG,
  adrAdapter,
  adrPolicy,
  type DecisionRecord,
} from './adr-domain.js';
import {
  registerKnowledgeTargetAdapter,
  getKnowledgeTargetAdapter,
  registeredTargetTypes,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import {
  tallyAssurance,
  poolStateFromEffectiveQuorum,
  type PolicyContext,
} from 'assurance-core';

const store = new AdrStore();

beforeEach(() => {
  store.clear();
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
  registerKnowledgeTargetAdapter(adrAdapter(store));
});

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'adr-001',
    title: 'Use PGlite for integration tests',
    status: 'proposed',
    context: 'Docker is unavailable in the sandboxed CI runners.',
    decision: 'Run integration tests against in-process PGlite.',
    consequences: ['No Docker dependency', 'WASM Postgres differs subtly from Neon'],
    affects: ['ci'],
    reversible: true,
    evidence: [{ kind: 'passing_test', ref: 'tests/integration/harness' }],
    authorRef: 'user:1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function contextFor(
  risk: { level: 'low' | 'medium' | 'high'; tags: readonly string[] },
  assessments: Parameters<typeof tallyAssurance>[0],
): PolicyContext {
  return {
    space: ADR_SPACE,
    targetType: ADR_TARGET_TYPE,
    proposalVersionId: 'adr-001@v1',
    author: {
      actorRef: 'user:1',
      kind: 'agent',
      capabilities: [],
      assuranceCapabilities: [],
    },
    risk: { level: risk.level, tags: [...risk.tags] },
    assurance: tallyAssurance(assessments),
    pool: poolStateFromEffectiveQuorum({ effectiveQuorum: 1, designTargetQuorum: 2 }),
    flags: [],
  };
}

describe('§13 — the second domain adds no core code', () => {
  it('imports only the core and the adapter contract', () => {
    // The constraint, enforced statically. A Kinetix import here would be the
    // finding: it would mean the abstraction could not express this domain
    // without borrowing pharmacology's plumbing.
    const source = fs.readFileSync(
      path.join(__dirname, 'adr-domain.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(
        spec,
        `adr-domain.ts must not import ${spec}`,
      ).toMatch(
        /^(assurance-core|.*knowledge-governance\/target-adapter\.js)$/,
      );
    }
  });

  it('names no Kinetix concept anywhere in the domain', () => {
    const source = fs.readFileSync(path.join(__dirname, 'adr-domain.ts'), 'utf8');
    const body = source.replace(/^[\s\S]*?\*\//, ''); // drop the header comment
    for (const term of ['pendingEdit', 'pending_edits', 'drizzle', 'wiki', 'drug']) {
      expect(body.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  it('works without a database at all', async () => {
    // The adapter contract mentions no storage. A second domain that could only
    // work against Postgres would be a weaker result than one backed by a Map.
    store.put(record());
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    const version = await adapter.loadVersion({
      space: ADR_SPACE,
      type: ADR_TARGET_TYPE,
      id: 'adr-001',
    });
    expect(version).not.toBeNull();
  });
});

describe('§13 — the registry needed no new switch case', () => {
  it('hosts both domains side by side', () => {
    expect(registeredTargetTypes(ADR_SPACE)).toEqual([ADR_TARGET_TYPE]);
    expect(registeredTargetTypes('kinetix')).toContain('pending_edit');
  });

  it('keeps their target types from colliding', () => {
    // The reason the registry is keyed on (space, type) rather than type.
    expect(getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE).space).toBe(
      ADR_SPACE,
    );
    expect(() => getKnowledgeTargetAdapter('kinetix', ADR_TARGET_TYPE)).toThrow();
  });
});

describe('§13 — the generic names still make sense without pharmacology', () => {
  it('expresses this domain’s risk on the same three-level scale', async () => {
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    const version = async (over: Partial<DecisionRecord>) => {
      store.put(record(over));
      return (await adapter.loadVersion({
        space: ADR_SPACE,
        type: ADR_TARGET_TYPE,
        id: 'adr-001',
      }))!;
    };

    const trivial = await adapter.classifyRisk({
      version: await version({ reversible: true, affects: ['ci'] }),
      current: null,
    });
    expect(trivial.level).toBe('low');

    const wide = await adapter.classifyRisk({
      version: await version({ reversible: true, affects: ['ci', 'api', 'web'] }),
      current: null,
    });
    expect(wide.level).toBe('medium');
    expect(wide.tags).toContain(WIDE_BLAST_RADIUS_TAG);

    const permanent = await adapter.classifyRisk({
      version: await version({ reversible: false }),
      current: null,
    });
    expect(permanent.level).toBe('high');
    expect(permanent.tags).toContain(IRREVERSIBLE_TAG);
  });

  it('carries evidence that is not a citation', async () => {
    // §9.1's point: a core that only understands "citation" cannot govern a
    // space whose evidence is a passing test or an incident report.
    store.put(
      record({
        reversible: false,
        evidence: [
          { kind: 'benchmark', ref: 'bench/2026-01', summary: '3x faster' },
          { kind: 'incident_report', ref: 'INC-42' },
        ],
      }),
    );
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    const version = (await adapter.loadVersion({
      space: ADR_SPACE,
      type: ADR_TARGET_TYPE,
      id: 'adr-001',
    }))!;
    const packet = await adapter.buildReviewPacket({
      version,
      actor: { actorRef: 'user:2', kind: 'human', capabilities: [] },
    });
    expect(packet.evidence.map((e) => e.kind)).toEqual([
      'benchmark',
      'incident_report',
    ]);
    expect(packet.evidenceRequirements[0]!.kind).toBe('passing_test');
  });

  it('seals its packets under the same anti-echo-chamber rule', async () => {
    // The invariant is domain-independent, and this domain got it for free.
    store.put(record());
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    const version = (await adapter.loadVersion({
      space: ADR_SPACE,
      type: ADR_TARGET_TYPE,
      id: 'adr-001',
    }))!;
    const packet = await adapter.buildReviewPacket({
      version,
      actor: { actorRef: 'user:2', kind: 'human', capabilities: [] },
    });
    expect(JSON.stringify(packet)).not.toContain('verdict');
    expect(Object.isFrozen(packet)).toBe(true);
  });
});

describe('§13 — the policy is different, and needed no new primitive', () => {
  const set = adrPolicy();

  it('auto-publishes a reversible, narrow decision on one approval', async () => {
    // "Some content that can auto-publish": this domain's low bar is genuinely
    // lower than Kinetix's, and expressing that took no core change.
    const decision = set.evaluate(
      contextFor(
        { level: 'low', tags: [] },
        [{ assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' }],
      ),
    );
    expect(decision.allowed).toBe(true);
  });

  it('requires a second reviewer once the blast radius is wide', () => {
    const oneApproval = set.evaluate(
      contextFor(
        { level: 'medium', tags: [WIDE_BLAST_RADIUS_TAG] },
        [{ assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' }],
      ),
    );
    expect(oneApproval.allowed).toBe(false);

    const twoApprovals = set.evaluate(
      contextFor(
        { level: 'medium', tags: [WIDE_BLAST_RADIUS_TAG] },
        [
            { assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' },
            { assessorRef: 'user:3', assessorKind: 'agent', verdict: 'approve' },
          ],
      ),
    );
    expect(twoApprovals.allowed).toBe(true);
  });

  it('requires a named human for an irreversible decision', () => {
    // "Some content that requires stronger review", and note the shape: this
    // domain wants a *qualified human*, where Kinetix's high-risk rule wants a
    // flagship *model*. Same primitive, different meaning.
    const agentsOnly = set.evaluate(
      contextFor(
        { level: 'high', tags: [IRREVERSIBLE_TAG] },
        [
            { assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' },
            { assessorRef: 'user:3', assessorKind: 'agent', verdict: 'approve' },
          ],
      ),
    );
    expect(agentsOnly.allowed).toBe(false);

    const withArchitect = set.evaluate(
      contextFor(
        { level: 'high', tags: [IRREVERSIBLE_TAG] },
        [
            { assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' },
            {
              assessorRef: 'user:9',
              assessorKind: 'human',
              verdict: 'approve',
              assuranceCapabilities: [ARCHITECT_CAPABILITY],
            },
          ],
      ),
    );
    expect(withArchitect.allowed).toBe(true);
  });

  it('blocks on a dispute, exactly as the other domain does', () => {
    const decision = set.evaluate(
      contextFor(
        { level: 'low', tags: [] },
        [
            { assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' },
            { assessorRef: 'user:3', assessorKind: 'human', verdict: 'dispute' },
          ],
      ),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.unmet.map((u) => u.requirementId)).toContain(
      'assurance.noDisputingAssessments',
    );
  });

  it('names its own policy version on every decision', () => {
    const decision = set.evaluate(
      contextFor({ level: 'low', tags: [] }, []),
    );
    expect(decision.policyId).toBe('architecture-decisions');
    expect(decision.policyVersion).toBe('v1');
  });
});

describe('§13 — the full lifecycle runs on adapters alone', () => {
  it('validates, reviews, decides and applies', async () => {
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    store.put(record({ reversible: true, affects: ['ci'] }));
    const target = { space: ADR_SPACE, type: ADR_TARGET_TYPE, id: 'adr-001' };
    const version = (await adapter.loadVersion(target))!;

    expect((await adapter.validateProposal({
      proposal: version.payload,
      current: null,
      actor: { actorRef: 'user:1', kind: 'agent', capabilities: [] },
    })).valid).toBe(true);

    const decision = adrPolicy().evaluate(
      contextFor(
        { level: 'low', tags: [] },
        [{ assessorRef: 'user:2', assessorKind: 'agent', verdict: 'approve' }],
      ),
    );
    expect(decision.allowed).toBe(true);

    await adapter.apply!({
      version,
      decision: {
        allowed: true,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        holdReason: null,
      },
      actor: { actorRef: 'user:2', kind: 'human', capabilities: [] },
      tx: null,
    });
    expect(store.applied).toEqual(['adr-001']);
    expect(store.get('adr-001')!.status).toBe('accepted');
  });

  it('refuses a malformed record in this domain’s own terms', async () => {
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    const result = await adapter.validateProposal({
      proposal: record({ decision: '', consequences: [] }),
      current: null,
      actor: { actorRef: 'user:1', kind: 'agent', capabilities: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code).sort()).toEqual([
      'consequences_missing',
      'decision_empty',
    ]);
  });

  it('hides a superseded record from review but not from history', async () => {
    // This domain reached the same shape as Kinetix's `includeHidden`
    // independently, which is a point in the seam's favour.
    const adapter = getKnowledgeTargetAdapter(ADR_SPACE, ADR_TARGET_TYPE);
    store.put(record({ status: 'superseded', supersedes: 'adr-000' }));
    const target = { space: ADR_SPACE, type: ADR_TARGET_TYPE, id: 'adr-001' };
    expect(await adapter.loadVersion(target)).toBeNull();
    expect(await adapter.loadVersion(target, { includeHidden: true })).not.toBeNull();
  });
});
