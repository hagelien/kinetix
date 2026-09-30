import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { citations, siteSettings } from '../../db/schema.js';
import {
  applySiteSettings,
  getSiteSettingsMatrix,
  isReferenceGateEnabled,
  loadSiteSettings,
  resetSiteSettingsForTests,
  UnknownSiteSettingError,
} from '../../api/_lib/site-settings-store.js';
import {
  assertReferencesJudged,
  assertReferencesJudgedForActor,
} from '../../api/_lib/pending-edits-helpers.js';
import {
  SETTING,
  SITE_SETTING_DEFAULTS,
} from '../../src/lib/siteSettings.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

const GATE = SETTING['referenceGate.blockUnreviewedCitations'];

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  resetSiteSettingsForTests();
});

/** A resolvable (non-freetext) source with no paper review at all. */
async function seedUnreviewedCitation(): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type: 'doi', identifier: '10.1000/unreviewed' })
    .returning({ id: citations.id });
  return row!.id;
}

describe('site settings over real SQL', () => {
  it('starts empty, so every switch answers with its shipped default', async () => {
    expect(await db.select().from(siteSettings)).toHaveLength(0);
    expect(await loadSiteSettings()).toEqual(SITE_SETTING_DEFAULTS);
    expect(await isReferenceGateEnabled()).toBe(true);
  });

  it('stores a deviation and the change takes effect on the next read', async () => {
    const actorId = await seedUser(db);

    await applySiteSettings({ [GATE]: false }, actorId);

    expect(await isReferenceGateEnabled()).toBe(false);
    const stored = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, GATE));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ value: false, updatedBy: actorId });
  });

  it('clears the row when a switch is set back to its default', async () => {
    const actorId = await seedUser(db);

    await applySiteSettings({ [GATE]: false }, actorId);
    expect(await db.select().from(siteSettings)).toHaveLength(1);

    await applySiteSettings({ [GATE]: true }, actorId);

    // Pruned rather than stored, so a default that moves in a later release
    // reaches an admin who once toggled this back and forth.
    expect(await db.select().from(siteSettings)).toHaveLength(0);
    expect(await isReferenceGateEnabled()).toBe(true);
  });

  it('refuses an id the registry does not know and writes nothing', async () => {
    const actorId = await seedUser(db);

    await expect(
      applySiteSettings({ 'gone.away': false }, actorId),
    ).rejects.toBeInstanceOf(UnknownSiteSettingError);
    expect(await db.select().from(siteSettings)).toHaveLength(0);
  });

  it('ignores a stored row whose key the registry no longer knows', async () => {
    const actorId = await seedUser(db);
    await db.insert(siteSettings).values({
      key: 'setting.removed.in.a.later.release',
      value: false,
      updatedBy: actorId,
    });

    expect(await loadSiteSettings()).toEqual(SITE_SETTING_DEFAULTS);
  });

  it('reports provenance for a changed switch in the admin view', async () => {
    const actorId = await seedUser(db);

    const before = await getSiteSettingsMatrix();
    expect(before.rows.find((r) => r.id === GATE)).toMatchObject({
      value: true,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    });

    await applySiteSettings({ [GATE]: false }, actorId);

    const after = await getSiteSettingsMatrix();
    const row = after.rows.find((r) => r.id === GATE);
    expect(row).toMatchObject({ value: false, isDefault: false });
    expect(row?.updatedBy?.id).toBe(actorId);
    expect(row?.updatedAt).toBeTruthy();
  });
});

/**
 * Only the *off* direction is exercised end-to-end here; the blocking path
 * stays covered by the unit suite (`tests/api/reference-gate.test.ts`) and,
 * inside a pool transaction, by `tests/integration/reference-gate-pool-
 * transaction.test.ts` (#1356). What this file proves is the part that is new
 * and cannot be mocked convincingly: that a row written to `site_settings`
 * really does reach the gate.
 */
describe('the agent reference gate follows the switch', () => {
  it('lets an unreviewed resolvable source through once blocking is off', async () => {
    const actorId = await seedUser(db);
    const citationId = await seedUnreviewedCitation();

    await applySiteSettings({ [GATE]: false }, actorId);

    // No review of any kind exists for this DOI — the strictest rejection the
    // gate has. It must pass, and without reaching the underlying queries.
    await expect(
      assertReferencesJudgedForActor([citationId], actorId),
    ).resolves.toBeUndefined();
  });

  it('leaves the bare gate — the learning-unit path — unconditional', async () => {
    const actorId = await seedUser(db);
    const citationId = await seedUnreviewedCitation();

    await applySiteSettings({ [GATE]: false }, actorId);

    // The switch must not reach `assertReferencesJudged`. Proving that here
    // means proving it still runs its lookups, which PGlite cannot serve —
    // so the assertion is "it did NOT short-circuit to a pass".
    await expect(
      assertReferencesJudged([citationId]),
    ).rejects.toBeInstanceOf(Error);
  });

  it('re-arms the moment the switch goes back on', async () => {
    const actorId = await seedUser(db);
    const citationId = await seedUnreviewedCitation();

    await applySiteSettings({ [GATE]: false }, actorId);
    await expect(
      assertReferencesJudgedForActor([citationId], actorId),
    ).resolves.toBeUndefined();

    await applySiteSettings({ [GATE]: true }, actorId);

    // The write invalidates the cache, so the next check sees the new value
    // without waiting out the TTL.
    expect(await isReferenceGateEnabled()).toBe(true);
  });
});
