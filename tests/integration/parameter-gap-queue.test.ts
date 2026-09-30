/**
 * The maintenance agent's core-coverage queue
 * (`GET /api/agent-sweep?mode=parameter_gaps`) over real SQL.
 *
 * This exists because of a specific production failure: the routine reported
 * "benzoylecgonine bioavailability remains unset" on every hourly cycle for
 * weeks. The queue was a plain "no row in drug_parameters" scan, so a pair that
 * could never be filled — benzoylecgonine is a cocaine metabolite nobody
 * administers, and absolute bioavailability needs an administered dose — stayed
 * missing forever, and belonging to a screening panel sorted it to the very top.
 * Every cycle did the search, found nothing, and forgot.
 *
 * These tests execute the **exported** query text rather than a copy, so a
 * change that breaks the exclusions against the migrated schema fails here
 * rather than quietly resuming the loop in a scheduled run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  buildParameterGapsSql,
  buildSuppressedParameterGapsSql,
} from '../../api/agent-sweep.js';
import {
  resolveFocusNarrowing,
  type FocusNarrowing,
} from '../../api/agent-focus.js';
import {
  agentFocusConfig,
  analyticalMethodComponents,
  analyticalMethods,
  citations,
  drugEliminationRoutes,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterApplicability,
  drugParameters,
  drugReceptorTargets,
  drugs,
  parameterEntries,
  pendingEdits,
  verificationLog,
  wikiPages,
} from '../../db/schema.js';
import { ABSENT_RECHECK_DAYS } from '../../src/lib/parameterApplicability.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { classifySubstance } from '../../scripts/backfill-substance-classes.js';
import { seedBioEntity, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

interface GapRow {
  drug_id: number;
  slug: string;
  parameter: string;
  /**
   * Which fill test retires this pair: an aggregate value, a cited entry, the
   * relationship rows of a coverage area, or a dose-context source entry.
   */
  fill_kind: 'value' | 'declaration' | 'relation' | 'observation';
  in_method: boolean;
  substance_class: string;
}

function unwrap<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return r.rows ?? (result as T[]);
}

const NO_FOCUS: FocusNarrowing = { parameters: null, drugIds: null };

async function gaps(focus: FocusNarrowing = NO_FOCUS): Promise<GapRow[]> {
  return unwrap<GapRow>(await db.execute(sql.raw(buildParameterGapsSql(focus))));
}

async function suppressed(
  focus: FocusNarrowing = NO_FOCUS,
): Promise<Record<string, number>> {
  const rows = unwrap<{ reason: string; count: number }>(
    await db.execute(sql.raw(buildSuppressedParameterGapsSql(focus))),
  );
  return Object.fromEntries(rows.map((r) => [r.reason, Number(r.count)]));
}

/** Gap pairs as "slug:parameter", for readable assertions. */
async function gapPairs(focus: FocusNarrowing = NO_FOCUS): Promise<string[]> {
  return (await gaps(focus)).map((r) => `${r.slug}:${r.parameter}`);
}

/** Put a drug into an analytical method, the way a screening panel holds BZE. */
async function addToMethod(drugId: number, methodId = 9001): Promise<void> {
  await db
    .insert(analyticalMethods)
    .values({
      id: methodId,
      code: String(methodId),
      name: `${methodId}: test panel`,
    })
    .onConflictDoNothing();
  await db
    .insert(analyticalMethodComponents)
    .values({ methodId, drugId })
    .onConflictDoNothing();
}

async function logAbsent(
  drugId: number,
  parameter: string,
  daysAgo: number,
): Promise<void> {
  await db.insert(verificationLog).values({
    targetType: 'parameter',
    targetId: drugId,
    parameter,
    concordance: 'absent',
    outcome: 'commented_only',
    sourcesConsultedCount: 0,
    verifiedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
  });
}

/**
 * The production shape: benzoylecgonine, a metabolite, in a screening panel,
 * with none of its core parameters filled.
 */
async function seedBenzoylecgonine(): Promise<number> {
  const drugId = await seedDrug(db, {
    slug: 'benzoylecgonin',
    names: { nb: 'Benzoylecgonin', en: 'Benzoylecgonine' },
    pubchemCid: 448223,
    substanceClass: 'metabolite',
    popularityScore: 900,
  });
  await addToMethod(drugId);
  return drugId;
}

describe('parameter gap queue — the exclusions', () => {
  it('never offers bioavailability for a metabolite, however it is ranked', async () => {
    // The regression itself. Before the substance-class rule this pair was
    // row #1 of every cycle: in_method sorts ahead of popularity, and the
    // pair can never be satisfied.
    await seedBenzoylecgonine();

    const pairs = await gapPairs();
    expect(pairs).not.toContain('benzoylecgonin:bioavailability');
    // tmax is NOT excluded, deliberately: benzoylecgonine's time to peak is
    // measured after cocaine is dosed and is published. Only bioavailability
    // needs a reference dose of the analyte itself, and that is the pair the
    // routine was actually stuck on.
    expect(pairs).toContain('benzoylecgonin:tmax');
  });

  it('still offers the parameters a metabolite really does have', async () => {
    // The exclusion must be surgical. A metabolite has a half-life, a volume
    // of distribution and a molecular weight, and those are real work.
    await seedBenzoylecgonine();

    const pairs = await gapPairs();
    expect(pairs).toContain('benzoylecgonin:halfLife');
    expect(pairs).toContain('benzoylecgonin:volumeOfDistribution');
    expect(pairs).toContain('benzoylecgonin:molecularWeight');
    expect(pairs).toContain('benzoylecgonin:bloodPlasmaRatio');
  });

  it('keeps bioavailability in scope for an administered drug', async () => {
    await seedDrug(db, {
      slug: 'diazepam',
      names: { en: 'Diazepam' },
      popularityScore: 500,
    });

    expect(await gapPairs()).toContain('diazepam:bioavailability');
  });

  it('treats an unrecognised substance class as administered', async () => {
    // Mirrors normalizeSubstanceClass: a class this build does not know must
    // not silently hide gaps.
    await seedDrug(db, {
      slug: 'mystery',
      names: { en: 'Mystery' },
      substanceClass: 'prodrug',
    });

    expect(await gapPairs()).toContain('mystery:bioavailability');
  });

  it('drops a pair an editor marked not applicable', async () => {
    const userId = await seedUser(db, { email: 'ed@example.com', username: 'ed' });
    const drugId = await seedDrug(db, {
      slug: 'oddball',
      names: { en: 'Oddball' },
    });
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      reason: 'Not a defined quantity for this substance.',
      setBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('oddball:bloodPlasmaRatio');
    expect(pairs).toContain('oddball:halfLife');
  });

  it('suppresses a pair searched exhaustively inside the cooldown', async () => {
    const drugId = await seedDrug(db, {
      slug: 'searched',
      names: { en: 'Searched' },
    });
    await logAbsent(drugId, 'clearance', 10);

    expect(await gapPairs()).not.toContain('searched:clearance');
  });

  it('reopens the pair once the cooldown has elapsed', async () => {
    // A cooldown, not a retirement — "no literature today" is a claim with a
    // shelf life, unlike "no such quantity".
    const drugId = await seedDrug(db, {
      slug: 'stale',
      names: { en: 'Stale' },
    });
    await logAbsent(drugId, 'clearance', ABSENT_RECHECK_DAYS + 5);

    expect(await gapPairs()).toContain('stale:clearance');
  });

  it('does not let a non-absent verification suppress anything', async () => {
    const drugId = await seedDrug(db, {
      slug: 'weakly-sourced',
      names: { en: 'Weakly sourced' },
    });
    await db.insert(verificationLog).values({
      targetType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      concordance: 'weak',
      outcome: 'commented_only',
      sourcesConsultedCount: 1,
    });

    expect(await gapPairs()).toContain('weakly-sourced:clearance');
  });

  it('reopens a pair once a later verification found sources', async () => {
    // An absence is a claim about the literature on the day it was checked.
    // A later verification that DID find sources retires it — otherwise a
    // proposal that was rejected, withdrawn, or whose value was later cleared
    // leaves the pair hidden for the rest of the 180 days while the audit
    // trail says sources exist. Hiding a real gap is the failure this lane
    // exists to prevent; re-serving one costs a cycle.
    const drugId = await seedDrug(db, {
      slug: 'superseded',
      names: { en: 'Superseded' },
    });
    await logAbsent(drugId, 'clearance', 60);
    await db.insert(verificationLog).values({
      targetType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      concordance: 'moderate',
      outcome: 'submitted_pending',
      sourcesConsultedCount: 3,
      verifiedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });

    expect(await gapPairs()).toContain('superseded:clearance');
  });

  it('keeps the cooldown when the newer verification is another absence', async () => {
    // Two empty searches are not evidence that sources exist. Only a
    // non-absent verification supersedes.
    const drugId = await seedDrug(db, {
      slug: 'twice-empty',
      names: { en: 'Twice empty' },
    });
    await logAbsent(drugId, 'clearance', 60);
    await logAbsent(drugId, 'clearance', 5);

    expect(await gapPairs()).not.toContain('twice-empty:clearance');
  });

  it('keeps the cooldown when the evidence predates the absence', async () => {
    // Order matters, not mere presence: a search that came back empty *after*
    // an earlier partial finding is the newer claim about the literature.
    const drugId = await seedDrug(db, {
      slug: 'then-empty',
      names: { en: 'Then empty' },
    });
    await db.insert(verificationLog).values({
      targetType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      concordance: 'weak',
      outcome: 'commented_only',
      sourcesConsultedCount: 1,
      verifiedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });
    await logAbsent(drugId, 'clearance', 10);

    expect(await gapPairs()).not.toContain('then-empty:clearance');
  });

  it('drops a pair a pending monograph already proposes a value for', async () => {
    // The third proposal path. A monograph submitted for review against an
    // existing drug carries its parameter bag in proposed_meta and leaves
    // target_id and parameter NULL, so the equality that catches the other two
    // kinds cannot see it — and the queue hands the same gaps to the next
    // cycle while a reviewer is already looking at proposed values for them.
    const userId = await seedUser(db, {
      email: 'm@example.com',
      username: 'monographer',
    });
    const drugId = await seedDrug(db, {
      slug: 'monograph-queued',
      names: { en: 'Monograph queued' },
    });
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      proposedValue: { type: 'doc', content: [] } as never,
      proposedMeta: {
        title: 'Monograph queued',
        pageType: 'drug_monograph',
        drugCid: drugId,
        parameters: { halfLife: { min: 1, max: 2, unit: 'h' } },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('monograph-queued:halfLife');
    // Surgical: only the parameters the monograph actually proposes.
    expect(pairs).toContain('monograph-queued:clearance');
  });

  it('is not fooled by a pending monograph for a different drug', async () => {
    const userId = await seedUser(db, {
      email: 'm2@example.com',
      username: 'monographer2',
    });
    const mine = await seedDrug(db, {
      slug: 'mine',
      names: { en: 'Mine' },
    });
    const theirs = await seedDrug(db, {
      slug: 'theirs',
      names: { en: 'Theirs' },
    });
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      proposedValue: { type: 'doc', content: [] } as never,
      proposedMeta: {
        drugCid: theirs,
        parameters: { halfLife: { min: 1, max: 2, unit: 'h' } },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    expect(await gapPairs()).toContain('mine:halfLife');
    expect(mine).not.toBe(theirs);
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
  ])('ignores a monograph key whose value is %s', async (_label, value) => {
    // The UI sends untouched rows as null or {}, and validateParameterBag
    // drops both at approval — so those keys propose nothing and must not
    // suppress. Testing for key presence let a long-lived draft hide real
    // work it never intended to fill.
    const userId = await seedUser(db, {
      email: `m-${_label.replace(/\W/g, '')}@example.com`,
      username: `m-${_label.replace(/\W/g, '')}`,
    });
    const drugId = await seedDrug(db, {
      slug: 'untouched-row',
      names: { en: 'Untouched row' },
    });
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      proposedValue: { type: 'doc', content: [] } as never,
      proposedMeta: {
        drugCid: drugId,
        parameters: { halfLife: value },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    expect(await gapPairs()).toContain('untouched-row:halfLife');
  });

  it('ignores a pending monograph that proposes no parameters', async () => {
    // A topic page, or a monograph with no parameter bag, has no drugCid or no
    // `parameters` key. Neither may suppress anything, and a missing key must
    // not throw.
    const userId = await seedUser(db, {
      email: 'm3@example.com',
      username: 'monographer3',
    });
    const drugId = await seedDrug(db, {
      slug: 'prose-only',
      names: { en: 'Prose only' },
    });
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      proposedValue: { type: 'doc', content: [] } as never,
      proposedMeta: { drugCid: drugId, title: 'Prose only' } as never,
      status: 'pending',
      submittedBy: userId,
    });

    expect(await gapPairs()).toContain('prose-only:halfLife');
  });

  it('drops a pair with a pending param_entry create', async () => {
    // Until the entry is approved there is no drug_parameters row, so the pair
    // still looks like a gap — and the routine would duplicate research a
    // contributor has already submitted.
    const userId = await seedUser(db, {
      email: 'e@example.com',
      username: 'entrant',
    });
    const drugId = await seedDrug(db, {
      slug: 'entry-queued',
      names: { en: 'Entry queued' },
    });
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'halfLife',
      proposedValue: {
        op: 'create',
        input: { drugId, parameter: 'halfLife' },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('entry-queued:halfLife');
    expect(pairs).toContain('entry-queued:clearance');
  });

  it('is not fooled by a param_entry update, whose target is an entry id', async () => {
    // An entry update/delete stores the ENTRY id in target_id. Matching those
    // against drugs.id compares two different id spaces, so a careless filter
    // would suppress the gap of whichever drug happens to share that number.
    const userId = await seedUser(db, {
      email: 'u@example.com',
      username: 'updater',
    });
    const drugId = await seedDrug(db, {
      slug: 'unrelated',
      names: { en: 'Unrelated' },
    });
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId, // stands in for an entry id that collides with this drug
      parameter: 'halfLife',
      proposedValue: { op: 'update', patch: {} } as never,
      status: 'pending',
      submittedBy: userId,
    });

    expect(await gapPairs()).toContain('unrelated:halfLife');
  });

  it('keeps a pair whose pending edit proposes a null', async () => {
    // A clear is queued as an ordinary parameter edit carrying a JSON null,
    // and molecularWeight's spec is nullable — the only core parameter that
    // is. Approving it deletes an already-absent row, so the gap is still
    // real; suppressing it would hide genuine work for the edit's lifetime.
    const userId = await seedUser(db, {
      email: 'nuller@example.com',
      username: 'nuller',
    });
    const drugId = await seedDrug(db, {
      slug: 'null-proposal',
      names: { en: 'Null proposal' },
    });
    // Inserted as raw SQL: drizzle maps a JS `null` to SQL NULL, which the
    // NOT NULL column rejects. That is also why the API cannot currently
    // produce this row (see the test below) — the guard is here so the queue
    // stays right if that ever changes, not because the state is reachable.
    await db.execute(sql`
      INSERT INTO pending_edits (edit_type, target_id, parameter, proposed_value, status, submitted_by)
      VALUES ('parameter', ${drugId}, 'molecularWeight', 'null'::jsonb, 'pending', ${userId})
    `);

    expect(await gapPairs()).toContain('null-proposal:molecularWeight');
  });

  it('cannot be reached through the API: a null value fails the NOT NULL column', async () => {
    // Pins the reason the case above is theoretical. molecularWeight's spec is
    // nullable so `{ value: null }` passes validation, but the route stores
    // `valid.data` straight into a NOT NULL jsonb column and drizzle maps a JS
    // null to SQL NULL. A contributor clearing molecularWeight therefore gets
    // a 500 rather than a queued edit — a real (pre-existing) rough edge, but
    // not one that can hide a gap. If this ever starts succeeding, the queue
    // guard above is what keeps the gap visible.
    const userId = await seedUser(db, {
      email: 'nuller2@example.com',
      username: 'nuller2',
    });
    const drugId = await seedDrug(db, {
      slug: 'null-unreachable',
      names: { en: 'Null unreachable' },
    });

    const rejection = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'molecularWeight',
        proposedValue: null as never,
        status: 'pending',
        submittedBy: userId,
      })
      .then(
        () => null,
        (err: unknown) => err as Error & { cause?: Error },
      );

    expect(rejection, 'a JS null must not reach the jsonb column').not.toBeNull();
    expect(String(rejection?.cause?.message ?? rejection?.message)).toMatch(
      /not-null|not null/i,
    );
  });

  it('drops a pair that already has an open pending edit', async () => {
    const userId = await seedUser(db, {
      email: 'c@example.com',
      username: 'contrib',
    });
    const drugId = await seedDrug(db, {
      slug: 'queued',
      names: { en: 'Queued' },
    });
    await db.insert(pendingEdits).values({
      editType: 'parameter',
      targetId: drugId,
      parameter: 'halfLife',
      proposedValue: { min: 1, max: 2, unit: 'h' },
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('queued:halfLife');
    expect(pairs).toContain('queued:clearance');
  });

  it('drops a pair once its value is stored', async () => {
    const drugId = await seedDrug(db, {
      slug: 'filled',
      names: { en: 'Filled' },
    });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value: { min: 1, max: 2, unit: 'h' },
    });

    expect(await gapPairs()).not.toContain('filled:halfLife');
  });
});

describe('parameter gap queue — ranking', () => {
  it('puts method components ahead of more popular non-members', async () => {
    const inPanel = await seedDrug(db, {
      slug: 'panel-member',
      names: { en: 'Panel member' },
      popularityScore: 1,
    });
    await addToMethod(inPanel);
    await seedDrug(db, {
      slug: 'popular-outsider',
      names: { en: 'Popular outsider' },
      popularityScore: 999,
    });

    const rows = await gaps();
    expect(rows[0]!.slug).toBe('panel-member');
    expect(rows[0]!.in_method).toBe(true);
  });

  it('walks a drug’s parameters in the documented priority order', async () => {
    await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });

    const order = (await gaps()).map((r) => r.parameter);
    expect(order.slice(0, 6)).toEqual([
      'molecularWeight',
      'bloodPlasmaRatio',
      'halfLife',
      'volumeOfDistribution',
      'bioavailability',
      'tmax',
    ]);
  });

  it('falls through to the next candidate when the leader is excluded', async () => {
    // The property that actually ends the loop: excluding the head of the
    // queue must promote real work, not leave the cycle empty-handed.
    const bze = await seedBenzoylecgonine();
    await db.insert(drugParameters).values([
      { drugId: bze, parameter: 'molecularWeight', value: 289.33 },
      { drugId: bze, parameter: 'bloodPlasmaRatio', value: { min: 1, max: 1, unit: 'ratio' } },
      { drugId: bze, parameter: 'halfLife', value: { min: 5, max: 12, unit: 'h' } },
      { drugId: bze, parameter: 'volumeOfDistribution', value: { min: 1, max: 2, unit: 'L/kg' } },
    ]);

    const rows = await gaps();
    // bioavailability is next by priority and excluded, so the leader must be
    // the first genuinely open parameter after it — tmax, which stays in scope
    // for an analyte.
    expect(rows[0]!.parameter).toBe('tmax');
    expect(rows.map((r) => r.parameter)).not.toContain('bioavailability');
  });
});

describe('parameter gap queue — reclassifying a substance', () => {
  it('clears the unfillable pairs the moment the class is corrected', async () => {
    // The maintenance path: a substance seeded as a plain drug turns out to be
    // an analyte, an editor corrects `substance_class` via PATCH /api/drugs,
    // and the impossible pairs leave the queue without anyone touching a row
    // per parameter. This is what makes the class rule worth having over
    // marking each pair by hand.
    const drugId = await seedDrug(db, {
      slug: 'norfentanyl',
      names: { en: 'Norfentanyl' },
    });
    expect(await gapPairs()).toContain('norfentanyl:bioavailability');

    await db
      .update(drugs)
      .set({ substanceClass: 'metabolite' })
      .where(eq(drugs.id, drugId));

    const pairs = await gapPairs();
    expect(pairs).not.toContain('norfentanyl:bioavailability');
    expect(pairs).toContain('norfentanyl:halfLife');
    // Still in scope: measured after fentanyl is dosed.
    expect(pairs).toContain('norfentanyl:tmax');
  });

  it('restores them if the correction is reverted', async () => {
    const drugId = await seedDrug(db, {
      slug: 'reclassified',
      names: { en: 'Reclassified' },
      substanceClass: 'metabolite',
    });
    expect(await gapPairs()).not.toContain('reclassified:bioavailability');

    await db
      .update(drugs)
      .set({ substanceClass: 'drug' })
      .where(eq(drugs.id, drugId));

    expect(await gapPairs()).toContain('reclassified:bioavailability');
  });
});

describe('the classification backfill respects live data', () => {
  /**
   * Classifying an analyte on a database that already holds the catalog used
   * to be migration 0097's job. It is a script now, run after the deploy,
   * because a migration runs while the *previous* build is still accepting
   * writes — one with no applicability guard, free to store a bioavailability
   * moments after the migration's snapshot. It also has to be re-runnable:
   * four entries have already been withdrawn from the list after review, and
   * a judgement baked into a migration stays wrong forever.
   *
   * What has not changed is the policy. Classifying a substance declares
   * bioavailability and the dose ranges undefined for it, so doing that
   * to a row already holding such a value would manufacture the exact
   * contradiction every API path refuses to create. These exercise the
   * script's own function, not a paraphrase of it.
   */
  async function classOf(slug: string): Promise<string> {
    const [row] = await db
      .select({ substanceClass: drugs.substanceClass })
      .from(drugs)
      .where(eq(drugs.slug, slug));
    return row!.substanceClass;
  }

  it('classifies an analyte whose live rows agree', async () => {
    const id = await seedDrug(db, {
      slug: 'bze-clean',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });

    expect(await classifySubstance(id, 'metabolite', true)).toEqual({
      kind: 'classified',
    });
    expect(await classOf('bze-clean')).toBe('metabolite');
  });

  it('names what stands in the way and leaves the class alone', async () => {
    const id = await seedDrug(db, {
      slug: 'bze-valued',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });
    await db.insert(drugParameters).values({
      drugId: id,
      parameter: 'bioavailability',
      value: { min: 0.5, max: 0.6, unit: 'fraction' },
    });

    // Refuse rather than clear, the same policy PATCH /api/drugs applies. The
    // pair stays visible in the gap queue, so the skip is not silent — and the
    // report names the parameter, since "clear the conflicting values" is not
    // actionable if the operator has to guess which.
    expect(await classifySubstance(id, 'metabolite', true)).toEqual({
      kind: 'conflict',
      parameters: ['bioavailability'],
    });
    expect(await classOf('bze-valued')).toBe('drug');
  });

  it('skips one that has a source entry for such a parameter', async () => {
    const id = await seedDrug(db, {
      slug: 'bze-entried',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/bze', metadata: {} })
      .returning({ id: citations.id });
    await db.insert(parameterEntries).values({
      drugId: id,
      parameter: 'fatalDose',
      low: 1,
      high: 2,
      unit: 'mg/kg',
      citationId: citation!.id,
      origin: 'contributor',
    });

    expect(await classifySubstance(id, 'metabolite', true)).toEqual({
      kind: 'conflict',
      parameters: ['fatalDose'],
    });
    expect(await classOf('bze-entried')).toBe('drug');
  });

  it('is unbothered by values that stay meaningful for an analyte', async () => {
    const id = await seedDrug(db, {
      slug: 'bze-halflife',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });
    await db.insert(drugParameters).values({
      drugId: id,
      parameter: 'halfLife',
      value: { min: 5, max: 12, unit: 'h' },
    });

    expect(await classifySubstance(id, 'metabolite', true)).toEqual({
      kind: 'classified',
    });
    expect(await classOf('bze-halflife')).toBe('metabolite');
  });

  it('writes nothing in dry-run mode', async () => {
    const id = await seedDrug(db, {
      slug: 'bze-dry',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });

    expect(await classifySubstance(id, 'metabolite', false)).toEqual({
      kind: 'classified',
    });
    expect(await classOf('bze-dry')).toBe('drug');
  });

  it('never overwrites a class an editor set after the run began', async () => {
    // run() plans from a snapshot of the whole catalog, so an editor can
    // commit a reclassification before this drug's turn comes up. The lock
    // serializes the two — but an update that never re-reads only guarantees
    // the stale write lands last. Everything that decides the outcome is read
    // inside the lock, and the UPDATE is conditional on the class as well.
    const id = await seedDrug(db, {
      slug: 'bze-raced',
      names: { en: 'Benzoylecgonine' },
      pubchemCid: 448223,
    });
    await db
      .update(drugs)
      .set({ substanceClass: 'endogenous' })
      .where(eq(drugs.id, id));

    expect(await classifySubstance(id, 'metabolite', true)).toEqual({
      kind: 'reclassified-meanwhile',
      current: 'endogenous',
    });
    expect(await classOf('bze-raced')).toBe('endogenous');
  });

  it('reports a drug that vanished between the snapshot and its turn', async () => {
    expect(await classifySubstance(999_999, 'metabolite', true)).toEqual({
      kind: 'missing',
    });
  });
});

describe('parameter gap queue — admin focus', () => {
  /**
   * The exact scenario the LIMIT used to swallow. Two high-ranked method
   * drugs contribute enough higher-priority gaps to fill all 20 rows, so a
   * focus on `clearance` (last in the core priority order) saw nothing at all
   * when the filter was applied to the query's *result*. Narrowing inside the
   * query has to reach past the global cut.
   */
  async function seedEnoughToFillThePage(): Promise<void> {
    for (const slug of ['leader-a', 'leader-b']) {
      const id = await seedDrug(db, {
        slug,
        names: { en: slug },
        popularityScore: 1000,
      });
      await addToMethod(id);
    }
  }

  it('reaches an in-scope parameter that ranks below the global limit', async () => {
    await seedEnoughToFillThePage();
    const target = await seedDrug(db, {
      slug: 'low-ranked',
      names: { en: 'Low ranked' },
      popularityScore: 0,
    });

    // Unfocused, the page is entirely the two leaders' higher-priority gaps.
    const unfocused = await gaps();
    expect(unfocused).toHaveLength(20);
    expect(unfocused.map((r) => r.parameter)).not.toContain('clearance');

    const focused = await gaps({ parameters: ['clearance'], drugIds: null });
    expect(focused.map((r) => r.parameter)).toEqual(
      Array(focused.length).fill('clearance'),
    );
    expect(focused.map((r) => r.drug_id)).toContain(target);
  });

  it('narrows to the drugs of a method or page focus', async () => {
    const inScope = await seedDrug(db, {
      slug: 'in-scope',
      names: { en: 'In scope' },
      popularityScore: 1,
    });
    await seedDrug(db, {
      slug: 'out-of-scope',
      names: { en: 'Out of scope' },
      popularityScore: 999,
    });

    const rows = await gaps({ parameters: null, drugIds: [inScope] });
    expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(['in-scope']));
  });

  it('still applies every exclusion under a focus', async () => {
    // Focus narrows the candidate set; it must not widen it past the
    // applicability rules and hand back an impossible pair.
    const bze = await seedBenzoylecgonine();

    const rows = await gaps({
      parameters: ['bioavailability'],
      drugIds: [bze],
    });
    expect(rows).toEqual([]);
  });

  it('counts suppression over the focused candidate space only', async () => {
    await seedBenzoylecgonine();
    const other = await seedDrug(db, {
      slug: 'other-metabolite',
      names: { en: 'Other metabolite' },
      substanceClass: 'metabolite',
    });

    // Three per metabolite — bioavailability from the measured lane, ka and
    // absorptionModel from the declaration lane — so six across the two, and
    // three once the focus narrows the candidate space to one of them. tmax
    // stays in scope and the dose ranges are in neither lane.
    expect(await suppressed()).toEqual({ substance_class: 6 });
    expect(await suppressed({ parameters: null, drugIds: [other] })).toEqual({
      substance_class: 3,
    });
  });

  it('treats an unset focus config as no restriction', async () => {
    // resolveFocusNarrowing reads the real table; a fresh DB has no config row
    // and must fall through to the whole catalog rather than to nothing.
    await seedDrug(db, { slug: 'visible', names: { en: 'Visible' } });

    const focus = await resolveFocusNarrowing();
    expect(focus).toEqual(NO_FOCUS);
    expect(await gapPairs(focus)).toContain('visible:halfLife');
  });

  it('serves nothing when the admin scoped the action to nothing', async () => {
    // An empty selection is a real answer, not a missing one. §3 says the
    // routine logs no_change "rather than reaching outside the focus set", so
    // widening an empty scope to the whole catalogue would have the agent
    // work against an explicit admin instruction — and invisibly, since a
    // populated queue looks like ordinary work.
    await seedDrug(db, { slug: 'out-of-scope', names: { en: 'Out of scope' } });

    expect(await gaps({ parameters: [], drugIds: null })).toEqual([]);
    expect(await gaps({ parameters: null, drugIds: [] })).toEqual([]);
  });

  it('resolves an empty parameter focus to an empty scope, not to unrestricted', async () => {
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'parameters', parameters: [] });

    const focus = await resolveFocusNarrowing();
    expect(focus).toEqual({ parameters: [], drugIds: null });
    expect(await gaps(focus)).toEqual([]);
  });

  it('resolves a page focus with no drug monographs to an empty scope', async () => {
    // A topic-only page focus resolves to zero drugs. That scopes the
    // parameter action to nothing — it does not release it.
    const author = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
    });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'a-topic',
        title: 'A topic',
        content: {},
        pageType: 'topic',
        createdBy: author,
        updatedBy: author,
      })
      .returning({ id: wikiPages.id });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [page!.id] });
    await seedDrug(db, { slug: 'elsewhere', names: { en: 'Elsewhere' } });

    const focus = await resolveFocusNarrowing();
    expect(focus).toEqual({ parameters: null, drugIds: [] });
    expect(await gaps(focus)).toEqual([]);
  });

  it('resolves a page focus by internal id, not by a colliding PubChem CID', async () => {
    // The repo's documented collision: one drug's internal id equals another
    // drug's PubChem CID (25C-NBOMe id 281 vs carbon monoxide CID 281).
    // Resolving both with an OR would put the decoy in the focus set, and
    // because the queue ranks by method membership and popularity it could
    // then be served ahead of the intended drug — the agent working a
    // substance the admin never selected.
    const intended = await seedDrug(db, {
      slug: 'intended',
      names: { en: 'Intended' },
      popularityScore: 1,
    });
    const decoy = await seedDrug(db, {
      slug: 'decoy',
      names: { en: 'Decoy' },
      pubchemCid: intended,
      popularityScore: 9999,
    });
    await addToMethod(decoy);

    const author = await seedUser(db, {
      email: 'a2@example.com',
      username: 'a2',
    });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'intended-monograph',
        title: 'Intended',
        content: {},
        pageType: 'drug_monograph',
        drugCid: intended,
        createdBy: author,
        updatedBy: author,
      })
      .returning({ id: wikiPages.id });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [page!.id] });

    const focus = await resolveFocusNarrowing();
    expect(focus.drugIds).toEqual([intended]);

    // And the decoy — higher popularity, in a method — never reaches the queue.
    const slugs = new Set((await gaps(focus)).map((r) => r.slug));
    expect(slugs).toEqual(new Set(['intended']));
  });

  it('still falls back to PubChem CID for a legacy drug_cid', async () => {
    // Legacy rows store a CID rather than an id; those must still resolve, or
    // the fallback's removal would silently empty an admin's focus.
    const drugId = await seedDrug(db, {
      slug: 'legacy-linked',
      names: { en: 'Legacy linked' },
      pubchemCid: 999001,
    });
    const author = await seedUser(db, {
      email: 'a3@example.com',
      username: 'a3',
    });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'legacy-monograph',
        title: 'Legacy',
        content: {},
        pageType: 'drug_monograph',
        drugCid: 999001,
        createdBy: author,
        updatedBy: author,
      })
      .returning({ id: wikiPages.id });
    await db
      .insert(agentFocusConfig)
      .values({ id: 1, mode: 'pages', pageIds: [page!.id] });

    expect((await resolveFocusNarrowing()).drugIds).toEqual([drugId]);
  });

  it('still returns the whole catalogue under mode=all', async () => {
    await db.insert(agentFocusConfig).values({ id: 1, mode: 'all' });
    await seedDrug(db, { slug: 'anything', names: { en: 'Anything' } });

    expect(await resolveFocusNarrowing()).toEqual(NO_FOCUS);
    expect(await gapPairs()).toContain('anything:halfLife');
  });
});

describe('parameter gap queue — suppression counts', () => {
  it('reports nothing when every gap is real', async () => {
    await seedDrug(db, { slug: 'plain', names: { en: 'Plain' } });
    expect(await suppressed()).toEqual({});
  });

  it('attributes a metabolite’s hidden parameter to the class rule', async () => {
    await seedBenzoylecgonine();
    // Three, one per lane-eligible parameter that needs a dose OF THIS
    // substance: `bioavailability` from the measured lane, and `ka` +
    // `absorptionModel` from the model-declaration lane. tmax is defined for an
    // analyte (measured after the parent dose), disposition and elimination are
    // real questions about a metabolite, and the dose ranges are in neither
    // lane.
    expect(await suppressed()).toEqual({ substance_class: 3 });
  });

  it('counts a marker and a cooldown under their own reasons', async () => {
    const drugId = await seedDrug(db, { slug: 'mixed', names: { en: 'Mixed' } });
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'logD',
      reason: 'Undefined for this substance.',
    });
    await logAbsent(drugId, 'clearance', 1);

    expect(await suppressed()).toEqual({
      not_applicable_marker: 1,
      absent_cooldown: 1,
    });
  });

  it('reports the durable reason when a pair is suppressed twice over', async () => {
    // Ranked as gapSuppressionReason ranks them, so the total never
    // double-counts a single pair.
    const drugId = await seedBenzoylecgonine();
    await logAbsent(drugId, 'bioavailability', 1);

    // bioavailability is suppressed twice over and still counted once, under
    // the durable reason; `ka` and `absorptionModel` are the other two.
    expect(await suppressed()).toEqual({ substance_class: 3 });
  });

  it('does not count an absence a later verification superseded', async () => {
    // The queue and this count must answer the same question. They cannot
    // share an assembled clause — the queue ANDs the negated reasons, the
    // count ranks them apart to name one — so they build from the same three
    // predicates instead. When each held its own copy, the queue learned that
    // newer evidence retires an absence and the count did not: the very same
    // response then listed the pair as open while calling it suppressed.
    const drugId = await seedDrug(db, {
      slug: 'counted-superseded',
      names: { en: 'Counted superseded' },
    });
    await logAbsent(drugId, 'clearance', 60);
    await db.insert(verificationLog).values({
      targetType: 'parameter',
      targetId: drugId,
      parameter: 'clearance',
      concordance: 'strong',
      outcome: 'submitted_pending',
      sourcesConsultedCount: 4,
      verifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    expect(await suppressed()).toEqual({});
    // The other half of the invariant, asserted in the same test so neither
    // side can be "fixed" alone.
    expect(await gapPairs()).toContain('counted-superseded:clearance');
  });

  it('does not count a pair whose value is already stored', async () => {
    const drugId = await seedDrug(db, { slug: 'done', names: { en: 'Done' } });
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'halfLife',
      reason: 'Undefined for this substance.',
    });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value: { min: 1, max: 2, unit: 'h' },
    });

    expect(await suppressed()).toEqual({});
  });
});

describe('parameter gap queue — the model-declaration lane', () => {
  /**
   * The lane exists because these four parameters are filled somewhere the
   * original queue never looked.
   *
   * `dispositionModel`, `eliminationModel`, `absorptionModel` and `ka` are all
   * `summarizable: false`, so `recomputeAndCacheParameterSummary` returns
   * before writing anything to `drug_parameters` — no matter how many cited
   * entries a curator lands. Ranking them into the core set would have asked
   * the `drug_parameters` question about them and got "missing" forever: the
   * benzoylecgonine loop, rebuilt on purpose. These tests pin the lane's own
   * fill test instead.
   */
  async function citeSomething(): Promise<number> {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/model', metadata: {} })
      .returning({ id: citations.id });
    return citation!.id;
  }

  async function declare(
    drugId: number,
    parameter: string,
    categoricalValue: string | null,
    extra: { route?: string; median?: number; unit?: string } = {},
  ): Promise<void> {
    await db.insert(parameterEntries).values({
      drugId,
      parameter,
      categoricalValue,
      route: extra.route ?? null,
      median: extra.median ?? null,
      unit: extra.unit ?? '',
      citationId: await citeSomething(),
      origin: 'contributor',
    });
  }

  it('offers the three axes and ka for an administered drug', async () => {
    await seedDrug(db, { slug: 'diazepam', names: { en: 'Diazepam' } });

    expect(await gapPairs()).toEqual(
      expect.arrayContaining([
        'diazepam:dispositionModel',
        'diazepam:eliminationModel',
        'diazepam:absorptionModel',
        'diazepam:ka',
      ]),
    );
  });

  it('retires a declaration once a cited entry asserts it', async () => {
    // The anti-loop property, and the reason the lane cannot share the core
    // fill test: nothing is written to drug_parameters here, so a queue asking
    // that question would re-serve this pair on every cycle forever.
    const drugId = await seedDrug(db, {
      slug: 'ethanol',
      names: { en: 'Ethanol' },
    });
    await declare(drugId, 'eliminationModel', 'michaelis-menten');

    expect(await gapPairs()).not.toContain('ethanol:eliminationModel');
    // Its siblings are untouched — one declaration retires one axis.
    expect(await gapPairs()).toContain('ethanol:dispositionModel');
  });

  it('is not satisfied by a stored drug_parameters row', async () => {
    // The inverse guard. If someone ever "simplifies" the two fill tests back
    // into one, this is the direction that fails silently: a declaration would
    // look filled because some unrelated writer left an aggregate row behind,
    // and the axis would never be asked for again.
    const drugId = await seedDrug(db, {
      slug: 'ghb',
      names: { en: 'GHB' },
    });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'dispositionModel',
      value: { median: 1 },
    });

    expect(await gapPairs()).toContain('ghb:dispositionModel');
  });

  it('retires a route-scoped ka declared on one route', async () => {
    // Route is deliberately not part of the fill test: the queue is keyed
    // (drug, parameter), and one cited route is enough to stop asking. Widening
    // to every route is flag and tier-C work, like deepening a thin value.
    const drugId = await seedDrug(db, {
      slug: 'morfin',
      names: { en: 'Morphine' },
    });
    await declare(drugId, 'ka', null, {
      route: 'oral',
      median: 0.8,
      unit: '1/h',
    });

    expect(await gapPairs()).not.toContain('morfin:ka');
  });

  it('never offers absorption or ka for a metabolite, but still asks the rest', async () => {
    // A metabolite is formed in vivo, so "how does a dose of it enter the
    // body" has no answer — the same barrier bioavailability already sat
    // behind. Its disposition and elimination are real questions, though: it
    // distributes and it is cleared.
    await seedBenzoylecgonine();
    const pairs = await gapPairs();

    expect(pairs).not.toContain('benzoylecgonin:absorptionModel');
    expect(pairs).not.toContain('benzoylecgonin:ka');
    expect(pairs).toEqual(
      expect.arrayContaining([
        'benzoylecgonin:dispositionModel',
        'benzoylecgonin:eliminationModel',
      ]),
    );
  });

  it('labels each row with the payload that closes it', async () => {
    await seedDrug(db, { slug: 'kodein', names: { en: 'Codeine' } });
    const rows = await gaps();
    const kind = (parameter: string) =>
      rows.find((r) => r.slug === 'kodein' && r.parameter === parameter)
        ?.fill_kind;

    expect(kind('halfLife')).toBe('value');
    expect(kind('dispositionModel')).toBe('declaration');
    expect(kind('ka')).toBe('declaration');
  });

  it('ranks declarations behind the whole measured set for one drug', async () => {
    // Every model family needs the numbers too, so a compartment count is not
    // worth more than a missing half-life. An admin who wants them first says
    // so with a parameter focus.
    await seedDrug(db, { slug: 'tramadol', names: { en: 'Tramadol' } });
    const own = (await gapPairs()).filter((p) => p.startsWith('tramadol:'));
    const firstDeclaration = own.findIndex((p) =>
      p.endsWith(':dispositionModel'),
    );
    const lastMeasured = own.reduce(
      (acc, p, i) => (p.endsWith(':clearance') ? i : acc),
      -1,
    );

    expect(firstDeclaration).toBeGreaterThan(lastMeasured);
  });

  it('drops a declaration a pending categorical entry already proposes', async () => {
    // A declaration is never "already filled" until its entry is approved, so
    // without the pending-edit exclusion the queue would hand the same axis to
    // the next cycle and duplicate research already submitted. The exclusion is
    // shared with the measured lane; this pins that it reaches a categorical
    // payload too, whose proposed_value carries no numeric value at all.
    const userId = await seedUser(db, {
      email: 'axis@example.com',
      username: 'axis-entrant',
    });
    const drugId = await seedDrug(db, {
      slug: 'axis-queued',
      names: { en: 'Axis queued' },
    });
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'dispositionModel',
      proposedValue: {
        op: 'create',
        input: {
          drugId,
          parameter: 'dispositionModel',
          categoricalValue: 'two-compartment',
        },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('axis-queued:dispositionModel');
    expect(pairs).toContain('axis-queued:eliminationModel');
  });

  it('serves a declaration first when the focus asks for one', async () => {
    const drugId = await seedDrug(db, {
      slug: 'oksykodon',
      names: { en: 'Oxycodone' },
    });
    await addToMethod(drugId);

    expect(
      await gapPairs({
        parameters: ['dispositionModel', 'eliminationModel'],
        drugIds: [drugId],
      }),
    ).toEqual(['oksykodon:dispositionModel', 'oksykodon:eliminationModel']);
  });
});

describe('agent focus — a method focus that also names parameters', () => {
  /**
   * The composition the model-declaration lane needs to be reachable.
   *
   * `FocusNarrowing` always had two independent axes, but every mode populated
   * exactly one of them, so "the components of panel 9001" and "the
   * model-structure parameters" were mutually exclusive instructions. An admin
   * could say either and never both — which is the one pairing worth saying.
   */
  async function focusOnMethod(
    methodId: number,
    parameters: string[] = [],
  ): Promise<void> {
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'methods',
      methodIds: [methodId],
      parameters,
      // Mirrors what `scopeArraysToMode` derives on a real save: the opt-in
      // marks an array a composition-aware writer put there. Seeding the row
      // without it is the LEGACY shape, covered by its own describe below —
      // so these tests have to set it or they would be asserting composition
      // against a row the resolver is right to ignore.
      methodsParametersOptIn: parameters.length > 0,
    });
  }

  it('narrows both axes at once', async () => {
    const onPanel = await seedDrug(db, {
      slug: 'fentanyl',
      names: { en: 'Fentanyl' },
      popularityScore: 1,
    });
    await addToMethod(onPanel, 9001);
    await seedDrug(db, {
      slug: 'off-panel',
      names: { en: 'Off panel' },
      popularityScore: 999,
    });
    await focusOnMethod(9001, ['dispositionModel', 'eliminationModel']);

    const focus = await resolveFocusNarrowing();
    expect(focus).toEqual({
      parameters: ['dispositionModel', 'eliminationModel'],
      drugIds: [onPanel],
    });
    expect(await gapPairs(focus)).toEqual([
      'fentanyl:dispositionModel',
      'fentanyl:eliminationModel',
    ]);
  });

  it('treats an empty parameter list as every parameter, not none', async () => {
    // The one place empty does NOT mean "nothing is in scope". Here the
    // methods carry the instruction and the parameters are an optional extra
    // filter, so reading a blank filter as an empty scope would silence a
    // focus that names real drugs. `mode = "parameters"` keeps the opposite
    // reading, and the test above it pins that.
    const onPanel = await seedDrug(db, {
      slug: 'metadon',
      names: { en: 'Methadone' },
    });
    await addToMethod(onPanel, 9001);
    await focusOnMethod(9001);

    const focus = await resolveFocusNarrowing();
    expect(focus).toEqual({ parameters: null, drugIds: [onPanel] });
    expect(await gapPairs(focus)).toContain('metadon:halfLife');
  });

  it('drops a parameter id the registry does not know', async () => {
    const onPanel = await seedDrug(db, {
      slug: 'kokain',
      names: { en: 'Cocaine' },
    });
    await addToMethod(onPanel, 9001);
    await focusOnMethod(9001, ['dispositionModel', 'notAParameter']);

    expect((await resolveFocusNarrowing()).parameters).toEqual([
      'dispositionModel',
    ]);
  });

  it('still applies every exclusion under the composed focus', async () => {
    // Composition narrows; it must not widen past the applicability rules.
    const bze = await seedBenzoylecgonine();
    await focusOnMethod(9001, ['absorptionModel', 'dispositionModel']);

    const focus = await resolveFocusNarrowing();
    expect(focus.drugIds).toContain(bze);
    // absorptionModel is in the focus and still refused: nobody doses a
    // metabolite, so there is no input shape to cite.
    expect(await gapPairs(focus)).toEqual(['benzoylecgonin:dispositionModel']);
  });
});

describe('agent focus — the deploy window a migration cannot close', () => {
  /**
   * `vercel.json` applies migrations as the FIRST step of `vercel build`, and
   * `vercel deploy --prebuilt` only runs once that build finishes — so every
   * migration lands while the PREVIOUS build is still serving writes. An admin
   * who saves a `methods` focus in that window goes through the old handler,
   * which persists `parameters` and has never heard of the opt-in, and the row
   * it writes is byte-identical to one an admin composed on purpose.
   *
   * Migration 0121 cannot help: its UPDATE has already run by then. So the
   * guard is the flag, and these tests are what prove it closes the window
   * rather than merely narrowing it.
   */
  async function seedLegacyMethodsFocus(methodId: number): Promise<void> {
    // Exactly what the pre-composition handler would write: mode, methods and
    // a parameters array, with the opt-in left at its column default.
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'methods',
      methodIds: [methodId] as never,
      parameters: ['halfLife'] as never,
    });
  }

  it('ignores a parameters array written by the old handler', async () => {
    const onPanel = await seedDrug(db, {
      slug: 'buprenorfin',
      names: { en: 'Buprenorphine' },
    });
    await addToMethod(onPanel, 9001);
    await seedLegacyMethodsFocus(9001);

    const focus = await resolveFocusNarrowing();

    // Unrestricted on the parameter axis — the drug focus the admin really
    // set survives, and the agent keeps working every parameter.
    expect(focus).toEqual({ parameters: null, drugIds: [onPanel] });
    expect(await gapPairs(focus)).toContain('buprenorfin:halfLife');
    expect(await gapPairs(focus)).toContain('buprenorfin:clearance');
  });

  it('honours the same array once a composition-aware writer vouches for it', async () => {
    // The only difference from the case above is the flag, which is the point:
    // nothing else distinguishes a deliberate composition from a legacy write.
    const onPanel = await seedDrug(db, {
      slug: 'naloxon',
      names: { en: 'Naloxone' },
    });
    await addToMethod(onPanel, 9001);
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'methods',
      methodIds: [9001] as never,
      parameters: ['halfLife'] as never,
      methodsParametersOptIn: true,
    });

    const focus = await resolveFocusNarrowing();

    expect(focus).toEqual({ parameters: ['halfLife'], drugIds: [onPanel] });
    expect(await gapPairs(focus)).toEqual(['naloxon:halfLife']);
  });
});

/**
 * The coverage lane. Metabolism and pharmacodynamics are the two parts of a
 * monograph with no parameter id — they are graphs of relationship rows, not
 * quantities — so until this lane existed the queue never asked whether a drug
 * had either, and an admin focus or a moderator flag naming one resolved to an
 * empty queue. These tests pin both halves: that the pairs are served, and that
 * the right relationship rows retire them.
 */
describe('parameter gap queue — coverage areas', () => {
  async function seedMechanismTarget(drugId: number): Promise<void> {
    const bioEntityId = await seedBioEntity(db, {
      slug: 'mor',
      symbol: 'MOR',
      name: 'My-opioidreseptor',
      nameEn: 'Mu-opioid receptor',
      entityClass: 'GPCR',
    });
    await db
      .insert(drugReceptorTargets)
      .values({ drugId, bioEntityId, interactionType: 'agonist' });
  }

  it('offers both areas for a drug that has neither', async () => {
    await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });

    const rows = await gaps();
    const areas = rows.filter((r) => r.fill_kind === 'relation');
    expect(areas.map((r) => r.parameter).sort()).toEqual([
      'metabolism',
      'pharmacodynamics',
    ]);
  });

  it('ranks them behind the measured parameters and the declarations', async () => {
    await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });

    const order = (await gaps()).map((r) => r.fill_kind);
    const firstRelation = order.indexOf('relation');
    const lastOther = order.lastIndexOf('declaration');
    expect(firstRelation).toBeGreaterThan(lastOther);
  });

  it('retires metabolism on a single elimination route', async () => {
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db
      .insert(drugEliminationRoutes)
      .values({ drugId, kind: 'renal', label: 'Uendret i urin' });

    expect(await gapPairs()).not.toContain('solo:metabolism');
    expect(await gapPairs()).toContain('solo:pharmacodynamics');
  });

  it('retires metabolism on a single metabolite edge', async () => {
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db
      .insert(drugMetabolites)
      .values({ parentDrugId: drugId, metaboliteName: 'Nordiazepam' });

    expect(await gapPairs()).not.toContain('solo:metabolism');
  });

  it('does not let an empty profile stub retire metabolism', async () => {
    // A profile row an editor created and abandoned says nothing about how the
    // drug is metabolised, so it must not close the gap. A real evidence note
    // does.
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db
      .insert(drugMetabolismProfiles)
      .values({ drugId, evidenceNote: '   ' });

    expect(await gapPairs()).toContain('solo:metabolism');

    await db
      .update(drugMetabolismProfiles)
      .set({ evidenceNote: 'Hovedsakelig CYP3A4-mediert N-demetylering.' })
      .where(eq(drugMetabolismProfiles.drugId, drugId));

    expect(await gapPairs()).not.toContain('solo:metabolism');
  });

  it('does not let a precursor edge retire the metabolite’s own metabolism', async () => {
    // The edge belongs to the parent. Counting it here would mark every
    // metabolite covered without a word about what becomes of it.
    const parent = await seedDrug(db, {
      slug: 'diazepam',
      names: { en: 'Diazepam' },
    });
    const child = await seedDrug(db, {
      slug: 'nordiazepam',
      names: { en: 'Nordazepam' },
    });
    await db.insert(drugMetabolites).values({
      parentDrugId: parent,
      metaboliteDrugId: child,
      metaboliteName: 'Nordiazepam',
    });

    // Focused on the one area so the assertion is not decided by where two
    // drugs' worth of higher-priority gaps happen to fall against the LIMIT.
    const pairs = await gapPairs({ parameters: ['metabolism'], drugIds: null });
    expect(pairs).not.toContain('diazepam:metabolism');
    expect(pairs).toContain('nordiazepam:metabolism');
  });

  it('retires pharmacodynamics on a single receptor-target mechanism', async () => {
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await seedMechanismTarget(drugId);

    const pairs = await gapPairs();
    expect(pairs).not.toContain('solo:pharmacodynamics');
    expect(pairs).toContain('solo:metabolism');
  });

  it('keeps both areas in scope for an analyte nobody administers', async () => {
    // The substance-class rule retires the pairs that need an administered
    // dose. A metabolite still has a metabolic fate and a mechanism, so
    // neither area is ruled out by class.
    await seedBenzoylecgonine();

    const pairs = await gapPairs();
    expect(pairs).toContain('benzoylecgonin:metabolism');
    expect(pairs).toContain('benzoylecgonin:pharmacodynamics');
  });

  it('hides an area whose relationship edit is awaiting review', async () => {
    // The duplicate-proposal loop. A contributor agent's metabolism write
    // queues a FULL-REPLACEMENT pending edit keyed on the drug with no
    // `parameter` at all, and the live rows stay absent until approval — so
    // the pair-equality exclusion cannot see it. Without a branch of its own
    // the gap came back every cycle, the routine filed another full
    // replacement each time, and approving a stale one would overwrite the
    // relationships an earlier one added.
    const userId = await seedUser(db, {
      email: 'agent@example.com',
      username: 'agent',
    });
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(pendingEdits).values({
      editType: 'metabolism',
      targetId: drugId,
      proposedValue: { routes: [{ kind: 'renal' }] } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('solo:metabolism');
    // Surgical: the other area is untouched work.
    expect(pairs).toContain('solo:pharmacodynamics');
  });

  it('hides pharmacodynamics behind a pending receptor_targets edit', async () => {
    const userId = await seedUser(db, {
      email: 'agent@example.com',
      username: 'agent',
    });
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(pendingEdits).values({
      editType: 'receptor_targets',
      targetId: drugId,
      proposedValue: { mechanisms: [] } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs();
    expect(pairs).not.toContain('solo:pharmacodynamics');
    expect(pairs).toContain('solo:metabolism');
  });

  it('is not fooled by a relationship edit on a different drug', async () => {
    // `target_id` is a drugs.id here, so the branch has to compare it to THIS
    // drug — a mapping that ignored the id would silence the whole catalogue
    // the moment one proposal existed.
    const userId = await seedUser(db, {
      email: 'agent@example.com',
      username: 'agent',
    });
    await seedDrug(db, { slug: 'mine', names: { en: 'Mine' } });
    const theirs = await seedDrug(db, {
      slug: 'theirs',
      names: { en: 'Theirs' },
    });
    await db.insert(pendingEdits).values({
      editType: 'metabolism',
      targetId: theirs,
      proposedValue: { routes: [] } as never,
      status: 'pending',
      submittedBy: userId,
    });

    const pairs = await gapPairs({ parameters: ['metabolism'], drugIds: null });
    expect(pairs).toContain('mine:metabolism');
    expect(pairs).not.toContain('theirs:metabolism');
  });

  it('reopens the area once the relationship edit is no longer pending', async () => {
    // A withdrawn or rejected proposal leaves the section as empty as it found
    // it, so the gap is real again. Suppressing on the row's existence rather
    // than its status would hide it for good.
    const userId = await seedUser(db, {
      email: 'agent@example.com',
      username: 'agent',
    });
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    const [edit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'metabolism',
        targetId: drugId,
        proposedValue: { routes: [] } as never,
        status: 'pending',
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    expect(await gapPairs()).not.toContain('solo:metabolism');

    await db
      .update(pendingEdits)
      .set({ status: 'rejected' })
      .where(eq(pendingEdits.id, edit!.id));

    expect(await gapPairs()).toContain('solo:metabolism');
  });

  it('suppresses an area after an exhaustive search found nothing', async () => {
    // The absent cooldown reaches this lane through the same predicate as the
    // other two, which is only worth anything if the agent can write the row —
    // see the schema test for the other half.
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await logAbsent(drugId, 'metabolism', 1);

    const pairs = await gapPairs();
    expect(pairs).not.toContain('solo:metabolism');
    expect(pairs).toContain('solo:pharmacodynamics');

    expect((await suppressed()).absent_cooldown).toBeGreaterThan(0);
  });

  it('serves an area focus that ranks below the global limit', async () => {
    // What the admin panel now makes selectable. Coverage areas rank last, so
    // narrowing has to happen inside the query — filtering the returned page
    // would show an empty queue however many real gaps existed.
    for (const slug of ['leader-a', 'leader-b']) {
      const id = await seedDrug(db, {
        slug,
        names: { en: slug },
        popularityScore: 1000,
      });
      await addToMethod(id);
    }
    const target = await seedDrug(db, {
      slug: 'low-ranked',
      names: { en: 'Low ranked' },
      popularityScore: 0,
    });

    const unfocused = await gaps();
    expect(unfocused).toHaveLength(20);
    expect(unfocused.map((r) => r.parameter)).not.toContain('metabolism');

    const focused = await gaps({
      parameters: ['metabolism', 'pharmacodynamics'],
      drugIds: null,
    });
    expect(focused.map((r) => r.drug_id)).toContain(target);
    expect(new Set(focused.map((r) => r.fill_kind))).toEqual(
      new Set(['relation']),
    );
  });

  it('keeps an area focus alive through resolveFocusNarrowing', async () => {
    // The route filters the stored array against the work-target registry.
    // Before coverage areas had ids, this is where a saved `metabolism`
    // selection was silently dropped — the admin saw it ticked and the agent
    // was scoped to nothing.
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'parameters',
      parameters: ['metabolism', 'pharmacodynamics', 'notAThing'] as never,
    });

    const focus = await resolveFocusNarrowing();

    expect(focus).toEqual({
      parameters: ['metabolism', 'pharmacodynamics'],
      drugIds: null,
    });
    expect(await gapPairs(focus)).toEqual([
      `solo:metabolism`,
      `solo:pharmacodynamics`,
    ]);
    expect(drugId).toBeGreaterThan(0);
  });
});

describe('parameter gap queue — dose-context observations (Cmax)', () => {
  /**
   * #1346. Cmax was a legal focus target — the admin panel offered it and
   * saved it — but the queue's narrowing filters within its lanes and Cmax was
   * in none of them, so ticking it scoped the agent to nothing. It is
   * entry-only (no drug-level value, never a `drug_parameters` row), so it
   * needs the entry fill test, not the core one.
   */
  async function citeSomething(): Promise<number> {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/cmax', metadata: {} })
      .returning({ id: citations.id });
    return citation!.id;
  }

  async function recordCmax(
    drugId: number,
    administeredDrugId: number = drugId,
  ): Promise<void> {
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'cmax',
      unit: 'ng/mL',
      matrix: 'plasma',
      route: 'oral',
      n: 10,
      citationId: await citeSomething(),
      centralValue: '84',
      centralStatistic: 'arithmetic_mean',
      valueBasis: 'concentration',
      doseValue: '2',
      doseUnit: 'mg',
      doseRegimen: 'single',
      administeredDrugId,
      origin: 'contributor',
    } as never);
  }

  it('offers Cmax for a drug that has no reading, labelled as an observation', async () => {
    await seedDrug(db, { slug: 'diazepam', names: { en: 'Diazepam' } });

    const row = (await gaps()).find(
      (r) => r.slug === 'diazepam' && r.parameter === 'cmax',
    );
    expect(row?.fill_kind).toBe('observation');
  });

  it('ranks Cmax behind every other lane for one drug', async () => {
    await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });

    const order = (await gaps()).map((r) => r.fill_kind);
    const firstObservation = order.indexOf('observation');
    expect(firstObservation).toBeGreaterThan(order.lastIndexOf('relation'));
  });

  it('retires Cmax once one reading is recorded', async () => {
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await recordCmax(drugId);

    expect(await gapPairs()).not.toContain('solo:cmax');
  });

  it('is not satisfied by a stored drug_parameters row', async () => {
    // The inverse guard, as for declarations: Cmax never writes one, so a
    // stray aggregate row must not make the lane think it is covered.
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'cmax',
      value: { median: 1 },
    });

    expect(await gapPairs()).toContain('solo:cmax');
  });

  it('keeps Cmax in scope for a metabolite, and a reading after the parent retires it', async () => {
    // Unlike bioavailability, a metabolite's peak is measured after its parent
    // is dosed and is routinely published — the analyte is the metabolite, the
    // administered drug is the parent.
    const bze = await seedBenzoylecgonine();
    const cocaine = await seedDrug(db, {
      slug: 'kokain',
      names: { en: 'Cocaine' },
    });
    expect(await gapPairs()).toContain('benzoylecgonin:cmax');

    await recordCmax(bze, cocaine);
    expect(await gapPairs()).not.toContain('benzoylecgonin:cmax');
  });

  it('drops Cmax while a pending create already proposes a reading', async () => {
    const userId = await seedUser(db, {
      email: 'cmax@example.com',
      username: 'cmax-entrant',
    });
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: drugId,
      parameter: 'cmax',
      proposedValue: {
        op: 'create',
        input: { drugId, parameter: 'cmax', centralValue: 84 },
      } as never,
      status: 'pending',
      submittedBy: userId,
    });

    expect(await gapPairs()).not.toContain('solo:cmax');
  });

  it('suppresses Cmax after an exhaustive search found nothing', async () => {
    const drugId = await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await logAbsent(drugId, 'cmax', 1);

    expect(await gapPairs()).not.toContain('solo:cmax');
    expect((await suppressed()).absent_cooldown).toBeGreaterThan(0);
  });

  it('serves a Cmax focus that ranks below the global limit', async () => {
    // The reported symptom: Cmax ticked in the admin panel, nothing submitted.
    for (const slug of ['leader-a', 'leader-b']) {
      const id = await seedDrug(db, {
        slug,
        names: { en: slug },
        popularityScore: 1000,
      });
      await addToMethod(id);
    }
    const target = await seedDrug(db, {
      slug: 'low-ranked',
      names: { en: 'Low ranked' },
      popularityScore: 0,
    });

    expect((await gaps()).map((r) => r.parameter)).not.toContain('cmax');

    const focused = await gaps({ parameters: ['cmax'], drugIds: null });
    expect(focused.map((r) => r.drug_id)).toContain(target);
    expect(new Set(focused.map((r) => r.fill_kind))).toEqual(
      new Set(['observation']),
    );
  });

  it('keeps a Cmax focus alive through resolveFocusNarrowing', async () => {
    await seedDrug(db, { slug: 'solo', names: { en: 'Solo' } });
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'parameters',
      parameters: ['cmax'] as never,
    });

    const focus = await resolveFocusNarrowing();

    expect(focus).toEqual({ parameters: ['cmax'], drugIds: null });
    expect(await gapPairs(focus)).toEqual(['solo:cmax']);
  });
});
