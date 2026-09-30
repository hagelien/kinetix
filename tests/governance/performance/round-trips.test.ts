/**
 * §18: performance constraints.
 *
 * §18 opens with the concern:
 *
 *   > The generic architecture must not turn one simple Kinetix write into a
 *   > chain of excessive database round trips.
 *
 * The Phase 0 baseline captured wall-clock timings and said honestly what they
 * are worth: PGlite is WASM on a single connection with no production query
 * planner, so its milliseconds are a tripwire and not a measurement. **Round
 * trips are different.** A query count is the same number here as in
 * production, because it is a property of the code rather than of the machine —
 * so it is the part of §18 this harness can actually assert.
 *
 * The §18 rules that are structural rather than timed are asserted too. The one
 * that is genuinely about production latency is not, and says so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { agentVerifications, agents, pendingEdits, wikiPages } from '../../../db/schema.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import {
  registeredTargetTypes,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');

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

/**
 * Count the queries one operation issues.
 *
 * Hooks `session.prepareQuery`, not `session.execute`: Drizzle's builders
 * construct a prepared query and call `.execute()` on *that*, so wrapping
 * `execute` on the session counts nothing at all — which is exactly what the
 * first version of this did, and why a counter has to be proved to count
 * before it is trusted to prove anything. The `queries > 0` assertion below is
 * that proof.
 */
async function countQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  const session = (
    db as unknown as { session: { prepareQuery: (...a: unknown[]) => unknown } }
  ).session;
  const original = session.prepareQuery.bind(session);
  let queries = 0;
  session.prepareQuery = (...args: unknown[]) => {
    queries += 1;
    return original(...args);
  };
  try {
    const result = await run();
    return { result, queries };
  } finally {
    session.prepareQuery = original;
  }
}

interface World {
  editId: number;
  agentUserId: number;
  verificationId: number;
}

async function seedWorld(): Promise<World> {
  const authorId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  const verifierUserId = await seedUser(db, {
    email: 'verifier@example.com',
    username: 'verifier',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });
  const [verifier] = await db
    .insert(agents)
    .values({
      userId: verifierUserId,
      name: 'verifier-agent',
      slug: 'verifier-agent',
      status: 'active',
      modelTier: 'flagship',
    })
    .returning({ id: agents.id });

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
      editType: 'wiki_fact',
      targetId: page!.id,
      sectionId: 'pk',
      factOperation: 'add',
      factStatement: 'Halveringstiden er 30 timer.',
      proposedValue: {
        type: 'fact',
        attrs: { factId: 'f-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  const [verification] = await db
    .insert(agentVerifications)
    .values({
      agentId: verifier!.id,
      targetType: 'pending_edit',
      targetId: edit!.id,
      verdict: 'approve',
      verifierTier: 'flagship',
    })
    .returning({ id: agentVerifications.id });

  return {
    editId: edit!.id,
    agentUserId: verifierUserId,
    verificationId: verification!.id,
  };
}

async function enableMirroring(): Promise<void> {
  await setMigrationMode({
    targetType: 'pending_edit',
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();
}

describe('the mirror costs a bounded number of round trips', () => {
  /**
   * A budget, not a snapshot of today's number.
   *
   * Deliberately generous: the point is to catch an N+1 or a per-row lookup
   * creeping in, not to freeze the current count and turn every refactor into a
   * test edit. A ceiling that tracks the implementation exactly is a ceiling
   * nobody can change anything under.
   */
  const MIRROR_BUDGET = 20;

  it('mirrors a proposal version within budget', async () => {
    await enableMirroring();
    const world = await seedWorld();
    const { result, queries } = await countQueries(() =>
      mirrorProposalVersion({
        targetType: 'pending_edit',
        targetId: world.editId,
        legacyPendingEditId: world.editId,
      }),
    );
    expect(result.mirrored).toBe(true);
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(MIRROR_BUDGET);
  });

  it('mirrors an assessment within budget', async () => {
    await enableMirroring();
    const world = await seedWorld();
    await mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    });

    const { result, queries } = await countQueries(() =>
      mirrorAssessment({
        targetType: 'pending_edit',
        targetId: world.editId,
        legacyVerificationId: world.verificationId,
        actorRef: `user:${world.agentUserId}`,
        verdict: 'approve',
      }),
    );
    expect(result.mirrored).toBe(true);
    expect(queries).toBeLessThanOrEqual(MIRROR_BUDGET);
  });

  it('costs almost nothing when mirroring is off', async () => {
    // The property that matters most for an unmigrated deployment: a target
    // nobody advanced pays almost nothing for the machinery existing.
    const world = await seedWorld();
    const { result, queries } = await countQueries(() =>
      mirrorProposalVersion({
        targetType: 'pending_edit',
        targetId: world.editId,
        legacyPendingEditId: world.editId,
      }),
    );
    expect(result.mirrored).toBe(false);
    expect(result.skipped).toBe('mode');
    // The space lookup and the mode read, and nothing else — no adapter load,
    // no row fetch, no write.
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(3);
  });

  it('re-mirroring an unchanged version does not rewrite it', async () => {
    await enableMirroring();
    const world = await seedWorld();
    const args = {
      targetType: 'pending_edit',
      targetId: world.editId,
      legacyPendingEditId: world.editId,
    };
    await mirrorProposalVersion(args);
    const second = await mirrorProposalVersion(args);
    expect(second.mirrored).toBe(false);
    expect(second.skipped).toBe('already_mirrored');
  });
});

describe('the structural rules', () => {
  it('caches registered adapters in-process', () => {
    registerKinetixAdapters();
    const first = registeredTargetTypes('kinetix');
    registerKinetixAdapters();
    expect(registeredTargetTypes('kinetix')).toEqual(first);
  });

  it('keeps policy evaluation free of database access', () => {
    // The core is a dependency now, so its half of this is checked against the
    // JavaScript it ships; the Kinetix policy that stayed behind is checked
    // where it lives. `readdirSync` throws on a missing directory, which is
    // what should happen — an empty file list would pass this silently.
    const sources = [
      ...fs
        .readdirSync(path.join(ROOT, 'src/lib/assurance'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(ROOT, 'src/lib/assurance', f)),
      ...fs
        .readdirSync(path.join(ROOT, 'node_modules/assurance-core/dist'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(ROOT, 'node_modules/assurance-core/dist', f)),
    ];
    expect(sources.length).toBeGreaterThan(8);
    for (const file of sources) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, path.basename(file)).not.toMatch(/from 'drizzle-orm'/);
    }
  });

  it('makes no network call inside the publication transaction', () => {
    // A fetch inside the unit of work would hold a row lock across an unbounded
    // wait — the worst version of §18's concern.
    const source = fs.readFileSync(
      path.join(ROOT, 'api/_lib/knowledge-governance/publication.ts'),
      'utf8',
    );
    for (const call of ['fetch(', 'axios', 'node:https', 'undici']) {
      expect(source, call).not.toContain(call);
    }
  });

  it('carries evidence ids rather than evidence content', () => {
    // "do not hydrate full evidence content unless the review packet needs it".
    const source = fs.readFileSync(
      path.join(ROOT, 'api/_lib/knowledge-governance/adapters/kinetix/support.ts'),
      'utf8',
    );
    expect(source).toContain('citationEvidence');
    expect(source).not.toMatch(/\.from\(citations\)/);
  });
});

describe('what this harness cannot assert', () => {
  it('does not claim a production latency comparison', () => {
    // §18 asks for p50/p95 against the Phase 0 baseline. Round trips are
    // asserted above because a query count is the same number here as in
    // production; wall-clock is not, and pretending otherwise would put a
    // number in a report that means nothing.
    const baseline = fs.readFileSync(
      path.join(
        ROOT,
        'tests/governance/legacy-contract/review-queue-baseline.perf.test.ts',
      ),
      'utf8',
    );
    expect(baseline).toContain('not representative of production timing');
  });
});
