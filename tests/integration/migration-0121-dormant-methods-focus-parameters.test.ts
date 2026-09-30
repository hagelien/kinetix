/**
 * Migration 0121 — clearing a dormant `parameters` array off a `methods` focus.
 *
 * `agent_focus_config.parameters` was documented as "…for mode='parameters';
 * empty otherwise", but nothing enforced it: `PUT /api/agent-focus` stored
 * whichever arrays the request carried, and the admin form always submitted its
 * whole `parameters` state regardless of the selected mode. A config switched
 * from `parameters` to `methods` therefore kept the old selection, inert,
 * because `resolveFocusNarrowing` returned `parameters: null` for `methods`.
 *
 * Composing the two axes turns that inert array into an ACTIVE filter the
 * moment it deploys — a method-focused agent would silently stop working every
 * parameter outside a set nobody chose for this purpose, and a quieter queue is
 * the only symptom. This is the regression test for that: it seeds the exact
 * pre-deploy row and asserts the shipped statement disarms it.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (against an empty database) leaves nothing to observe. The real statement is
 * pulled out of the .sql file and re-run against seeded rows — the same
 * approach as the 0078/0087/0098 tests, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { agentFocusConfig } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';

let db: IntegrationDb;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0121_clear_dormant_methods_focus_parameters.sql',
);

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !/^(--[^\n]*\n?)*$/.test(chunk));
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

async function seedConfig(
  mode: string,
  parameters: string[],
  methodIds: number[] = [],
): Promise<void> {
  await db.insert(agentFocusConfig).values({
    id: 1,
    mode,
    parameters: parameters as never,
    methodIds: methodIds as never,
  });
}

async function storedParameters(): Promise<string[]> {
  const [row] = await db
    .select({ parameters: agentFocusConfig.parameters })
    .from(agentFocusConfig)
    .where(eq(agentFocusConfig.id, 1))
    .limit(1);
  return (row?.parameters ?? []) as string[];
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

describe('migration 0121', () => {
  it('clears a parameters array left on a methods-mode config', async () => {
    // The pre-deploy shape: an admin scoped to two parameters, then switched
    // the same config to a method focus. Before composition this changed
    // nothing; after it, it would narrow the agent to these two alone.
    await seedConfig('methods', ['halfLife', 'clearance'], [9001]);

    await runMigration();

    expect(await storedParameters()).toEqual([]);
  });

  it('leaves the methods themselves alone', async () => {
    // Only the dormant axis is disarmed — the focus an admin actually set
    // survives, so the agent keeps working the panel it was pointed at.
    await seedConfig('methods', ['halfLife'], [9001, 9002]);

    await runMigration();

    const [row] = await db
      .select({
        mode: agentFocusConfig.mode,
        methodIds: agentFocusConfig.methodIds,
      })
      .from(agentFocusConfig)
      .where(eq(agentFocusConfig.id, 1))
      .limit(1);
    expect(row?.mode).toBe('methods');
    expect(row?.methodIds).toEqual([9001, 9002]);
  });

  it('never touches a parameters-mode config, where the array IS the instruction', async () => {
    await seedConfig('parameters', ['dispositionModel', 'halfLife']);

    await runMigration();

    expect(await storedParameters()).toEqual([
      'dispositionModel',
      'halfLife',
    ]);
  });

  it('leaves a pages-mode array alone, since that mode still ignores it', async () => {
    await seedConfig('pages', ['halfLife']);

    await runMigration();

    expect(await storedParameters()).toEqual(['halfLife']);
  });

  it('is a no-op on a methods config that already has no parameters', async () => {
    await seedConfig('methods', [], [9001]);

    await runMigration();

    expect(await storedParameters()).toEqual([]);
  });

  it('changes nothing on a second pass', async () => {
    // Re-running a migration must be free: the statement selects on a
    // non-empty array and writes an empty one, so nothing matches twice.
    await seedConfig('methods', ['halfLife'], [9001]);

    await runMigration();
    const afterFirst = await storedParameters();
    await runMigration();

    expect(await storedParameters()).toEqual(afterFirst);
    expect(afterFirst).toEqual([]);
  });
});
