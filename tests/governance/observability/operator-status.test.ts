/**
 * Step A of the continuation plan: the operator's read-only status.
 *
 * The module composes reports that already have their own tests. What is
 * worth proving here is the composition's two promises: that it reads the
 * runtime facts rather than a plan document — the modes it shows are the ones
 * the request path resolves — and that reading them leaves no footprint. A
 * status command that created a space row, or could advance a target, would
 * be a status command an operator could not run without thinking first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { agents, pendingEdits, wikiPages } from '../../../db/schema.js';
import { kgMigrationState, kgSpaces } from '../../../db/governance-schema.js';
import {
  describeOperatorStatus,
  gatherOperatorStatus,
  operatorStatusKeys,
} from '../../../api/_lib/knowledge-governance/operator-status.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
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
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
});

async function countRows(table: typeof kgSpaces | typeof kgMigrationState): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row!.n;
}

/** A verifier agent and one reviewable wiki_fact edit by someone else. */
async function seedQueueWorld(): Promise<{ verifierAgentId: number }> {
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
  const [verifier] = await db
    .insert(agents)
    .values({ userId: verifierUserId, name: 'verifier', slug: 'verifier', status: 'active' })
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
        attrs: { factId: 'fact-1', referenceIds: [] },
        content: [{ type: 'text', text: 'Halveringstiden er 30 timer.' }],
      },
      submittedBy: authorId,
      status: 'pending',
    })
    .returning({ id: pendingEdits.id });
  expect(edit).toBeDefined();
  return { verifierAgentId: verifier!.id };
}

describe('it reports runtime facts', () => {
  it('on an untouched database, every key resolves legacy_only and nothing is authoritative', async () => {
    const status = await gatherOperatorStatus({ db });
    expect(status.spaceExists).toBe(false);
    expect(status.storedModes).toEqual([]);
    expect(status.resolvedModes.map((m) => m.key)).toEqual(operatorStatusKeys());
    for (const entry of status.resolvedModes) {
      expect(entry.mode, entry.key).toBe('legacy_only');
    }
    expect(status.applyAuthority.map((a) => a.authoritative)).not.toContain(true);
    expect(status.readiness.ready).toBe(false);
    expect(status.definitionOfDone.isComplete).toBe(false);
  });

  it('shows the stored mode the request path resolves, coarse and fine', async () => {
    await setMigrationMode({ targetType: 'pending_edit', mode: 'shadow', updatedBy: null });
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'generic_read',
      updatedBy: null,
    });
    const status = await gatherOperatorStatus({ db });

    expect(status.spaceExists).toBe(true);
    expect(status.storedModes.map((m) => [m.targetType, m.mode])).toEqual([
      ['pending_edit', 'shadow'],
      ['pending_edit:wiki_fact', 'generic_read'],
    ]);
    const resolved = Object.fromEntries(status.resolvedModes.map((m) => [m.key, m.mode]));
    expect(resolved['pending_edit']).toBe('shadow');
    expect(resolved['pending_edit:wiki_fact']).toBe('generic_read');
    expect(resolved['wiki_revision']).toBe('legacy_only');
    expect(status.applyAuthority).toEqual([
      { authoritative: false, key: 'pending_edit:wiki_fact', withheld: 'mode' },
    ]);
    expect(status.readiness.dossier.currentMode).toBe('generic_read');
  });

  it('carries the parity report and decision counts once a space exists', async () => {
    await setMigrationMode({ targetType: 'pending_edit', mode: 'shadow', updatedBy: null });
    const status = await gatherOperatorStatus({ db });
    expect(status.parity).not.toBeNull();
    expect(status.parity!.modes).toEqual([{ targetType: 'pending_edit', mode: 'shadow' }]);
    expect(status.shadowDecisionsByMode).toEqual({});
    expect(status.parityUnavailableReason).toBeNull();
  });

  it('runs the queue comparison only when asked, against the served batch', async () => {
    const { verifierAgentId } = await seedQueueWorld();

    const silent = await gatherOperatorStatus({ db });
    expect(silent.queueParity).toBeNull();

    const status = await gatherOperatorStatus({
      db,
      queueAgents: [verifierAgentId],
      queueMinAgeMinutes: 0,
    });
    expect(status.queueParity).toHaveLength(1);
    const [obs] = status.queueParity!;
    expect(obs!.agentId).toBe(verifierAgentId);
    expect(obs!.legacyServed).toBe(1);
    expect(obs!.genericSelected).toBe(1);
    expect(obs!.comparison.legacyOnly).toEqual([]);
    expect(obs!.comparison.genericOnly).toEqual([]);
    expect(obs!.comparison.packetMismatches).toEqual([]);

    // 'all' reaches the same agent through the route's own active-agent gate.
    const everyone = await gatherOperatorStatus({
      db,
      queueAgents: 'all',
      queueMinAgeMinutes: 0,
    });
    expect(everyone.queueParity!.map((o) => o.agentId)).toEqual([verifierAgentId]);
    expect(describeOperatorStatus(everyone)).toContain('kg queue: identical');
    expect(everyone.queueParity![0]!.comparison.legacyOnly).toEqual([]);
  });

  it('clamps the compared batch to what the endpoint will serve', async () => {
    // The comparison's promise is "against the batch the route serves", and
    // the route clamps every request to MAX_LIMIT. Comparing a larger batch
    // would report differences no agent could ever observe.
    const { verifierAgentId } = await seedQueueWorld();
    const status = await gatherOperatorStatus({
      db,
      queueAgents: [verifierAgentId],
      queueLimit: 5_000,
      queueMinAgeMinutes: 0,
    });
    expect(status.queueParity![0]!.limit).toBe(100);
  });

  it('renders every section, including the ones it could not produce', async () => {
    const text = describeOperatorStatus(await gatherOperatorStatus({ db }));
    expect(text).toContain('stored migration state');
    expect(text).toContain('resolved at runtime');
    expect(text).toContain('apply authority');
    expect(text).toContain("dossier for 'wiki_fact'");
    expect(text).toContain('parity report: unavailable');
    expect(text).toContain('queue parity');
    expect(text).toContain('not run');
    expect(text).toContain('§26 definition of done');
  });
});

describe('it leaves no footprint', () => {
  it('creates no space row and no migration-state row on an untouched database', async () => {
    expect(await countRows(kgSpaces)).toBe(0);
    const status = await gatherOperatorStatus({ db, survey: true });
    expect(status.parity).toBeNull();
    expect(status.parityUnavailableReason).toMatch(/read-only diagnostic/);
    expect(await countRows(kgSpaces)).toBe(0);
    expect(await countRows(kgMigrationState)).toBe(0);
  });

  it('changes nothing a second read would notice', async () => {
    await setMigrationMode({ targetType: 'pending_edit', mode: 'compare', updatedBy: null });
    const before = await gatherOperatorStatus({ db, now: new Date('2026-09-05T00:00:00Z') });
    const after = await gatherOperatorStatus({ db, now: new Date('2026-09-05T00:00:00Z') });
    expect(after.storedModes).toEqual(before.storedModes);
    expect(after.resolvedModes).toEqual(before.resolvedModes);
    expect(after.readiness).toEqual(before.readiness);
    expect(await countRows(kgMigrationState)).toBe(1);
  });

  it('cannot advance a target: the module and the CLI import no writer', () => {
    // Asserted over source rather than trusted from the header comment. The
    // comment can say "read-only" forever; this notices the day it stops
    // being true.
    const root = path.resolve(__dirname, '../../..');
    for (const file of [
      'api/_lib/knowledge-governance/operator-status.ts',
      'scripts/governance-status.ts',
    ]) {
      const code = fs
        .readFileSync(path.join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const forbidden of [
        'setMigrationMode',
        '.insert(',
        '.update(',
        '.delete(',
        'ensureKinetixSpace',
        'ensureSpace',
        'recordAuditEvent',
      ]) {
        expect(code, `${file} references ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
