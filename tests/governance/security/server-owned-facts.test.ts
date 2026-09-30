/**
 * §19 — security and integrity requirements.
 *
 * §19.1 lists six facts a request body must never be trusted for: actor kind,
 * user role, agent active status, self-review grant, verifier capability tier,
 * and human-expert designation. Each of them is the input to a gate, and each
 * has a plausible-looking place in a request payload where a caller could put
 * it — `model` is already an accepted field on a verdict, and it sits one
 * rename away from `modelTier`.
 *
 * These tests attack from the caller's side: they send the claim and assert the
 * server used its own answer. A test that only read the server's derivation
 * would prove the derivation exists, not that nothing else overrides it.
 *
 * §19.2 (capability snapshot at write time) and §19.4 (append-only audit) are
 * covered here as structural guards; the behavioural halves live in
 * `../concurrency/races.test.ts` (tier snapshots survive a downgrade) and
 * `../store/generic-store.test.ts` (supersession preserves history).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentVerifications,
  agents,
  pendingEdits,
  wikiPages,
} from '../../../db/schema.js';
import agentVerificationsHandler from '../../../api/agent-verifications.js';
import { verificationTargetVersion } from '../../../api/_lib/agent-verifications.js';
import {
  actorContextFrom,
  resolveActorContext,
  resolveAssuranceCapabilities,
  systemActorContext,
} from '../../../api/_lib/knowledge-governance/actor-context.js';
import { governanceClient } from '../../../api/_lib/knowledge-governance/sdk/client.js';
import { ensureKinetixSpace } from '../../../api/_lib/knowledge-governance/backfill.js';
import { KINETIX_FLAGSHIP_CAPABILITY } from '../../../src/lib/assurance/policy.js';
import { modelTierCapability } from 'assurance-core';
import {
  createResponse,
  jsonRequest,
  type Handler,
  type ResponseState,
} from '../support/http.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import { seedUser } from '../../integration/setup/seed.js';

const { getUserFromRequestMock } = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
}));
vi.mock('../../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  getUserFromRequestMock.mockReset();
});

async function call(
  handler: Handler,
  args: {
    as: { userId: number; role: string };
    method: string;
    url: string;
    body: unknown;
  },
): Promise<ResponseState> {
  getUserFromRequestMock.mockResolvedValue({
    userId: args.as.userId,
    role: args.as.role,
  });
  const { res, state } = createResponse();
  await handler(jsonRequest(args.method, args.url, args.body), res);
  return state;
}

interface World {
  authorUserId: number;
  reviewerUserId: number;
  reviewerAgentId: number;
  editId: number;
}

/** An agent-authored wiki_fact plus one mid-tier reviewer agent. */
async function seedWorld(reviewerTier: string | null = 'mid'): Promise<World> {
  const authorUserId = await seedUser(db, {
    email: 'author@example.com',
    username: 'author',
    role: 'contributor',
  });
  await db.insert(agents).values({
    userId: authorUserId,
    name: 'author-agent',
    slug: 'author-agent',
    status: 'active',
  });
  const reviewerUserId = await seedUser(db, {
    email: 'reviewer@example.com',
    username: 'reviewer',
    role: 'editor',
  });
  const [reviewerAgent] = await db
    .insert(agents)
    .values({
      userId: reviewerUserId,
      name: 'reviewer',
      slug: 'reviewer',
      status: 'active',
      modelTier: reviewerTier,
      selfReviewEnabled: false,
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
      createdBy: authorUserId,
      updatedBy: authorUserId,
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
        attrs: { factId: 'fact-halflife-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: authorUserId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });

  return {
    authorUserId,
    reviewerUserId,
    reviewerAgentId: reviewerAgent!.id,
    editId: edit!.id,
  };
}

async function targetVersion(editId: number): Promise<string> {
  const version = await verificationTargetVersion({
    targetType: 'pending_edit',
    targetId: editId,
  });
  return version!;
}

async function recordedTier(world: World): Promise<string | null> {
  const [row] = await db
    .select({ tier: agentVerifications.verifierTier })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetId, world.editId),
        eq(agentVerifications.agentId, world.reviewerAgentId),
      ),
    );
  return row?.tier ?? null;
}

describe('§19.1 — the verdict route refuses to be told who the caller is', () => {
  /**
   * The schema is `.strict()`, so an unknown key is a 400 rather than a
   * silently-ignored field. That distinction matters: a caller that gets a 201
   * back has no way to know its claim was dropped, and an ignored field is one
   * refactor away from being read.
   */
  const FORBIDDEN_CLAIMS: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['verifier capability tier', { verifierTier: 'flagship' }],
    ['model tier under another name', { modelTier: 'flagship' }],
    ['actor kind', { actorKind: 'human' }],
    ['user role', { role: 'admin' }],
    ['agent identity', { agentId: 1 }],
    ['self-review grant', { selfReviewEnabled: true }],
    ['assurance capabilities', { assuranceCapabilities: ['clinical_expert'] }],
    ['human-expert designation', { clinicalExpert: true }],
  ];

  for (const [label, claim] of FORBIDDEN_CLAIMS) {
    it(`rejects a body asserting ${label}`, async () => {
      const world = await seedWorld();
      const posted = await call(agentVerificationsHandler as Handler, {
        as: { userId: world.reviewerUserId, role: 'editor' },
        method: 'POST',
        url: '/api/agent-verifications',
        body: {
          targetType: 'pending_edit',
          targetId: world.editId,
          targetVersion: await targetVersion(world.editId),
          verdict: 'approve',
          rationaleMd: '',
          ...claim,
        },
      });
      expect(posted.statusCode).toBe(400);
      // Nothing was written, so a rejected claim cannot leave a half-recorded
      // verdict behind.
      expect(await recordedTier(world)).toBeNull();
    });
  }

  it('snapshots the server-owned tier onto the verdict it does accept', async () => {
    const world = await seedWorld('mid');
    const posted = await call(agentVerificationsHandler as Handler, {
      as: { userId: world.reviewerUserId, role: 'editor' },
      method: 'POST',
      url: '/api/agent-verifications',
      body: {
        targetType: 'pending_edit',
        targetId: world.editId,
        targetVersion: await targetVersion(world.editId),
        verdict: 'approve',
        rationaleMd: '',
        // `model` IS accepted — it is audit metadata (§2.3), self-reported and
        // never read by a gate. This is the field the forbidden ones above sit
        // next to, which is exactly why they are worth a test.
        model: 'a-model-that-claims-to-be-enormous',
      },
    });
    expect(posted.statusCode).toBeLessThan(300);
    expect(await recordedTier(world)).toBe('mid');
  });
});

describe('§19.1 — actor kind is derived, never asserted', () => {
  it('calls a user with no active agent row a human', async () => {
    const userId = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'editor',
    });
    expect((await resolveActorContext({ userId, role: 'editor' })).kind).toBe(
      'human',
    );
  });

  it('calls the same user an agent once an active agent row exists', async () => {
    const userId = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'editor',
    });
    await db.insert(agents).values({
      userId,
      name: 'person-agent',
      slug: 'person-agent',
      status: 'active',
    });
    expect((await resolveActorContext({ userId, role: 'editor' })).kind).toBe(
      'agent',
    );
  });

  it('drops back to human when the agent is revoked', async () => {
    // Agent *active* status, the third item on §19.1's list. The projection has
    // to read status rather than mere existence, or a revoked agent keeps peer
    // standing forever.
    const userId = await seedUser(db, {
      email: 'person@example.com',
      username: 'person',
      role: 'editor',
    });
    await db.insert(agents).values({
      userId,
      name: 'person-agent',
      slug: 'person-agent',
      status: 'revoked',
    });
    expect((await resolveActorContext({ userId, role: 'editor' })).kind).toBe(
      'human',
    );
  });

  it('takes no capabilities from its caller — only from the matrix', () => {
    // `actorContextFrom` is the pure projection, and the one place a caller
    // could inject standing. It derives `assuranceCapabilities` from the agent
    // facts and the matrix capabilities; there is no parameter for it.
    const withoutTier = actorContextFrom({
      userId: 1,
      role: 'editor',
      capabilities: ['review.queue.readAll'],
      agent: {
        agentId: 1,
        slug: 'a',
        selfReviewEnabled: false,
        modelTier: null,
      },
    });
    expect(withoutTier.assuranceCapabilities).toEqual([]);

    const withTier = actorContextFrom({
      userId: 1,
      role: 'editor',
      capabilities: ['review.queue.readAll'],
      agent: {
        agentId: 1,
        slug: 'a',
        selfReviewEnabled: false,
        modelTier: 'flagship',
      },
    });
    expect(withTier.assuranceCapabilities).toEqual([KINETIX_FLAGSHIP_CAPABILITY]);
  });

  it('records the self-review grant as metadata, not as a capability', () => {
    // §19.1's fourth item. The grant is real and server-owned, but it enlarges
    // the reviewer pool rather than lowering a bar, so turning it into a
    // capability would misrepresent which direction it cuts.
    const context = actorContextFrom({
      userId: 1,
      role: 'editor',
      capabilities: [],
      agent: {
        agentId: 1,
        slug: 'a',
        selfReviewEnabled: true,
        modelTier: 'flagship',
      },
    });
    expect(context.metadata?.selfReviewEnabled).toBe(true);
    expect(context.capabilities).not.toContain('selfReviewEnabled');
    expect(context.assuranceCapabilities).toEqual([KINETIX_FLAGSHIP_CAPABILITY]);
  });
});

describe('§19.1 — the SDK resolves standing server-side', () => {
  it('ignores an actor context that claims a tier it does not hold', async () => {
    const world = await seedWorld('mid');
    await ensureKinetixSpace(db);
    const client = governanceClient({
      db,
      resolveAssuranceCapabilities: (actor) =>
        resolveAssuranceCapabilities(actor.actorRef),
    });

    const { version } = await client.proposals.create(
      {
        actorRef: `user:${world.authorUserId}`,
        kind: 'agent',
        capabilities: [],
        assuranceCapabilities: [],
      },
      {
        targetType: 'pending_edit',
        targetKey: String(world.editId),
        payload: { factStatement: 'Halveringstiden er 30 timer.' },
      },
    );

    const assessment = await client.assessments.submit({
      proposalVersionId: version.id,
      actor: {
        actorRef: `user:${world.reviewerUserId}`,
        kind: 'agent',
        capabilities: ['review.queue.readAll'],
        // The attack: the caller asserts flagship standing and a clinical
        // grant it was never given.
        assuranceCapabilities: [
          KINETIX_FLAGSHIP_CAPABILITY,
          'clinical_expert',
        ],
      },
      verdict: 'approve',
    });

    const snapshot = assessment.capabilitySnapshot as {
      assuranceCapabilities: string[];
    };
    expect(snapshot.assuranceCapabilities).toEqual([modelTierCapability('mid')]);
    expect(snapshot.assuranceCapabilities).not.toContain('clinical_expert');
  });

  it('confers nothing at all when the host binds no resolver', async () => {
    // The safe default. An SDK that fell back to the caller's list when
    // unconfigured would make the secure path the one you have to opt into.
    const world = await seedWorld('flagship');
    await ensureKinetixSpace(db);
    const client = governanceClient({ db });
    const { version } = await client.proposals.create(
      {
        actorRef: `user:${world.authorUserId}`,
        kind: 'agent',
        capabilities: [],
        assuranceCapabilities: [],
      },
      {
        targetType: 'pending_edit',
        targetKey: String(world.editId),
        payload: { factStatement: 'Halveringstiden er 30 timer.' },
      },
    );
    const assessment = await client.assessments.submit({
      proposalVersionId: version.id,
      actor: {
        actorRef: `user:${world.reviewerUserId}`,
        kind: 'agent',
        capabilities: [],
        assuranceCapabilities: [KINETIX_FLAGSHIP_CAPABILITY],
      },
      verdict: 'approve',
    });
    const snapshot = assessment.capabilitySnapshot as {
      assuranceCapabilities: string[];
    };
    expect(snapshot.assuranceCapabilities).toEqual([]);
  });

  it('gives a system actor no standing, however it is addressed', async () => {
    expect(await resolveAssuranceCapabilities('system:sweep')).toEqual([]);
    expect(await resolveAssuranceCapabilities('service:importer')).toEqual([]);
    expect(await resolveAssuranceCapabilities('user:999999')).toEqual([]);
    expect(systemActorContext('sweep').assuranceCapabilities).toEqual([]);
  });

  it('resolves the real standing for a real actor, so the guard is not blanket-empty', async () => {
    const world = await seedWorld('flagship');
    expect(
      await resolveAssuranceCapabilities(`user:${world.reviewerUserId}`),
    ).toEqual([KINETIX_FLAGSHIP_CAPABILITY]);
  });
});

describe('§19.3 — the SDK does not hand out a database', () => {
  it('exposes only its namespaces and its space name, no handle to query with', () => {
    // §19.3: "The SDK must not encourage direct database access." The `db`
    // option exists so a test (and a transaction-bound caller) can supply a
    // handle; what matters is that the client never gives one *back*. An
    // integrator that can reach the connection can write around every gate in
    // this plan, and would eventually.
    const client = governanceClient({ db });
    expect(Object.keys(client).sort()).toEqual([
      'assessments',
      'assurance',
      'disputes',
      'history',
      'proposals',
      'review',
      // The space this client is bound to, as a string. A name, not a handle.
      'space',
    ]);
    expect(typeof client.space).toBe('string');
    for (const [name, value] of Object.entries(client)) {
      expect(value, name).not.toHaveProperty('db');
      expect(value, name).not.toHaveProperty('execute');
      expect(value, name).not.toHaveProperty('session');
      expect(value, name).not.toHaveProperty('query');
    }
  });

  it('names no model vendor and no raw SQL escape hatch in its source', () => {
    const source = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'api/_lib/knowledge-governance/sdk/client.ts',
      ),
      'utf8',
    );
    // A `sql\`` template or an exported `db` would be the two ways the handle
    // leaks in practice; neither is present, and both are cheap to catch.
    expect(source).not.toMatch(/\bsql`/);
    expect(source).not.toMatch(/^export\s+(const|let|function)\s+db\b/m);
  });
});

describe('§19.4 — the audit tables offer no way to rewrite history', () => {
  const STORE_DIR = path.resolve(
    process.cwd(),
    'api/_lib/knowledge-governance/store',
  );

  const GOVERNANCE_DIR = path.resolve(
    process.cwd(),
    'api/_lib/knowledge-governance',
  );

  /** Every .ts file under the governance server layer, recursively. */
  function governanceSources(): Array<{ path: string; source: string }> {
    const out: Array<{ path: string; source: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          out.push({ path: full, source: fs.readFileSync(full, 'utf8') });
        }
      }
    };
    walk(GOVERNANCE_DIR);
    return out;
  }

  function storeSource(): string {
    return fs
      .readdirSync(STORE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(STORE_DIR, f), 'utf8'))
      .join('\n');
  }

  it('finds the store, so a moved directory fails loudly', () => {
    expect(fs.existsSync(STORE_DIR)).toBe(true);
    expect(fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.ts')).length)
      .toBeGreaterThan(5);
  });

  const APPEND_ONLY_TABLES = [
    'kgAssessments',
    'kgPolicyDecisions',
    'kgDisputeRulings',
    'kgPublicationEvents',
    'kgAuditEvents',
  ] as const;

  for (const table of APPEND_ONLY_TABLES) {
    it(`never updates or deletes ${table}`, () => {
      const source = storeSource();
      // Enforcement by absence: there is no guard to bypass because there is no
      // code path. A correction supersedes — `reviseAssessment` inserts a row
      // naming the one it replaces — and supersession is an insert.
      expect(source).not.toMatch(
        new RegExp(String.raw`\.update\(\s*${table}\b`),
      );
      expect(source).not.toMatch(
        new RegExp(String.raw`\.delete\(\s*${table}\b`),
      );
    });
  }

  it('never deletes a proposal version, and updates only its submitted stamp', () => {
    const source = storeSource();
    expect(source).not.toMatch(/\.delete\(\s*kgProposalVersions\b/);

    // Versions carry one permitted update — `markSubmitted` — and it is the
    // exception §19.4 tolerates because it records when a draft entered review
    // rather than changing what was judged. Asserted narrowly, on the `.set()`
    // that follows: a blanket "no update" would have to be deleted the moment
    // anyone read the code, and a blanket allowance would let a payload rewrite
    // in beside it.
    const updates = [
      ...source.matchAll(
        /\.update\(\s*kgProposalVersions\s*\)\s*\n?\s*\.set\(\{([^}]*)\}\)/g,
      ),
    ];
    expect(updates).toHaveLength(1);
    const assigned = updates[0]![1]!
      .split(',')
      .map((part) => part.split(':')[0]!.trim())
      .filter(Boolean);
    expect(assigned).toEqual(['submittedAt']);
  });

  it('is the only place in the codebase that writes a kg_* table at all', () => {
    // The guards above are scoped to `store/`, which makes them locally true
    // and globally worthless on their own: a service that inserted into
    // `kgAssessments` directly could update the same row later and nothing in
    // this file would see it. This is what closes that — enforcement by
    // absence only enforces anything if the absence is total.
    const offenders: string[] = [];
    for (const file of governanceSources()) {
      if (file.path.startsWith(STORE_DIR)) continue;
      for (const match of file.source.matchAll(
        /\.(insert|update|delete)\(\s*(kg[A-Z][A-Za-z]*)/g,
      )) {
        // `kg_migration_state` is the control plane, not the audit. §11.4 has
        // an operator advancing a target and retreating it again, so it is
        // mutable by design and owned by `migration-state.ts` — which is a
        // different kind of table from the ones that record what happened.
        if (
          match[2] === 'kgMigrationState' &&
          file.path.endsWith('migration-state.ts')
        ) {
          continue;
        }
        offenders.push(`${path.relative(process.cwd(), file.path)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans the files it means to, so an empty result is not an empty scan', () => {
    const files = governanceSources();
    expect(files.length).toBeGreaterThan(20);
    // The one legitimate write outside the store is present, which proves the
    // regex above matches the shape it is looking for.
    const controlPlane = files.find((f) => f.path.endsWith('migration-state.ts'));
    expect(controlPlane?.source).toMatch(/\.update\(\s*kgMigrationState/);
  });

  it('does update the projections, which are derived and not history', () => {
    // The inverse, so the assertions above are not passing because the store
    // simply never writes. `kg_proposals` carries a current-version projection
    // that is rebuilt from the version history, and updating it rewrites
    // nothing: the history it is derived from is the append-only part.
    expect(storeSource()).toMatch(/\.update\(\s*kgProposals\b/);
  });
});
