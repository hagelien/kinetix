/**
 * §20 stage 1 — the current UI keeps reading the current endpoint shapes.
 *
 * > Current UI reads current endpoint shapes. Backend may derive them from
 * > legacy or generic state.
 *
 * `tests/governance/assurance/read-cutover.test.ts` proves the *service*
 * returns `{ level, disputed }` from either source. That is one layer below the
 * promise §20 actually makes, which is about what comes out of the HTTP
 * response the React app parses — and the two can diverge without anyone
 * noticing: a key ordering change, a number arriving as a string, an added
 * field. So this drives `api/verification-levels.ts` end to end and compares
 * the **serialised body**, byte for byte, under `legacy_only` and under
 * `generic_read`.
 *
 * Byte comparison rather than `toEqual` is the point. `toEqual` would pass on
 * reordered keys, and reordered keys are exactly what a rewritten derivation
 * produces. The React client does not care about key order — but a snapshot
 * test, a cached response, or an ETag does, and "identical" should mean
 * identical.
 *
 * The comparison is only worth anything if the second call really went through
 * the generic path, so every case asserts the read-fallback counter stayed at
 * zero. Without that, an unmirrored target would fall back to the legacy
 * calculation and produce a byte-identical body for the least interesting
 * reason there is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentVerifications,
  agents,
  drugParameterRevisions,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../../db/schema.js';
import verificationLevelsHandler from '../../../api/verification-levels.js';
import {
  FORCE_LEGACY_ENV,
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import {
  mirrorAssessment,
  mirrorProposalVersion,
} from '../../../api/_lib/knowledge-governance/mirror.js';
import {
  readMetricTotal,
  resetMetricsForTests,
} from '../../../api/_lib/knowledge-governance/metrics.js';
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
import { seedDrug, seedUser } from '../../integration/setup/seed.js';

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
  delete process.env[FORCE_LEGACY_ENV];
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  resetMetricsForTests();
  delete process.env[FORCE_LEGACY_ENV];
  // The endpoint is world-readable for a drug and for a published page; the
  // mock still has to resolve, so it answers "nobody".
  getUserFromRequestMock.mockResolvedValue(null);
});

async function get(url: string): Promise<ResponseState> {
  const { res, state } = createResponse();
  await (verificationLevelsHandler as unknown as Handler)(
    jsonRequest('GET', url, {}),
    res,
  );
  return state;
}

interface Verifier {
  userId: number;
  agentId: number;
}

async function seedVerifiers(): Promise<Verifier[]> {
  const out: Verifier[] = [];
  for (const [i, tier] of ['flagship', 'mid'].entries()) {
    const userId = await seedUser(db, {
      email: `verifier${i}@example.com`,
      username: `verifier-${i}`,
      role: 'contributor',
    });
    const [agent] = await db
      .insert(agents)
      .values({
        userId,
        name: `verifier-${i}`,
        slug: `verifier-${i}`,
        status: 'active',
        modelTier: tier,
      })
      .returning({ id: agents.id });
    out.push({ userId, agentId: agent!.id });
  }
  return out;
}

/**
 * Record a verdict and mirror it, so the generic side is complete.
 *
 * The target type is advanced to `shadow` first: the mirror is gated on the
 * mode and writes nothing under `legacy_only`, so mirroring before advancing
 * would leave the generic side empty and every comparison below would be
 * comparing the fallback to itself.
 */
async function verdictAndMirror(args: {
  targetType: 'drug_parameter_revision' | 'wiki_revision';
  targetId: number;
  verifier: Verifier;
  tier: string;
  verdict?: 'approve' | 'dispute';
}): Promise<void> {
  await setMigrationMode({
    targetType: args.targetType,
    mode: 'shadow',
    updatedBy: null,
  });
  invalidateMigrationStateCache();
  const verdict = args.verdict ?? 'approve';
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId: args.verifier.agentId,
      targetType: args.targetType,
      targetId: args.targetId,
      verdict,
      verifierTier: args.tier,
      rationaleMd: verdict === 'approve' ? '' : 'Kilden dekker ikke påstanden.',
    })
    .returning({ id: agentVerifications.id });
  await mirrorProposalVersion({
    targetType: args.targetType,
    targetId: args.targetId,
  });
  await mirrorAssessment({
    targetType: args.targetType,
    targetId: args.targetId,
    legacyVerificationId: row!.id,
    actorRef: `user:${args.verifier.userId}`,
    verdict,
  });
}

async function advance(
  targetType: string,
  mode: 'legacy_only' | 'shadow' | 'generic_read',
): Promise<void> {
  await setMigrationMode({ targetType, mode, updatedBy: null });
  invalidateMigrationStateCache();
}

/**
 * Fetch the same URL under both authorities and hand back the two bodies.
 *
 * The legacy read happens first, before anything is advanced past `shadow`, so
 * it is the answer today's production serves.
 */
async function bothAuthorities(args: {
  url: string;
  targetType: string;
}): Promise<{ legacy: ResponseState; generic: ResponseState }> {
  const legacy = await get(args.url);
  resetMetricsForTests();
  await advance(args.targetType, 'generic_read');
  const generic = await get(args.url);
  return { legacy, generic };
}

function expectServedGenerically(): void {
  // A fallback would produce a byte-identical body for the least interesting
  // reason available, so the counter is what makes the comparison mean
  // something.
  expect(readMetricTotal('kg_read_fallback_total')).toBe(0);
}

describe('GET ?drugId=N', () => {
  async function seedParameterWorld(): Promise<{
    drugId: number;
    verifiers: Verifier[];
    revisionId: number;
  }> {
    const authorId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const verifiers = await seedVerifiers();
    const drugId = await seedDrug(db, {
      slug: 'diazepam',
      names: { nb: 'Diazepam', en: 'Diazepam' },
    });
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
    return { drugId, verifiers, revisionId: revision!.id };
  }

  it('serves a byte-identical body from either source', async () => {
    const world = await seedParameterWorld();
    for (const [i, verifier] of world.verifiers.entries()) {
      await verdictAndMirror({
        targetType: 'drug_parameter_revision',
        targetId: world.revisionId,
        verifier,
        tier: i === 0 ? 'flagship' : 'mid',
      });
    }

    const { legacy, generic } = await bothAuthorities({
      url: `/api/verification-levels?drugId=${world.drugId}`,
      targetType: 'drug_parameter_revision',
    });

    expect(legacy.statusCode).toBe(200);
    expect(generic.statusCode).toBe(200);
    expect(generic.body).toBe(legacy.body);
    expectServedGenerically();

    // And the body is the shape the client's types describe, rather than two
    // matching empties: a level map keyed by parameter id.
    const parsed = JSON.parse(generic.body) as {
      levels: Record<string, { level: number; disputed: boolean }>;
    };
    expect(parsed.levels.halfLife).toBeDefined();
    expect(typeof parsed.levels.halfLife!.level).toBe('number');
    expect(typeof parsed.levels.halfLife!.disputed).toBe('boolean');
    expect(parsed.levels.halfLife!.level).toBeGreaterThan(0);
  });

  it('serves a byte-identical body when a verdict disputes the value', async () => {
    // The disputed flag travels beside the level rather than lowering it, and
    // it is a boolean the sidebar branches on — worth its own comparison.
    const world = await seedParameterWorld();
    await verdictAndMirror({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verifier: world.verifiers[0]!,
      tier: 'flagship',
    });
    await verdictAndMirror({
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verifier: world.verifiers[1]!,
      tier: 'mid',
      verdict: 'dispute',
    });

    const { legacy, generic } = await bothAuthorities({
      url: `/api/verification-levels?drugId=${world.drugId}`,
      targetType: 'drug_parameter_revision',
    });
    expect(generic.body).toBe(legacy.body);
    expectServedGenerically();
    const parsed = JSON.parse(generic.body) as {
      levels: Record<string, { disputed: boolean }>;
    };
    expect(parsed.levels.halfLife!.disputed).toBe(true);
  });

  it('serves the legacy body unchanged when nothing was mirrored', async () => {
    // The fallback case, asserted at the endpoint rather than the service: a
    // target the mirror never reached must still produce today's response.
    const world = await seedParameterWorld();
    await db.insert(agentVerifications).values({
      agentId: world.verifiers[0]!.agentId,
      targetType: 'drug_parameter_revision',
      targetId: world.revisionId,
      verdict: 'approve',
      verifierTier: 'flagship',
    });

    const legacy = await get(`/api/verification-levels?drugId=${world.drugId}`);
    resetMetricsForTests();
    await advance('drug_parameter_revision', 'generic_read');
    const generic = await get(`/api/verification-levels?drugId=${world.drugId}`);

    expect(generic.body).toBe(legacy.body);
    // …and it fell back to get there, which is the inverse of every case above
    // and proves the counter is capable of moving.
    expect(readMetricTotal('kg_read_fallback_total')).toBeGreaterThan(0);
  });
});

describe('GET ?wikiPageId=N', () => {
  async function seedFactWorld(): Promise<{
    pageId: number;
    revisionId: number;
    verifiers: Verifier[];
  }> {
    const authorId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const verifiers = await seedVerifiers();
    const content = {
      version: 2,
      sections: {
        pk: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'fact',
                attrs: { factId: 'fact-halflife-1', referenceIds: [] },
                content: [
                  { type: 'text', text: 'Halveringstiden er 30 timer.' },
                ],
              },
            ],
          },
        },
      },
    };
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        content,
        status: 'published',
        createdBy: authorId,
        updatedBy: authorId,
      })
      .returning({ id: wikiPages.id });
    // The revision has to be reachable the way the endpoint reaches it: it
    // resolves a factId by joining `wiki_revisions` to the `pending_edits` row
    // that produced it and reading the factId off the proposed node. A revision
    // with a factId column set and no originating edit is invisible to that
    // query — which is how the first version of this test compared two empty
    // level maps and called them identical.
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
        submittedBy: authorId,
        status: 'approved',
      })
      .returning({ id: pendingEdits.id });
    const [revision] = await db
      .insert(wikiRevisions)
      .values({
        pageId: page!.id,
        content,
        createdBy: authorId,
        pendingEditId: edit!.id,
      })
      .returning({ id: wikiRevisions.id });
    return { pageId: page!.id, revisionId: revision!.id, verifiers };
  }

  it('serves a byte-identical body from either source', async () => {
    const world = await seedFactWorld();
    for (const [i, verifier] of world.verifiers.entries()) {
      await verdictAndMirror({
        targetType: 'wiki_revision',
        targetId: world.revisionId,
        verifier,
        tier: i === 0 ? 'flagship' : 'mid',
      });
    }

    const { legacy, generic } = await bothAuthorities({
      url: `/api/verification-levels?wikiPageId=${world.pageId}`,
      targetType: 'wiki_revision',
    });

    expect(legacy.statusCode).toBe(200);
    expect(generic.body).toBe(legacy.body);
    expectServedGenerically();

    const parsed = JSON.parse(generic.body) as {
      levels: Record<string, { level: number; disputed: boolean }>;
    };
    expect(parsed.levels['fact-halflife-1']).toBeDefined();
    expect(parsed.levels['fact-halflife-1']!.level).toBeGreaterThan(0);
  });
});

describe('the response contract itself', () => {
  it('answers with exactly { levels }, and each entry with exactly { level, disputed }', async () => {
    // §20 stage 2 offers to *enrich* the review UI with hold reasons,
    // independent reviewer counts and capability coverage. Stage 1 is that
    // nothing arrives before somebody decides to send it: an extra key on this
    // response would reach every monograph sidebar in production.
    const authorId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const verifiers = await seedVerifiers();
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
    await verdictAndMirror({
      targetType: 'drug_parameter_revision',
      targetId: revision!.id,
      verifier: verifiers[0]!,
      tier: 'flagship',
    });
    await advance('drug_parameter_revision', 'generic_read');

    const served = await get(`/api/verification-levels?drugId=${drugId}`);
    const parsed = JSON.parse(served.body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['levels']);
    for (const entry of Object.values(
      parsed.levels as Record<string, Record<string, unknown>>,
    )) {
      expect(Object.keys(entry).sort()).toEqual(['disputed', 'level']);
    }
  });

  it('is unchanged by the force-legacy switch, which the UI never sees', async () => {
    const authorId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'contributor',
    });
    const verifiers = await seedVerifiers();
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
    await verdictAndMirror({
      targetType: 'drug_parameter_revision',
      targetId: revision!.id,
      verifier: verifiers[0]!,
      tier: 'flagship',
    });
    await advance('drug_parameter_revision', 'generic_read');

    const before = await get(`/api/verification-levels?drugId=${drugId}`);
    process.env[FORCE_LEGACY_ENV] = '1';
    invalidateMigrationStateCache();
    const after = await get(`/api/verification-levels?drugId=${drugId}`);

    // The operator lever exists for an incident. A reader refreshing the page
    // mid-incident must not see the badge change.
    expect(after.body).toBe(before.body);
  });
});
