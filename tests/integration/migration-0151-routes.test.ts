/**
 * Migration 0151 — the subcutaneous, transdermal and buccal routes (#81).
 *
 * Two things to hold: the widened CHECK admits the new routes (and still refuses
 * an unknown one), and existing entries that may belong under a new route are
 * QUEUED for a reviewer rather than rewritten. The harness truncates every table
 * between tests, so the migration's own pass leaves nothing to observe; the real
 * statements are pulled out of the .sql file and re-run against seeded rows — the
 * same approach as the 0098 and 0104 tests, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { parameterEntries, parameterPriorityFlags } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';
import {
  DRUG_PARAMETER_IDS,
  parameterIsRouteOptional,
  parameterIsRouteScoped,
} from '../../src/lib/drugParameters.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0151_subcutaneous_transdermal_buccal_routes.sql',
);
const SQL = readFileSync(MIGRATION, 'utf8');

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return SQL.split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

async function seedEntry(values: {
  parameter: string;
  route?: string | null;
  comments?: string;
  observationContext?: string;
}): Promise<number> {
  const [row] = await db
    .insert(parameterEntries)
    .values({
      drugId,
      parameter: values.parameter,
      route: values.route ?? null,
      median: '1',
      unit: values.parameter === 'tmax' ? 'h' : 'fraction',
      comments: values.comments,
      observationContext: values.observationContext,
      createdBy: userId,
    })
    .returning({ id: parameterEntries.id });
  return row!.id;
}

async function flags() {
  return db
    .select({
      parameter: parameterPriorityFlags.parameter,
      status: parameterPriorityFlags.status,
      note: parameterPriorityFlags.note,
    })
    .from(parameterPriorityFlags)
    .where(eq(parameterPriorityFlags.drugId, drugId))
    .orderBy(asc(parameterPriorityFlags.parameter));
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  drugId = await seedDrug(db);
});

describe('migration 0151 — route CHECK', () => {
  it.each(['subcutaneous', 'transdermal', 'buccal'])('admits route = %s', async (route) => {
    await expect(seedEntry({ parameter: 'bioavailability', route })).resolves.toBeGreaterThan(0);
  });

  it('still refuses a route outside the vocabulary', async () => {
    await expect(seedEntry({ parameter: 'bioavailability', route: 'intrathecal' })).rejects.toThrow();
  });
});

describe('migration 0151 — re-tag queue', () => {
  it('queues `other` entries and prose-tagged route-less ones, without rewriting them', async () => {
    const other = await seedEntry({ parameter: 'bioavailability', route: 'other' });
    const patch = await seedEntry({ parameter: 'tmax', comments: 'Fentanyl depotplaster, steady state.' });
    const sc = await seedEntry({
      parameter: 'tmax',
      observationContext: 'Single SC injection of a weekly depot.',
    });
    // Not candidates: a drug-level parameter cannot carry a route at all, and an
    // entry that already has a real route is not re-tagged by a prose match.
    await seedEntry({ parameter: 'halfLife', comments: 'Etter transdermal tilførsel.' });
    await seedEntry({ parameter: 'tmax', route: 'oral', comments: 'Sammenlignet med bukkal.' });
    // A route-less entry with no route in its prose is a drug-level value, left alone.
    await seedEntry({ parameter: 'bioavailability', comments: 'Peroral tablett.' });

    await runMigration();

    const queued = await flags();
    expect(queued.map((f) => f.parameter)).toEqual(['bioavailability', 'tmax']);
    expect(queued.every((f) => f.status === 'active')).toBe(true);
    expect(queued[0]!.note).toContain(`#${other}`);
    expect(queued[1]!.note).toContain(`#${patch}, #${sc}`);
    // Norwegian, with its own letters (AGENTS.md: stored content a migration writes).
    expect(queued[0]!.note).toMatch(/^Administrasjonsvei til vurdering \(migrering 0151\): kildeoppføring/);

    // Nothing was rewritten: the routes stay exactly as they were.
    const routes = await db
      .select({ id: parameterEntries.id, route: parameterEntries.route })
      .from(parameterEntries)
      .orderBy(asc(parameterEntries.id));
    expect(routes.find((r) => r.id === other)?.route).toBe('other');
    expect(routes.find((r) => r.id === patch)?.route).toBeNull();
  });

  it('appends to an active flag a moderator already raised, once', async () => {
    const other = await seedEntry({ parameter: 'bioavailability', route: 'other' });
    await db.insert(parameterPriorityFlags).values({
      drugId,
      parameter: 'bioavailability',
      status: 'active',
      note: 'Sjekk F mot preparatomtalen.',
    });

    await runMigration();
    await runMigration();

    const queued = await flags();
    expect(queued).toHaveLength(1);
    const note = queued[0]!.note!;
    expect(note.startsWith('Sjekk F mot preparatomtalen.\n\nAdministrasjonsvei')).toBe(true);
    expect(note).toContain(`#${other}`);
    expect(note.split('(migrering 0151)')).toHaveLength(2);
  });

  it('adds nothing on a re-run', async () => {
    await seedEntry({ parameter: 'ka', route: 'other' });
    await runMigration();
    await runMigration();
    expect(await flags()).toHaveLength(1);
  });

  it('lists the route-capable parameters the registry declared when it shipped', () => {
    const lists = [...SQL.matchAll(/pe\."parameter" IN \(([^)]*)\)/g)].map((m) =>
      [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!).sort(),
    );
    // A migration is frozen once it ships, so it can only list what existed then. A route-capable
    // parameter registered AFTER 0151 had no entries for it to queue, and is named here instead of
    // being added to the applied SQL — so a parameter that existed at 0151 and was left out of its
    // list still fails this test.
    const registeredAfter0151 = new Set<string>([
      // #83: the absorption-phase structure parameters (route-scoped, new rows only).
      'firstOrderFraction',
      'zeroOrderDuration',
      'absorptionLag',
    ]);
    const registry = DRUG_PARAMETER_IDS.filter(
      (id) =>
        (parameterIsRouteScoped(id) || parameterIsRouteOptional(id)) &&
        !registeredAfter0151.has(id),
    ).sort();
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual(registry);
    // Every exemption must still be a route-capable registry parameter, so the list cannot go stale.
    for (const id of registeredAfter0151) {
      expect(
        DRUG_PARAMETER_IDS.some(
          (p) => p === id && (parameterIsRouteScoped(p) || parameterIsRouteOptional(p)),
        ),
      ).toBe(true);
    }
  });
});
