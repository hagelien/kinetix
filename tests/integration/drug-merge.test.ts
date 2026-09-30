/**
 * End-to-end drug merge against real SQL (#admin-drug-merge).
 *
 * Uses MHD's real situation as the fixture: one substance registered twice, one
 * copy carrying the written monograph. The merge must keep the monograph copy,
 * fold every kind of structured reference from the duplicate onto it (parameters
 * with an admin-resolved conflict, source entries, rettstoks method memberships
 * with a dedupe, metabolite and precursor edges, and a RESTRICT-bound reference
 * atlas row), rewrite links to the deleted page, and delete the duplicate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import {
  analyticalMethodComponents,
  analyticalMethods,
  agentFocusConfig,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterApplicability,
  drugParameters,
  drugReceptorTargets,
  drugs,
  parameterEntries,
  patternReferenceCases,
  patternReferenceCohorts,
  patternReferenceExposures,
  patternReferenceObservations,
  patternReferenceSpecimens,
  pendingEdits,
  pmConcentrationDistributions,
  pmConcentrationSources,
  simulatorCases,
  wikiPages,
} from '../../db/schema.js';
import {
  DrugMergeBlockedError,
  DrugMergeClassMismatchError,
  DrugMergeDataConflictError,
  UnresolvedDrugMergeConflictError,
  buildDrugMergePlan,
  detectApplicabilityBlockers,
  detectDataConflicts,
  detectSingleValueConflicts,
  loadDrugSideInfo,
  mergeDrugs,
  suggestWinner,
  type DrugMergeResolutions,
} from '../../api/_lib/drug-merge.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import { ensureDrugMonograph } from '../../api/_lib/monograph-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedBioEntity, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});

afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

/** Run the fold the way the endpoint does — inside a pooled transaction, using
 *  the transaction-scoped handle from getDb() (NOT the base test db) so the
 *  advisory lock and the fold's own writes stay on one connection, which the
 *  per-drug lock in mergeDrugs requires. */
function merge(params: {
  winnerId: number;
  loserId: number;
  resolutions: DrugMergeResolutions;
  actorUserId: number;
  approvedPlanFingerprint?: string | null;
}) {
  const { approvedPlanFingerprint = null, ...rest } = params;
  return runInPoolTransaction(() =>
    mergeDrugs(getDb(), { ...rest, approvedPlanFingerprint }),
  );
}

/** Load both sides and call `detectDataConflicts`, mirroring how the endpoint
 *  and `mergeDrugs` invoke it now that it takes `DrugSideInfo` rather than
 *  ids. Tests care about the conflict list; loading is boilerplate. */
async function dataConflictsFor(winnerId: number, loserId: number) {
  const [winner, loser] = await Promise.all([
    loadDrugSideInfo(db, winnerId),
    loadDrugSideInfo(db, loserId),
  ]);
  return detectDataConflicts(db, winner!, loser!);
}

async function giveMonographContent(drugId: number): Promise<void> {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Real monograph prose.' }] },
    ],
  };
  await db
    .update(wikiPages)
    .set({ content: doc as never, contentPlaintext: 'Real monograph prose.' })
    .where(and(eq(wikiPages.pageType, 'drug_monograph'), eq(wikiPages.drugCid, drugId)));
}

describe('drug merge', () => {
  it('keeps the entry with a monograph and folds the duplicate into it', async () => {
    // Winner: MHD with a written monograph. Loser: the duplicate MHD stub.
    const winnerId = await seedDrug(db, { slug: 'mhd', names: { nb: 'MHD', en: 'MHD' } });
    const loserId = await seedDrug(db, {
      slug: 'mhd-dup',
      names: { nb: 'Monohydroksyderivat', en: 'MHD (duplicate)' },
      popularityScore: 5,
    });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'MHD' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'MHD dup' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId);

    // A conflicting curated parameter (both hold proteinBinding) and one only the
    // loser holds (logP moves cleanly).
    await db.insert(drugParameters).values([
      { drugId: winnerId, parameter: 'proteinBinding', value: { value: 0.4 } as never, updatedBy: userId },
      { drugId: loserId, parameter: 'proteinBinding', value: { value: 0.6 } as never, updatedBy: userId },
      { drugId: loserId, parameter: 'logP', value: { value: 1.2 } as never, updatedBy: userId },
    ]);

    // Source entries on the loser (additive — always move).
    await db.insert(parameterEntries).values([
      { drugId: loserId, parameter: 'halfLife', unit: 'h', low: '8', high: '10', median: '9', origin: 'legacy', createdBy: userId },
    ]);

    // Rettstoks method memberships: M1 has both (dedupe), M2 only the loser (move).
    const [m1] = await db.insert(analyticalMethods).values({ code: 'M1', name: 'Panel 1' }).returning({ id: analyticalMethods.id });
    const [m2] = await db.insert(analyticalMethods).values({ code: 'M2', name: 'Panel 2' }).returning({ id: analyticalMethods.id });
    await db.insert(analyticalMethodComponents).values([
      { methodId: m1!.id, drugId: winnerId },
      { methodId: m1!.id, drugId: loserId },
      { methodId: m2!.id, drugId: loserId },
    ]);

    // Metabolite edge (loser is a parent) and precursor edge (another drug lists
    // the loser as its metabolite — the "link to the page about to be deleted").
    const childId = await seedDrug(db, { slug: 'child', names: { nb: 'Barn' } });
    const parentId = await seedDrug(db, { slug: 'parent', names: { nb: 'Forelder' } });
    await db.insert(drugMetabolites).values([
      { parentDrugId: loserId, metaboliteDrugId: childId, metaboliteName: 'Barn' },
      { parentDrugId: parentId, metaboliteDrugId: loserId, metaboliteName: 'MHD dup' },
    ]);

    // A RESTRICT-bound reference atlas exposure naming the loser.
    const citationId = await seedAdmissibleCitation(db, { type: 'pmid', identifier: '111', createdBy: userId });
    const [cohort] = await db
      .insert(patternReferenceCohorts)
      .values({
        citationId,
        name: 'C',
        cohortType: 'controlled_single_dose',
        timeOrigin: 'declared_exposure',
        sourceDatasetHash: 'sha256:x',
        importerVersion: '1.0.0',
        transformationVersion: '1.0.0',
        authorizedBy: userId,
      })
      .returning({ id: patternReferenceCohorts.id });
    const [refCase] = await db
      .insert(patternReferenceCases)
      .values({ cohortId: cohort!.id, sourceSubjectKey: 's1', sourceLocator: 'T1' })
      .returning({ id: patternReferenceCases.id });
    await db.insert(patternReferenceExposures).values({
      caseId: refCase!.id,
      drugId: loserId,
      certainty: 'confirmed',
      sourceLocator: 'T1',
    });
    // An observation naming the loser *and a method the loser is a member of* —
    // the composite-FK (method_id, drug_id) path. m2 is loser-only (the "move"
    // case), which is the one that dangles if the component is repointed before
    // the observation.
    const [specimen] = await db
      .insert(patternReferenceSpecimens)
      .values({ caseId: refCase!.id, matrix: 'whole_blood', sourceLocator: 'T1' })
      .returning({ id: patternReferenceSpecimens.id });
    await db.insert(patternReferenceObservations).values({
      specimenId: specimen!.id,
      drugId: loserId,
      analyticalMethodId: m2!.id,
      qualifier: 'quantified',
      value: '5',
      unit: 'ng/mL',
      sourceLocator: 'T1',
    });

    // A topic page linking to the loser's monograph, by both href shapes.
    const loserSide = await loadDrugSideInfo(db, loserId);
    const loserMonoSlug = loserSide!.monograph!.slug;
    await db.insert(wikiPages).values({
      slug: 'topic-links',
      title: 'Links',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'id', marks: [{ type: 'link', attrs: { href: `/wiki/drug/${loserId}` } }] },
            { type: 'text', text: 'slug', marks: [{ type: 'link', attrs: { href: `/wiki/${loserMonoSlug}` } }] },
          ] },
        ],
      } as never,
      contentHtml: `<a href="/wiki/drug/${loserId}">id</a> <a href="/wiki/${loserMonoSlug}">slug</a>`,
      pageType: 'topic',
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });

    // ── Plan: the monograph rule picks the winner, and proteinBinding is the
    //    one conflict surfaced. ──
    const a = await loadDrugSideInfo(db, winnerId);
    const b = await loadDrugSideInfo(db, loserId);
    const suggestion = suggestWinner(a!, b!);
    expect(suggestion.winner.id).toBe(winnerId);
    expect(suggestion.byMonograph).toBe(true);

    const plan = await buildDrugMergePlan(db, suggestion.winner, suggestion.loser, suggestion);
    expect(plan.conflicts.map((c) => c.id)).toEqual(['parameter:proteinBinding']);
    expect(plan.counts.methodMembershipsMoved).toBe(1);
    expect(plan.counts.methodMembershipsDeduped).toBe(1);
    expect(plan.counts.wikiPagesRelinked).toBe(1);
    expect(plan.counts.atlasRows).toBe(2);

    // ── Apply: keep the loser's proteinBinding value. ──
    const stats = await merge({
      winnerId,
      loserId,
      resolutions: { 'parameter:proteinBinding': 'loser' },
      actorUserId: userId,
    });
    expect(stats.loserMonographDeleted).toBe(true);

    // Loser drug and its monograph are gone.
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(0);
    expect(
      (await db.select().from(wikiPages).where(eq(wikiPages.slug, loserMonoSlug))).length,
    ).toBe(0);

    // proteinBinding resolved to the loser's value; logP moved; only one row each.
    const winnerParams = await db.select().from(drugParameters).where(eq(drugParameters.drugId, winnerId));
    const pb = winnerParams.find((p) => p.parameter === 'proteinBinding');
    expect(pb?.value).toEqual({ value: 0.6 });
    expect(winnerParams.some((p) => p.parameter === 'logP')).toBe(true);
    // No orphan rows left pointing at the loser.
    expect((await db.select().from(drugParameters).where(eq(drugParameters.drugId, loserId))).length).toBe(0);

    // Entries moved.
    expect((await db.select().from(parameterEntries).where(eq(parameterEntries.drugId, winnerId))).length).toBe(1);

    // Method memberships: winner in M1 (once) and M2; loser gone.
    const winnerMethods = (
      await db.select().from(analyticalMethodComponents).where(eq(analyticalMethodComponents.drugId, winnerId))
    ).map((r) => r.methodId).sort();
    expect(winnerMethods).toEqual([m1!.id, m2!.id].sort());
    expect((await db.select().from(analyticalMethodComponents).where(eq(analyticalMethodComponents.drugId, loserId))).length).toBe(0);

    // Metabolite + precursor edges repointed to the winner.
    expect((await db.select().from(drugMetabolites).where(eq(drugMetabolites.parentDrugId, winnerId))).length).toBe(1);
    expect((await db.select().from(drugMetabolites).where(eq(drugMetabolites.metaboliteDrugId, winnerId))).length).toBe(1);
    expect((await db.select().from(drugMetabolites).where(eq(drugMetabolites.parentDrugId, loserId))).length).toBe(0);
    expect((await db.select().from(drugMetabolites).where(eq(drugMetabolites.metaboliteDrugId, loserId))).length).toBe(0);

    // Atlas exposure + observation repointed (the RESTRICT keys would have
    // blocked the delete, and the observation's composite method-component FK
    // would have blocked repointing the method membership).
    expect((await db.select().from(patternReferenceExposures).where(eq(patternReferenceExposures.drugId, winnerId))).length).toBe(1);
    const winnerObs = await db.select().from(patternReferenceObservations).where(eq(patternReferenceObservations.drugId, winnerId));
    expect(winnerObs.length).toBe(1);
    expect(winnerObs[0]!.analyticalMethodId).toBe(m2!.id);

    // Links to the deleted page now point at the winner.
    const [topic] = await db.select().from(wikiPages).where(eq(wikiPages.slug, 'topic-links'));
    const winnerSide = await loadDrugSideInfo(db, winnerId);
    const html = topic!.contentHtml ?? '';
    expect(html).toContain(`/wiki/drug/${winnerId}`);
    expect(html).toContain(`/wiki/${winnerSide!.monograph!.slug}`);
    expect(html).not.toContain(`/wiki/drug/${loserId}`);

    // The loser's names are preserved as aliases so the merged entry is still
    // findable by the old spelling.
    const [winnerRow] = await db.select().from(drugs).where(eq(drugs.id, winnerId));
    expect(winnerRow!.aliases).toContain('Monohydroksyderivat');
    // Popularity folded in.
    expect(winnerRow!.popularityScore).toBe(5);
  });

  it('lets the admin override the monograph-suggested winner', async () => {
    const withMono = await seedDrug(db, { slug: 'a', names: { nb: 'A' } });
    const without = await seedDrug(db, { slug: 'b', names: { nb: 'B' } });
    await ensureDrugMonograph(db, { id: withMono, names: { nb: 'A' }, pubchemCid: null }, userId);
    await giveMonographContent(withMono);

    const a = await loadDrugSideInfo(db, withMono);
    const b = await loadDrugSideInfo(db, without);
    expect(suggestWinner(a!, b!).winner.id).toBe(withMono);

    // Override: keep `without` instead.
    const conflicts = await detectSingleValueConflicts(db, without, withMono);
    expect(conflicts).toEqual([]);
    await merge({ winnerId: without, loserId: withMono, resolutions: {}, actorUserId: userId });
    expect((await db.select().from(drugs).where(eq(drugs.id, withMono))).length).toBe(0);
    expect((await db.select().from(drugs).where(eq(drugs.id, without))).length).toBe(1);
  });

  it('refuses a merge that would fold a value beside a not-applicable marker', async () => {
    const winnerId = await seedDrug(db, { slug: 'w', names: { nb: 'W' } });
    const loserId = await seedDrug(db, { slug: 'l', names: { nb: 'L' } });
    // Winner marks bioavailability not-applicable; loser has a value for it.
    await db.insert(drugParameterApplicability).values({
      drugId: winnerId,
      parameter: 'bioavailability',
      status: 'not_applicable',
      reason: 'metabolite',
      setBy: userId,
    });
    await db.insert(drugParameters).values({
      drugId: loserId,
      parameter: 'bioavailability',
      value: { value: 0.5 } as never,
      updatedBy: userId,
    });

    const blockers = await detectApplicabilityBlockers(db, winnerId, loserId);
    expect(blockers).toEqual([{ parameter: 'bioavailability', reason: 'marker_vs_value' }]);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeBlockedError);
    // Nothing was folded — both drugs still exist.
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(1);
  });

  it('refuses a value the surviving substance class forbids', async () => {
    // Both metabolites — no class mismatch — but the loser has a value that
    // the metabolite class declares undefined (bioavailability needs a dose OF
    // this substance).
    const winnerId = await seedDrug(db, { slug: 'w2', names: { nb: 'W2' }, substanceClass: 'metabolite' });
    const loserId = await seedDrug(db, { slug: 'l2', names: { nb: 'L2' }, substanceClass: 'metabolite' });
    await db.insert(drugParameters).values({
      drugId: loserId,
      parameter: 'bioavailability',
      value: { value: 0.7 } as never,
      updatedBy: userId,
    });
    const blockers = await detectApplicabilityBlockers(db, winnerId, loserId);
    expect(blockers).toEqual([{ parameter: 'bioavailability', reason: 'substance_class' }]);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeBlockedError);
  });

  it('refuses a merge whose two entries disagree on substance_class', async () => {
    const winnerId = await seedDrug(db, { slug: 'clw', names: { nb: 'CLW' }, substanceClass: 'drug' });
    const loserId = await seedDrug(db, { slug: 'cll', names: { nb: 'CLL' }, substanceClass: 'metabolite' });
    // No parameters — the check must fire on class alone, regardless of whether
    // any specific value would be forbidden.
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeClassMismatchError);
    // Nothing folded — both drugs and their monographs still exist.
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(1);
  });

  it('refuses a conflict with no explicit resolution (post-preflight race guard)', async () => {
    const winnerId = await seedDrug(db, { slug: 'w3', names: { nb: 'W3' } });
    const loserId = await seedDrug(db, { slug: 'l3', names: { nb: 'L3' } });
    await db.insert(drugParameters).values([
      { drugId: winnerId, parameter: 'halfLife', value: { value: 1 } as never, updatedBy: userId },
      { drugId: loserId, parameter: 'halfLife', value: { value: 2 } as never, updatedBy: userId },
    ]);
    // Resolutions omit the halfLife conflict — mergeDrugs must refuse, not
    // silently default to the winner and drop the loser's value.
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(UnresolvedDrugMergeConflictError);
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(1);
  });

  it('treats an editor-saved empty doc as an empty monograph', async () => {
    // TipTap canonicalizes an empty document to `{doc: [paragraph]}`. The old
    // length-based check counted this as content and would have picked the
    // wrong survivor if the other side was still `{doc: []}`.
    const empty = await seedDrug(db, { slug: 'e', names: { nb: 'E' }, popularityScore: 100 });
    const withReal = await seedDrug(db, { slug: 'r', names: { nb: 'R' }, popularityScore: 0 });
    await ensureDrugMonograph(db, { id: empty, names: { nb: 'E' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: withReal, names: { nb: 'R' }, pubchemCid: null }, userId);
    // Simulate a saved-then-emptied editor doc on the "empty" side.
    await db
      .update(wikiPages)
      .set({
        content: { type: 'doc', content: [{ type: 'paragraph' }] } as never,
        contentPlaintext: '',
      })
      .where(and(eq(wikiPages.pageType, 'drug_monograph'), eq(wikiPages.drugCid, empty)));
    await giveMonographContent(withReal);

    const a = await loadDrugSideInfo(db, empty);
    const b = await loadDrugSideInfo(db, withReal);
    // The real-content side must win, despite lower popularity.
    expect(suggestWinner(a!, b!).winner.id).toBe(withReal);
  });

  it('preserves complementary evidence when receptor-target rows collide', async () => {
    const winnerId = await seedDrug(db, { slug: 'rw', names: { nb: 'RW' } });
    const loserId = await seedDrug(db, { slug: 'rl', names: { nb: 'RL' } });
    const receptorId = await seedBioEntity(db, { slug: 'r1', symbol: 'R1', name: 'Receptor 1' });
    // Same identity (drug, entity, interactionType) — but only the winner has a
    // Ki, and only the loser has the IC50 + assaySpecies + a differing note.
    // A blind dedupe would drop the loser's fields; the merge must fill in
    // the winner's blanks from the loser.
    await db.insert(drugReceptorTargets).values([
      {
        drugId: winnerId,
        bioEntityId: receptorId,
        interactionType: 'agonist',
        ki: { min: 1, max: 2 } as never,
        evidenceNote: 'winner note',
        referenceIds: [10, 20],
      },
      {
        drugId: loserId,
        bioEntityId: receptorId,
        interactionType: 'agonist',
        ic50: { min: 3, max: 4 } as never,
        assaySpecies: 'Homo sapiens',
        evidenceNote: 'loser note',
        referenceIds: [20, 30],
      },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [survivor] = await db
      .select()
      .from(drugReceptorTargets)
      .where(eq(drugReceptorTargets.drugId, winnerId));
    expect(survivor!.ki).toEqual({ min: 1, max: 2 });
    // IC50 came from the loser — the field was NULL on the winner.
    expect(survivor!.ic50).toEqual({ min: 3, max: 4 });
    expect(survivor!.assaySpecies).toBe('Homo sapiens');
    // References unioned in first-seen order.
    expect(survivor!.referenceIds).toEqual([10, 20, 30]);
    // Differing notes concatenated rather than one dropped.
    expect(survivor!.evidenceNote).toContain('winner note');
    expect(survivor!.evidenceNote).toContain('loser note');
    // No orphan loser row.
    expect(
      (await db.select().from(drugReceptorTargets).where(eq(drugReceptorTargets.drugId, loserId))).length,
    ).toBe(0);
  });

  it('refuses when analytical-method components disagree on forensic figures', async () => {
    const winnerId = await seedDrug(db, { slug: 'mw', names: { nb: 'MW' } });
    const loserId = await seedDrug(db, { slug: 'ml', names: { nb: 'ML' } });
    const [method] = await db.insert(analyticalMethods).values({ code: 'MX', name: 'Panel X' }).returning({ id: analyticalMethods.id });
    await db.insert(analyticalMethodComponents).values([
      { methodId: method!.id, drugId: winnerId, lor: 0.1, unit: 'µg/L' },
      { methodId: method!.id, drugId: loserId, lor: 0.2, unit: 'µg/L' }, // different LOR
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.table).toBe('analytical_method_components');
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
    // Nothing was folded — both drugs still exist.
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(1);
  });

  it('rewrites saved simulator cases pointing at the loser', async () => {
    const winnerId = await seedDrug(db, { slug: 'sw', names: { nb: 'SW' }, pubchemCid: 200 });
    const loserId = await seedDrug(db, { slug: 'sl', names: { nb: 'SL' }, pubchemCid: 100 });
    // Forward-simulator case naming the loser by pubchemCid.
    await db.insert(simulatorCases).values({
      name: 'forward',
      caseData: { drugs: [{ drugId: '100', dose: 5 }] } as never,
      createdBy: userId,
    });
    // KineLab case naming the loser by slug.
    await db.insert(simulatorCases).values({
      name: 'kinelab',
      caseData: { kind: 'kinelab-case', input: { analyte: 'sl' } } as never,
      createdBy: userId,
    });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const cases = await db.select().from(simulatorCases);
    const fwd = cases.find((c) => c.name === 'forward')!;
    const kin = cases.find((c) => c.name === 'kinelab')!;
    expect((fwd.caseData as { drugs: { drugId: string }[] }).drugs[0]!.drugId).toBe('200');
    expect(
      (kin.caseData as { input: { analyte: string } }).input.analyte,
    ).toBe('sw');
  });

  it('rewrites saved simulator cases for a CID-less loser under both key spellings (#1256)', async () => {
    // A CID-less drug's cases were always keyed by its bare internal id
    // before #1256, and are keyed `drug:<id>` afterwards. Both can exist for
    // the same drug at once, so the merge has to find and rewrite both.
    const winnerId = await seedDrug(db, { slug: 'ckw', names: { nb: 'CKW' }, pubchemCid: 300 });
    const loserId = await seedDrug(db, { slug: 'ckl', names: { nb: 'CKL' } });
    await db.insert(simulatorCases).values({
      name: 'legacy-bare',
      caseData: { drugs: [{ drugId: String(loserId), dose: 5 }] } as never,
      createdBy: userId,
    });
    await db.insert(simulatorCases).values({
      name: 'prefixed',
      caseData: { drugs: [{ drugId: `drug:${loserId}`, dose: 7 }] } as never,
      createdBy: userId,
    });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const cases = await db.select().from(simulatorCases);
    const legacy = cases.find((c) => c.name === 'legacy-bare')!;
    const prefixed = cases.find((c) => c.name === 'prefixed')!;
    expect((legacy.caseData as { drugs: { drugId: string }[] }).drugs[0]!.drugId).toBe('300');
    expect((prefixed.caseData as { drugs: { drugId: string }[] }).drugs[0]!.drugId).toBe('300');
  });

  it('refuses when receptor-target rows disagree on non-null measurements', async () => {
    const winnerId = await seedDrug(db, { slug: 'rdw', names: { nb: 'RDW' } });
    const loserId = await seedDrug(db, { slug: 'rdl', names: { nb: 'RDL' } });
    const receptorId = await seedBioEntity(db, { slug: 'r2', symbol: 'R2', name: 'Receptor 2' });
    await db.insert(drugReceptorTargets).values([
      // Both have a Ki, but they disagree — a silent COALESCE would keep the
      // winner's number and attach the loser's citation to it.
      { drugId: winnerId, bioEntityId: receptorId, interactionType: 'agonist', ki: { min: 1, max: 2 } as never, referenceIds: [10] },
      { drugId: loserId, bioEntityId: receptorId, interactionType: 'agonist', ki: { min: 5, max: 6 } as never, referenceIds: [20] },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'drug_receptor_targets')).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when both entries hold a pending parameter proposal for one parameter', async () => {
    const winnerId = await seedDrug(db, { slug: 'ppw', names: { nb: 'PPW' } });
    const loserId = await seedDrug(db, { slug: 'ppl', names: { nb: 'PPL' } });
    await db.insert(pendingEdits).values([
      { editType: 'parameter', targetId: winnerId, parameter: 'halfLife', proposedValue: { value: 5 } as never, submittedBy: userId },
      { editType: 'parameter', targetId: loserId, parameter: 'halfLife', proposedValue: { value: 10 } as never, submittedBy: userId },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'pending_edits')).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the loser has an evidence-bearing edge to the winner', async () => {
    const winnerId = await seedDrug(db, { slug: 'sew', names: { nb: 'SEW' } });
    const loserId = await seedDrug(db, { slug: 'sel', names: { nb: 'SEL' } });
    // Loser lists winner as its metabolite with a real conversion fraction.
    // Deleting as a "self-edge" would silently retire the claim.
    await db.insert(drugMetabolites).values({
      parentDrugId: loserId,
      metaboliteDrugId: winnerId,
      metaboliteName: 'winner-as-metabolite',
      conversionFraction: '0.30',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'drug_metabolites' && c.identity.includes('metabolite'))).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the loser monograph has active review-queue proposals', async () => {
    const winnerId = await seedDrug(db, { slug: 'mpw', names: { nb: 'MPW' } });
    const loserId = await seedDrug(db, { slug: 'mpl', names: { nb: 'MPL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'MPW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'MPL' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId);
    const loserSide = await loadDrugSideInfo(db, loserId);
    await db.insert(pendingEdits).values({
      editType: 'wiki_page',
      targetId: loserSide!.monograph!.pageId,
      proposedValue: { title: 'edit' } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'pending_edits' && c.identity.includes('wiki_page'))).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('carries loser-only farmakologiportalen path onto the winner', async () => {
    const winnerId = await seedDrug(db, { slug: 'ppw', names: { nb: 'PPW' } });
    const loserId = await seedDrug(db, { slug: 'ppl', names: { nb: 'PPL' }, farmakologiportalenPath: '/content/999/Foo' });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [survivor] = await db.select().from(drugs).where(eq(drugs.id, winnerId));
    expect(survivor!.farmakologiportalenPath).toBe('/content/999/Foo');
  });

  it('drops identical parameter_entries before repointing to avoid double-counting', async () => {
    const winnerId = await seedDrug(db, { slug: 'dw', names: { nb: 'DW' } });
    const loserId = await seedDrug(db, { slug: 'dl', names: { nb: 'DL' } });
    // Same observation on both — same source, unit, matrix, low/high/median.
    // A blind repoint would leave two rows on the winner and skew aggregates.
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db.select().from(parameterEntries).where(eq(parameterEntries.drugId, winnerId));
    // Only one row survives — the duplicate was dropped.
    expect(rows.length).toBe(1);
  });

  // The dedup identity does not include `source_quote`, so a loser row that
  // matches on every compared field is deleted — and its quote goes with it.
  // That is the one piece of an entry nobody can reconstruct.
  it('promotes a loser’s source quote onto a survivor that has none', async () => {
    const winnerId = await seedDrug(db, { slug: 'qw', names: { nb: 'QW' } });
    const loserId = await seedDrug(db, { slug: 'ql', names: { nb: 'QL' } });
    const quote = 'The mean terminal half-life was 9 h (range 8–10).';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, sourceQuote: quote },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    // Still one row — the dedup is unchanged — but it kept the evidence. Both
    // rows cite the same source for the same numbers, so the loser's quote is
    // evidence for the survivor's claim, not a competing one.
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceQuote).toBe(quote);
  });

  // Two rows, one sentence, two spellings — and the merge must not call that a
  // disagreement.
  //
  // Storage keeps the source's own text on purpose, so whether an accent
  // arrives composed or decomposed is decided by the contributor's keyboard and
  // PDF viewer, not by intent. Comparing the raw bytes refuses the merge over a
  // difference nobody can see, and leaves an operator with two rows that
  // already say the same thing and no way to reconcile them: a dead end, not a
  // safe default. The update already treats these as one sentence; the merge
  // has to agree, or one form is an echo in one place and a conflict in the
  // other.
  it('merges two spellings of one sentence rather than refusing', async () => {
    const winnerId = await seedDrug(db, { slug: 'qw4', names: { nb: 'QW4' } });
    const loserId = await seedDrug(db, { slug: 'ql4', names: { nb: 'QL4' } });
    const sentence = 'La demi-vie terminale était de 9 h.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, sourceQuote: sentence.normalize('NFC') },
      // The same words, as a macOS paste would store them — plus a joiner of
      // the kind a PDF copy routinely carries.
      {
        ...shared,
        drugId: loserId,
        sourceQuote: `${sentence.normalize('NFD')}\u200D`,
      },
    ]);

    // No conflict is raised, so the merge runs and the duplicate is deduped.
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceQuote).not.toBeNull();
  });

  // …and the mirror: genuinely different sentences still stop the merge. A
  // comparison loose enough to merge two spellings must not be loose enough to
  // silently drop one of two competing claims.
  it('still refuses when the two rows quote different sentences', async () => {
    const winnerId = await seedDrug(db, { slug: 'qw5', names: { nb: 'QW5' } });
    const loserId = await seedDrug(db, { slug: 'ql5', names: { nb: 'QL5' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        sourceQuote: 'The mean terminal half-life was 9 h.',
      },
      {
        ...shared,
        drugId: loserId,
        sourceQuote: 'Corrected: the mean terminal half-life was 11 h.',
      },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // observation_context (#1257) is evidence a stored quote attests to, so it
  // gets the same one-sided promotion the quote itself does — the dedup
  // identity does not include it either, and a loser row matching on every
  // other field would otherwise be dropped with its context.
  it('promotes a loser’s observation context onto a survivor that has none', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw', names: { nb: 'OCW' } });
    const loserId = await seedDrug(db, { slug: 'ocl', names: { nb: 'OCL' } });
    const context = 'Fasted, single dose, healthy volunteers.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, observationContext: context },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.observationContext).toBe(context);
  });

  // Codex review on PR #1297: nothing forbids two WINNER rows sharing one
  // identity, both with an unknown (NULL) context (no uniqueness
  // constraint). The loser supplies ONE new context. The old
  // "a NULL-context, unquoted winner row exists" gate only checked
  // existence, so with two such rows the promotion UPDATE (no LIMIT) would
  // have written the SAME new context onto BOTH — asserting two distinct
  // unknown readings are actually the same thing on nothing more than one
  // loser row's say-so. Refuse instead; there's no way to say which of the
  // two unknowns the loser's context belongs to.
  it('refuses to promote a new context when the winner has two unknown-context rows', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw13', names: { nb: 'OCW13' } });
    const loserId = await seedDrug(db, { slug: 'ocl13', names: { nb: 'OCL13' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // The dedup identity does not include context, so a WINNER alone can
  // legitimately hold two rows sharing it — a fasted-state row and a
  // fed-state row on the same drug, nothing in the schema stops that. The
  // preflight must judge divergence from the loser's side only: a loser row
  // whose context already matches one of the winner's rows loses nothing by
  // being dropped, even though naively counting distinct context values
  // across the whole group would see two (#1291).
  it('allows the merge when the loser only repeats a context the winner already has', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw6', names: { nb: 'OCW6' } });
    const loserId = await seedDrug(db, { slug: 'ocl6', names: { nb: 'OCL6' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: winnerId, observationContext: 'Fed, single dose.' },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    // The loser's redundant "Fasted" row was dropped; nothing was promoted
    // and nothing was lost — both winner rows survive unchanged.
    expect(rows.length).toBe(2);
    const contexts = rows.map((r) => r.observationContext).sort();
    expect(contexts).toEqual(['Fasted, single dose.', 'Fed, single dose.'].sort());
  });

  // Codex review on PR #1297: the winner also holds a separate NULL-context
  // row here (its context is simply unknown, not "Fasted"). The redundant
  // loser row must still be dropped — but context-promotion must NOT write
  // "Fasted" onto the winner's unknown-context row just because a NULL slot
  // happened to be available: nothing supplied evidence that the unknown
  // reading IS the fasted one, and "Fasted" is already represented by the
  // other winner row regardless.
  it('does not overwrite an unrelated null-context winner row when the loser only repeats a matched context', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw12', names: { nb: 'OCW12' } });
    const loserId = await seedDrug(db, { slug: 'ocl12', names: { nb: 'OCL12' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    const contexts = rows.map((r) => r.observationContext).sort();
    // The unknown-context row must still read as unknown (null), not
    // "Fasted, single dose." — that would assert a reading nobody supplied.
    expect(contexts).toEqual([null, 'Fasted, single dose.'].sort());
  });

  // …and the mirror: two rows with the same numbers from the same source but
  // genuinely different study context are not simply additive commentary —
  // context is what makes a reading THIS reading — so the merge must not
  // silently pick one and discard the other's evidence.
  it('refuses when the two rows state different observation context', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw2', names: { nb: 'OCW2' } });
    const loserId = await seedDrug(db, { slug: 'ocl2', names: { nb: 'OCL2' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: loserId, observationContext: 'Fed, single dose.' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // The pairwise-looking case above is not the only shape: nothing forbids two
  // LOSER rows sharing the same identity (there is no uniqueness constraint on
  // the observation tuple). A winner with no context paired against either
  // loser row individually looks like an ordinary one-sided promotion — the
  // disagreement is only visible across the whole three-row group, which is
  // why the check groups across both drugs rather than comparing pairs.
  it('refuses when the loser alone holds two same-identity rows with different context', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw3', names: { nb: 'OCW3' } });
    const loserId = await seedDrug(db, { slug: 'ocl3', names: { nb: 'OCL3' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: loserId, observationContext: 'Fed, single dose.' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // A one-sided context (one row has it, the other does not) is the ordinary
  // promotion case ON ITS OWN — but not when a quote is already sitting on
  // the NULL-context side. Context-promotion only checks `observation_context
  // IS NULL`, with no regard for whether the row it is about to overwrite
  // already carries a quote — so left unchecked, the winner's Q would end up
  // describing the loser's context C, though Q was never read against C.
  it('refuses when a quoted row and a contextless row would otherwise merge silently (winner quoted)', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw4', names: { nb: 'OCW4' } });
    const loserId = await seedDrug(db, { slug: 'ocl4', names: { nb: 'OCL4' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, sourceQuote: 'The mean terminal half-life was 9 h.' },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // …and the mirror allocation: a quoted, contextless LOSER paired against a
  // contextful, unquoted winner. Context-aware quote-promotion correctly
  // refuses to move the quote onto a differently-described winner, but
  // without this check the plain dedup would then delete the loser — and its
  // quote — with no conflict ever raised.
  it('refuses when a quoted row and a contextless row would otherwise merge silently (loser quoted)', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw5', names: { nb: 'OCW5' } });
    const loserId = await seedDrug(db, { slug: 'ocl5', names: { nb: 'OCL5' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: loserId, sourceQuote: 'The mean terminal half-life was 9 h.' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Codex review on PR #1297 (fixing #1291) found three ways an earlier
  // version of the observation_context check could still lose or misattach
  // data despite passing every case above. Each of the next three tests
  // reproduces one of those findings directly, so a future change to this
  // predicate cannot silently reintroduce any of them.

  // Finding 1: the winner has a single NULL-context, unquoted row (a safe-
  // looking receiver), and the loser holds BOTH a contextful row and a
  // separate NULL-context row carrying a quote. Context-promotion consumes
  // the winner's only NULL slot for the contextful loser row first; by the
  // time quote-promotion runs, no NULL-context winner row is left to match
  // the quoted loser row, so its quote would be silently dropped.
  it('refuses when promoting the loser’s new context would strand a different quoted null-context loser row', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw7', names: { nb: 'OCW7' } });
    const loserId = await seedDrug(db, { slug: 'ocl7', names: { nb: 'OCL7' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
      {
        ...shared,
        drugId: loserId,
        sourceQuote: 'The mean terminal half-life was 9 h.',
      },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Finding 2 (as originally filed) said: the winner already holds a
  // matching context (A) plus a separate NULL-context, QUOTED row; the
  // loser only repeats A, so nothing is "unmatched" — but the
  // context-promotion UPDATE overwrites every NULL-context winner row
  // unconditionally whenever the loser holds any non-null context at all,
  // matched or not, silently reattaching the winner's existing quote to a
  // context it was never checked against. That was true when this test was
  // written. It stopped being true once context-promotion grew its own
  // `NOT EXISTS` guard (Codex review on PR #1297's 'unrelated winner
  // quote' finding, applied a few commits later): a REDUNDANT
  // (already-matched) value is now skipped for every NULL-context winner
  // row in the group, so the quoted row here is never touched at all — a
  // later Codex finding on this same PR caught that this test (and the
  // matching refusal clause) had gone stale. Updated to assert the
  // corrected behavior: the merge proceeds, and the quoted NULL-context row
  // survives completely untouched.
  it('allows the merge when the loser only repeats a matched context, leaving a quoted null-context winner row untouched', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw8', names: { nb: 'OCW8' } });
    const loserId = await seedDrug(db, { slug: 'ocl8', names: { nb: 'OCL8' } });
    const quote = 'The mean terminal half-life was 9 h.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: winnerId, sourceQuote: quote },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    const nullRow = rows.find((r) => r.observationContext === null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.sourceQuote).toBe(quote);
    const fastedRow = rows.find((r) => r.observationContext === 'Fasted, single dose.');
    expect(fastedRow).toBeDefined();
    expect(fastedRow!.sourceQuote).toBeNull();
  });

  // Finding 3: the winner holds context A plus a NULL-context row; the loser
  // holds an earlier (lower-id) row repeating A and a later (higher-id) row
  // with a genuinely new context C. C is the only "unmatched" value and a
  // NULL-context winner row exists to receive it — but the actual promotion
  // query picks whichever non-null-context loser row has the SMALLEST id
  // (here, the A row), not the unmatched one, so C would be silently
  // discarded by the final dedup delete while a redundant A gets promoted
  // instead.
  it('refuses when the promotion would pick a lower-id matched loser row over the genuinely new one', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw9', names: { nb: 'OCW9' } });
    const loserId = await seedDrug(db, { slug: 'ocl9', names: { nb: 'OCL9' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: winnerId },
    ]);
    // Inserted as two separate statements so the 'Fasted' (matched) loser row
    // is guaranteed the lower id and the 'Fed' (unmatched) row the higher one
    // — the exact ordering the promotion query's `ORDER BY l.id` depends on.
    await db
      .insert(parameterEntries)
      .values([{ ...shared, drugId: loserId, observationContext: 'Fasted, single dose.' }]);
    await db
      .insert(parameterEntries)
      .values([{ ...shared, drugId: loserId, observationContext: 'Fed, single dose.' }]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Finding 4: the winner has a NULL-context, UNQUOTED row plus a separate,
  // quoted A-context row. The loser has a lower-id NULL-context row quoted
  // with the SAME text as the winner's A-context quote, plus a higher-id
  // B-context row also quoted with that text. B is the only unmatched value
  // and a NULL-context, unquoted winner row exists to receive it — but an
  // earlier version of this check treated "the winner already carries a
  // quote somewhere" as proof nothing could be lost. It cannot be: context-
  // promotion fills the winner's NULL row with B, then quote-promotion picks
  // the lowest-id quoted loser row (the NULL-context one) and finds no
  // NULL-context winner row left to match it, so that association is
  // dropped and the B-context row is promoted with no quote of its own, even
  // though a loser row explicitly quoted B.
  it('refuses when an unrelated winner quote would wrongly excuse losing a loser’s null-context quote', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw10', names: { nb: 'OCW10' } });
    const loserId = await seedDrug(db, { slug: 'ocl10', names: { nb: 'OCL10' } });
    const quote = 'The mean terminal half-life was 9 h.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.', sourceQuote: quote },
    ]);
    // Inserted as two separate statements so the NULL-context loser row is
    // guaranteed the lower id and the 'Fed' (unmatched) row the higher one —
    // the exact ordering quote-promotion's `ORDER BY l.id` depends on.
    await db.insert(parameterEntries).values([{ ...shared, drugId: loserId, sourceQuote: quote }]);
    await db
      .insert(parameterEntries)
      .values([
        { ...shared, drugId: loserId, observationContext: 'Fed, single dose.', sourceQuote: quote },
      ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Finding 5: both drugs already carry contexts A and B (winner rows
  // unquoted), so `unmatched` is empty and the merge looks safe on context
  // alone. But BOTH loser rows — one under A, one under B — carry the same
  // quote text, and quote-promotion picks at most one loser row per group
  // (its `DISTINCT ON` key excludes context, so it never picks per-context),
  // so only one of the two context-to-quote associations survives; the other
  // loser row is deleted along with its quote, with no conflict raised by
  // either this check (unmatched is empty) or the separate source_quote
  // branch below (it sees only one distinct quote text, not a disagreement).
  it('refuses when the loser holds a quote under two different already-matched contexts', async () => {
    const winnerId = await seedDrug(db, { slug: 'ocw11', names: { nb: 'OCW11' } });
    const loserId = await seedDrug(db, { slug: 'ocl11', names: { nb: 'OCL11' } });
    const quote = 'The mean terminal half-life was 9 h.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, observationContext: 'Fasted, single dose.' },
      { ...shared, drugId: winnerId, observationContext: 'Fed, single dose.' },
      { ...shared, drugId: loserId, observationContext: 'Fasted, single dose.', sourceQuote: quote },
      { ...shared, drugId: loserId, observationContext: 'Fed, single dose.', sourceQuote: quote },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Promoting the quote is a direct write to a row that SURVIVES the merge, so
  // a proposal queued against it was reviewed when the entry had none. Approved
  // afterwards, its update can clear the sentence just preserved and its delete
  // can remove the row — with the review token still valid, because the
  // proposal itself did not change. The preflight only refuses proposals
  // against loser rows, which are the ones about to disappear.
  it('conflicts a pending proposal against a survivor it quotes', async () => {
    const winnerId = await seedDrug(db, { slug: 'qw3', names: { nb: 'QW3' } });
    const loserId = await seedDrug(db, { slug: 'ql3', names: { nb: 'QL3' } });
    const quote = 'The mean terminal half-life was 9 h (range 8–10).';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    const inserted = await db
      .insert(parameterEntries)
      .values([
        { ...shared, drugId: winnerId },
        { ...shared, drugId: loserId, sourceQuote: quote },
      ])
      .returning({ id: parameterEntries.id, drugId: parameterEntries.drugId });
    const survivor = inserted.find((r) => r.drugId === winnerId)!;

    const [proposal] = await db
      .insert(pendingEdits)
      .values({
        editType: 'param_entry',
        targetId: survivor.id,
        parameter: 'halfLife',
        proposedValue: {
          op: 'update',
          patch: { median: 9, unit: 'h', quote: null },
        } as never,
        status: 'pending',
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const [after] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, proposal!.id));
    expect(
      (after!.proposedMeta as Record<string, unknown> | null)?.conflict,
    ).toBeTruthy();
  });

  it('leaves the survivor’s own quote alone when it already has one', async () => {
    const winnerId = await seedDrug(db, { slug: 'qw2', names: { nb: 'QW2' } });
    const loserId = await seedDrug(db, { slug: 'ql2', names: { nb: 'QL2' } });
    const winnerQuote = 'Terminal half-life: 9 h.';
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, sourceQuote: winnerQuote },
      { ...shared, drugId: loserId },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceQuote).toBe(winnerQuote);
  });

  // Two DIFFERENT sentences quoted from the same document for the same numbers
  // is not a merge decision — it means one of them is reading the wrong
  // sentence, which is the precise error a stored quote exists to expose.
  // Picking one silently would bury it. Refuse, as `comments` already does.
  it('refuses a merge where the two rows quote different text', async () => {
    const winnerId = await seedDrug(db, { slug: 'qc1', names: { nb: 'QC1' } });
    const loserId = await seedDrug(db, { slug: 'qc2', names: { nb: 'QC2' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, sourceQuote: 'Terminal half-life was 9 h.' },
      { ...shared, drugId: loserId, sourceQuote: 'Half-life after a single dose was 9 h.' },
    ]);

    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'parameter_entries' && c.identity.includes('quote'),
      ),
    ).toBe(true);
  });

  // The dedup deletes every matching loser row at once and promotes ONE quote,
  // so a pairwise winner-vs-loser test is the wrong shape: with an unquoted
  // winner and two same-identity loser rows quoting different sentences, no
  // pair looks like a disagreement, one quote is promoted arbitrarily and the
  // other is deleted with its row. Nothing in the schema forbids those two
  // rows — there is no uniqueness constraint on the observation tuple.
  it('refuses when two loser rows quote different text and the winner has none', async () => {
    const winnerId = await seedDrug(db, { slug: 'qg1', names: { nb: 'QG1' } });
    const loserId = await seedDrug(db, { slug: 'qg2', names: { nb: 'QG2' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, sourceQuote: 'Terminal half-life was 9 h.' },
      {
        ...shared,
        drugId: loserId,
        sourceQuote: 'Half-life after a single dose was 9 h.',
      },
    ]);

    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'parameter_entries' && c.identity.includes('quote'),
      ),
    ).toBe(true);
  });

  it('does not report a conflict when only one side has a quote', async () => {
    const winnerId = await seedDrug(db, { slug: 'qc3', names: { nb: 'QC3' } });
    const loserId = await seedDrug(db, { slug: 'qc4', names: { nb: 'QC4' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId },
      { ...shared, drugId: loserId, sourceQuote: 'Terminal half-life was 9 h.' },
    ]);

    const conflicts = await dataConflictsFor(winnerId, loserId);
    // A one-sided quote is not a disagreement — it is a row that has one and a
    // row that does not, and the dedup promotes it. Refusing here would block
    // routine merges for no benefit, which is the common case now that most
    // rows predate the field.
    expect(
      conflicts.some(
        (c) => c.table === 'parameter_entries' && c.identity.includes('quote'),
      ),
    ).toBe(false);
  });

  it('promotes winner origin to the strongest loser origin before dedup', async () => {
    // A deep-research importer row on the winner + a human-contributor row on
    // the loser, otherwise identical. A blind dedup would delete the loser
    // and leave only the deep-research row — which `seedParameterEntries`
    // may overwrite on a later import, silently degrading a curated
    // observation into importer-rewritable data. The reconciliation step
    // must promote the winner's origin to `contributor` first.
    const winnerId = await seedDrug(db, { slug: 'ow', names: { nb: 'OW' } });
    const loserId = await seedDrug(db, { slug: 'ol', names: { nb: 'OL' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, origin: 'deep-research' },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({ origin: parameterEntries.origin })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.origin).toBe('contributor');
  });

  // Codex review on PR #1297: the winner holds TWO context rows here (A and
  // B), both deep-research. The loser only repeats A, with origin
  // 'contributor'. Origin promotion must upgrade the A-context row (the one
  // the contributor's row actually attests to) but leave the B-context row
  // at 'deep-research' — no contributor supplied that reading, and treating
  // it as contributor-owned would make it wrongly immune to a later
  // importer reconciliation.
  it('scopes origin promotion to the matching context, not every winner row under the identity', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow2', names: { nb: 'OW2' } });
    const loserId = await seedDrug(db, { slug: 'ol2', names: { nb: 'OL2' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fed, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: loserId,
        observationContext: 'Fasted, single dose.',
        origin: 'contributor',
      },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({
        observationContext: parameterEntries.observationContext,
        origin: parameterEntries.origin,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    const byContext = new Map(rows.map((r) => [r.observationContext, r.origin]));
    expect(byContext.get('Fasted, single dose.')).toBe('contributor');
    expect(byContext.get('Fed, single dose.')).toBe('deep-research');
  });

  // Codex review on PR #1297: the winner's ONLY row for this identity has
  // context A; the loser's otherwise-identical row has NO context recorded
  // at all (unlike the test above, which gives the loser a context of its
  // own). Requiring an exact context match would never promote the origin
  // here — NULL never matches 'Fasted, single dose.' — even though there is
  // exactly one winner row this context-agnostic observation could possibly
  // be about, so the contributor's provenance should transfer.
  it('promotes origin from a context-agnostic loser row onto the sole matching winner row', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow3', names: { nb: 'OW3' } });
    const loserId = await seedDrug(db, { slug: 'ol3', names: { nb: 'OL3' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({
        observationContext: parameterEntries.observationContext,
        origin: parameterEntries.origin,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.observationContext).toBe('Fasted, single dose.');
    expect(rows[0]!.origin).toBe('contributor');
  });

  // Codex review on PR #1297: the sole winner row (context A, deep-research)
  // has TWO eligible loser candidates here — an exact-context 'legacy' row
  // and a separate context-agnostic 'contributor' row (eligible via the
  // sole-winner-row exception above). Both satisfying one flat join
  // predicate let `UPDATE ... FROM` apply them in an unspecified order,
  // risking the weaker 'legacy' origin winning over the stronger
  // 'contributor' one nondeterministically. The winner must end up with the
  // single strongest eligible origin, deterministically.
  it('picks the strongest eligible origin when the loser offers both an exact-context and a context-agnostic candidate', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow6', names: { nb: 'OW6' } });
    const loserId = await seedDrug(db, { slug: 'ol6', names: { nb: 'OL6' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: loserId,
        observationContext: 'Fasted, single dose.',
        origin: 'legacy',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({ origin: parameterEntries.origin })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.origin).toBe('contributor');
  });

  // …and the ambiguous mirror: TWO winner rows (A and B) share the identity,
  // so a context-agnostic loser row's origin cannot be attributed to either
  // one specifically — it must promote onto NEITHER rather than guess. But
  // silently promoting onto neither would, on its own, discard the loser's
  // stronger 'contributor' origin the moment the unconditional dedup delete
  // removes its row (Codex's finding on PR #1297). The preflight must
  // refuse this merge instead of quietly losing that provenance.
  it('refuses when a context-agnostic loser origin is stronger than some ambiguous winner row and cannot be attributed', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow4', names: { nb: 'OW4' } });
    const loserId = await seedDrug(db, { slug: 'ol4', names: { nb: 'OL4' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fed, single dose.',
        origin: 'deep-research',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Codex review on PR #1297: with two NULL-context loser rows of different
  // origins ('legacy' and 'contributor'), the conflict must report the
  // origin its priority calculation actually keyed on ('contributor', the
  // stronger one) — not whichever origin string sorts alphabetically
  // greatest ('legacy' > 'contributor' as text), which would point a
  // curator at the wrong provenance.
  it('reports the priority-selected origin, not the lexicographically greatest one', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow7', names: { nb: 'OW7' } });
    const loserId = await seedDrug(db, { slug: 'ol7', names: { nb: 'OL7' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fed, single dose.',
        origin: 'deep-research',
      },
      { ...shared, drugId: loserId, origin: 'legacy' },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);

    const conflicts = await dataConflictsFor(winnerId, loserId);
    const ambiguous = conflicts.find(
      (c) => c.message.code === 'dataConflict.parameterEntryAmbiguousOrigin',
    );
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.message.params!.loserOrigin).toBe('contributor');
  });

  // Codex review on PR #1297: 2+ winner rows alone don't make a
  // context-agnostic loser row ambiguous — only the ABSENCE of a
  // NULL-context winner row does. Here the winner has a NULL-context
  // 'deep-research' row (an exact, unambiguous receiver) alongside a
  // separate A-context 'contributor' row; the loser's NULL-context
  // 'contributor' row should promote onto the NULL-context winner row only,
  // leaving the A-context row untouched, with no refusal.
  it('allows and correctly targets a context-agnostic loser origin when an exact null-context winner receiver exists', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow8', names: { nb: 'OW8' } });
    const loserId = await seedDrug(db, { slug: 'ol8', names: { nb: 'OL8' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, origin: 'deep-research' },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'contributor',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({
        observationContext: parameterEntries.observationContext,
        origin: parameterEntries.origin,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    const byContext = new Map(rows.map((r) => [r.observationContext, r.origin]));
    expect(byContext.get(null)).toBe('contributor');
    expect(byContext.get('Fasted, single dose.')).toBe('contributor');
  });

  // Codex review on PR #1297: the winner's NULL-context row LOOKS like a
  // safe receiver for the loser's context-agnostic origin — until
  // context-promotion (which runs first) consumes it for an unrelated
  // reason. Winner holds a NULL-context row plus context A; loser holds a
  // NULL-context 'contributor' row AND a genuinely new context B row.
  // detectDataConflicts' observation_context branch allows promoting B (the
  // sole unmatched value, no ambiguity) onto the winner's NULL-context row —
  // which then has context B by the time origin-promotion runs, leaving no
  // NULL-context winner row for the loser's contributor origin to
  // exact-match against. Must refuse rather than silently lose it.
  it('refuses when context-promotion would consume the null-context winner row before origin-promotion can use it', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow9', names: { nb: 'OW9' } });
    const loserId = await seedDrug(db, { slug: 'ol9', names: { nb: 'OL9' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, origin: 'deep-research' },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
      {
        ...shared,
        drugId: loserId,
        observationContext: 'Fed, single dose.',
        origin: 'deep-research',
      },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Codex review on PR #1297: winner context A is 'deep-research' (weak),
  // winner context B is 'contributor' (already strong). Loser holds an
  // exact A-context 'contributor' row AND a NULL-context 'legacy' row.
  // Comparing the NULL-context loser's 'legacy' (3) against the winner's
  // PRE-promotion minimum ('deep-research' A row, 2) looks like a loss —
  // but the exact-context match promotes A to 'contributor' (4)
  // unconditionally, regardless of the NULL-context question, so by the
  // time the merge actually runs BOTH winner rows already end up at 4,
  // stronger than the NULL row's 3. Nothing is lost; the merge must
  // proceed.
  it('allows an ambiguous context-agnostic loser origin once exact-context promotion already strengthens the weak winner row', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow10', names: { nb: 'OW10' } });
    const loserId = await seedDrug(db, { slug: 'ol10', names: { nb: 'OL10' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'deep-research',
      },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fed, single dose.',
        origin: 'contributor',
      },
      {
        ...shared,
        drugId: loserId,
        observationContext: 'Fasted, single dose.',
        origin: 'contributor',
      },
      { ...shared, drugId: loserId, origin: 'legacy' },
    ]);

    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });

    const rows = await db
      .select({
        observationContext: parameterEntries.observationContext,
        origin: parameterEntries.origin,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    const byContext = new Map(rows.map((r) => [r.observationContext, r.origin]));
    expect(byContext.get('Fasted, single dose.')).toBe('contributor');
    expect(byContext.get('Fed, single dose.')).toBe('contributor');
  });

  // Codex review on PR #1297: winner has a NULL-context 'deep-research' row
  // plus an A-context 'contributor' row. Loser has a genuinely NEW
  // B-context 'deep-research' row plus a separate NULL-context
  // 'contributor' row. Scoring the NULL winner row's effective priority
  // via an exact match against its CURRENT (NULL) context finds the
  // loser's NULL-context 'contributor' row and wrongly concludes it scores
  // 4 — but that NULL row is about to be consumed by context-promotion
  // (promoted to context B), and by the time origin-promotion runs the
  // only candidate for it is the weaker B-context 'deep-research' row. The
  // loser's contributor-origin NULL row ends up with no home at all and
  // would be silently discarded. Must refuse.
  it('refuses when a null-context winner row about to be consumed is scored using its pre-promotion context', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow11', names: { nb: 'OW11' } });
    const loserId = await seedDrug(db, { slug: 'ol11', names: { nb: 'OL11' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, origin: 'deep-research' },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'contributor',
      },
      {
        ...shared,
        drugId: loserId,
        observationContext: 'Fed, single dose.',
        origin: 'deep-research',
      },
      { ...shared, drugId: loserId, origin: 'contributor' },
    ]);

    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toThrow();
  });

  // Same ambiguous shape, but the loser's context-agnostic origin is no
  // stronger than either winner row already holds — promoting it would have
  // changed nothing, so there is nothing to lose. The merge proceeds and
  // both winner rows keep their existing (already-as-strong) origin.
  it('allows an ambiguous context-agnostic loser origin that would not have changed anything', async () => {
    const winnerId = await seedDrug(db, { slug: 'ow5', names: { nb: 'OW5' } });
    const loserId = await seedDrug(db, { slug: 'ol5', names: { nb: 'OL5' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fasted, single dose.',
        origin: 'contributor',
      },
      {
        ...shared,
        drugId: winnerId,
        observationContext: 'Fed, single dose.',
        origin: 'contributor',
      },
      { ...shared, drugId: loserId, origin: 'deep-research' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({ origin: parameterEntries.origin })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.origin === 'contributor')).toBe(true);
  });

  it('leaves winner origin alone when it already outranks the loser', async () => {
    const winnerId = await seedDrug(db, { slug: 'os', names: { nb: 'OS' } });
    const loserId = await seedDrug(db, { slug: 'ot', names: { nb: 'OT' } });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: 'plasma',
      low: '8',
      high: '10',
      median: '9',
      createdBy: userId,
    };
    await db.insert(parameterEntries).values([
      { ...shared, drugId: winnerId, origin: 'legacy' },
      { ...shared, drugId: loserId, origin: 'deep-research' },
    ]);
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({ origin: parameterEntries.origin })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.origin).toBe('legacy');
  });

  it('preserves the loser\'s nameShort as a searchable alias', async () => {
    const winnerId = await seedDrug(db, { slug: 'nsw', names: { nb: 'Substance W' } });
    const loserId = await seedDrug(db, { slug: 'nsl', names: { nb: 'Substance L' }, nameShort: 'MHD' });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [survivor] = await db.select().from(drugs).where(eq(drugs.id, winnerId));
    expect(survivor!.aliases).toContain('MHD');
    // The abbreviation is now folded into the search key too (buildSearchKey
    // lower-cases and joins names/nameShort/aliases with tabs).
    expect((survivor!.searchKey ?? '').toLowerCase()).toContain('mhd');
  });

  it('retargets agent_focus_config.page_ids from the loser monograph to the winner', async () => {
    const winnerId = await seedDrug(db, { slug: 'afw', names: { nb: 'AFW' } });
    const loserId = await seedDrug(db, { slug: 'afl', names: { nb: 'AFL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'AFW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'AFL' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId); // ensure monograph rule picks winnerId
    const winnerSide = await loadDrugSideInfo(db, winnerId);
    const loserSide = await loadDrugSideInfo(db, loserId);
    await db.insert(agentFocusConfig).values({
      id: 1,
      mode: 'pages',
      pageIds: [loserSide!.monograph!.pageId, 999] as never,
    });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [config] = await db.select().from(agentFocusConfig).where(eq(agentFocusConfig.id, 1));
    const pageIds = (config!.pageIds as number[]).slice().sort((a, b) => a - b);
    expect(pageIds).toContain(winnerSide!.monograph!.pageId);
    expect(pageIds).not.toContain(loserSide!.monograph!.pageId);
    expect(pageIds).toContain(999);
  });

  it('repoints wiki_new proposed_meta.drugCid onto the winner', async () => {
    // Retargeting the full-replacement kinds (metabolism / receptor_targets /
    // enzyme_interaction) is unsafe — approving one after merge would wipe
    // rows the merge just preserved — so those are refused up front in
    // `detectDataConflicts`. `wiki_new` is a new-monograph proposal keyed by
    // drug id in `proposed_meta.drugCid` and must still repoint so a later
    // approval publishes the monograph on the surviving drug.
    const winnerId = await seedDrug(db, { slug: 'pw', names: { nb: 'PW' } });
    const loserId = await seedDrug(db, { slug: 'pl', names: { nb: 'PL' } });
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      targetId: null,
      proposedValue: { body: 'draft' } as never,
      proposedMeta: { drugCid: loserId, title: 'New page' } as never,
      submittedBy: userId,
    });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [wikiNew] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.editType, 'wiki_new'));
    expect((wikiNew?.proposedMeta as { drugCid: number }).drugCid).toBe(winnerId);
  });

  it('refuses when the plan fingerprint changes between preview and apply', async () => {
    // The scenario the finding fires on: preview shows a conflict as (A vs B),
    // admin approves 'winner' (A), a concurrent writer changes the loser's
    // value to C. Same key → same conflict id → the resolution is retained →
    // C is silently deleted. The stale-plan check catches it.
    const winnerId = await seedDrug(db, { slug: 'sfw', names: { nb: 'SFW' } });
    const loserId = await seedDrug(db, { slug: 'sfl', names: { nb: 'SFL' } });
    await db.insert(drugParameters).values([
      { drugId: winnerId, parameter: 'proteinBinding', value: { value: 0.4 } as never, updatedBy: userId },
      { drugId: loserId, parameter: 'proteinBinding', value: { value: 0.6 } as never, updatedBy: userId },
    ]);
    const [winnerInfo, loserInfo] = await Promise.all([
      loadDrugSideInfo(db, winnerId),
      loadDrugSideInfo(db, loserId),
    ]);
    const plan = await buildDrugMergePlan(db, winnerInfo!, loserInfo!, {
      byMonograph: false,
      reason: 'test',
    });
    // Something changes on disk after the preview but before the apply.
    await db
      .update(drugParameters)
      .set({ value: { value: 0.9 } as never })
      .where(and(eq(drugParameters.drugId, loserId), eq(drugParameters.parameter, 'proteinBinding')));
    await expect(
      merge({
        winnerId,
        loserId,
        resolutions: { 'parameter:proteinBinding': 'winner' },
        actorUserId: userId,
        approvedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({ name: 'DrugMergeStalePlanError' });
    // Both drugs still exist.
    expect((await db.select().from(drugs).where(eq(drugs.id, loserId))).length).toBe(1);
  });

  it('refuses when the loser monograph prose changes between two non-empty snapshots', async () => {
    // hasContent stays true on both sides — the previous round-8 fingerprint
    // caught only empty↔written flips. Round-19 puts a SHA-256 of the stored
    // content into the fingerprint too, so editing the prose between preview
    // and apply flips the digest and refuses the stale plan.
    const winnerId = await seedDrug(db, { slug: 'cdw', names: { nb: 'CDW' } });
    const loserId = await seedDrug(db, { slug: 'cdl', names: { nb: 'CDL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'CDW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'CDL' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId);
    await giveMonographContent(loserId);
    const [winnerInfo, loserInfo] = await Promise.all([
      loadDrugSideInfo(db, winnerId),
      loadDrugSideInfo(db, loserId),
    ]);
    const plan = await buildDrugMergePlan(db, winnerInfo!, loserInfo!, {
      byMonograph: false,
      reason: { code: 'winnerReason.bothHaveMonograph', fallback: 'test' },
    });
    // Editor rewrites the loser's monograph prose (still non-empty).
    await db
      .update(wikiPages)
      .set({
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Newly rewritten prose that the admin never saw.' }] },
          ],
        } as never,
        contentPlaintext: 'Newly rewritten prose that the admin never saw.',
      })
      .where(eq(wikiPages.id, loserInfo!.monograph!.pageId));
    await expect(
      merge({
        winnerId,
        loserId,
        resolutions: {},
        actorUserId: userId,
        approvedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({ name: 'DrugMergeStalePlanError' });
  });

  it('refuses when the loser monograph gains content between preview and apply', async () => {
    const winnerId = await seedDrug(db, { slug: 'lgw', names: { nb: 'LGW' } });
    const loserId = await seedDrug(db, { slug: 'lgl', names: { nb: 'LGL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'LGW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'LGL' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId);
    const [winnerInfo, loserInfo] = await Promise.all([
      loadDrugSideInfo(db, winnerId),
      loadDrugSideInfo(db, loserId),
    ]);
    const plan = await buildDrugMergePlan(db, winnerInfo!, loserInfo!, {
      byMonograph: true,
      reason: 'test',
    });
    // An editor writes prose on the loser between preview and apply.
    await giveMonographContent(loserId);
    await expect(
      merge({
        winnerId,
        loserId,
        resolutions: {},
        actorUserId: userId,
        approvedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({ name: 'DrugMergeStalePlanError' });
    // Loser's page still exists — the delete never ran.
    const [loserPage] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, loserInfo!.monograph!.pageId));
    expect(loserPage).toBeTruthy();
  });

  it('refuses when the loser monograph is empty now but has prose in history', async () => {
    const winnerId = await seedDrug(db, { slug: 'rhw', names: { nb: 'RHW' } });
    const loserId = await seedDrug(db, { slug: 'rhl', names: { nb: 'RHL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'RHW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'RHL' }, pubchemCid: null }, userId);
    const loserSide = await loadDrugSideInfo(db, loserId);
    // A revision on the loser page that has meaningful prose in content_html,
    // while the current page snapshot stays empty (blanked-then-forgotten
    // scenario the CLI merge refuses).
    await db.execute(sql`
      INSERT INTO wiki_revisions (page_id, content, content_html, created_by)
      VALUES (${loserSide!.monograph!.pageId}, ${JSON.stringify({ type: 'doc' })}::jsonb,
              ${'<p>Original prose kept only in history</p>'}, ${userId})
    `);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'wiki_revisions')).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the loser has a pending full-replacement proposal', async () => {
    // Approving a pending receptor_targets proposal after merge would REPLACE
    // the drug's whole receptor-target list, wiping every row the merge just
    // preserved on the winner. Refuse; the curator settles the proposal
    // against the loser (or against the merged winner directly) first.
    const winnerId = await seedDrug(db, { slug: 'frw', names: { nb: 'FRW' } });
    const loserId = await seedDrug(db, { slug: 'frl', names: { nb: 'FRL' } });
    await db.insert(pendingEdits).values({
      editType: 'receptor_targets',
      targetId: loserId,
      proposedValue: { targets: [] } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'pending_edits' && c.identity.includes('receptor_targets'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the loser resolves to more than one monograph page', async () => {
    // A drug can have a modern id-keyed page AND a legacy CID-keyed page (no
    // uniqueness constraint), both surfacing as its monograph via
    // `resolveMonographDrugCids`. `loadMonograph` returns only one; the merge
    // would delete only that page and leave the other attached to a deleted
    // drug. Refuse and let an admin merge/delete the extra page first.
    const winnerId = await seedDrug(db, { slug: 'mmw', names: { nb: 'MMW' } });
    const loserId = await seedDrug(db, { slug: 'mml', names: { nb: 'MML' }, pubchemCid: 5555 });
    // Modern id-keyed monograph.
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'MML' }, pubchemCid: 5555 }, userId);
    // Second, legacy-keyed page for the SAME loser (drug_cid = pubchemCid).
    await db.insert(wikiPages).values({
      slug: 'mml-legacy',
      title: 'MML legacy',
      content: { type: 'doc', content: [] } as never,
      pageType: 'drug_monograph',
      drugCid: 5555,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'wiki_pages' && c.identity.includes('monograph pages'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the WINNER resolves to more than one monograph page', async () => {
    // Same shape as the loser-side check above, but on the winner: link
    // rewrites and the fingerprint read `loadMonograph`-return an arbitrary
    // page, leaving the survivor ambiguously attached to more than one
    // monograph after the fold. Refuse the same way.
    const winnerId = await seedDrug(db, { slug: 'wmw', names: { nb: 'WMW' }, pubchemCid: 6666 });
    const loserId = await seedDrug(db, { slug: 'wml', names: { nb: 'WML' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'WMW' }, pubchemCid: 6666 }, userId);
    await db.insert(wikiPages).values({
      slug: 'wmw-legacy',
      title: 'WMW legacy',
      content: { type: 'doc', content: [] } as never,
      pageType: 'drug_monograph',
      drugCid: 6666,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'wiki_pages' &&
          c.identity.includes('monograph pages resolve to winner'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('retargets settled replacement proposals off the deleted loser drug id', async () => {
    // ACTIVE metabolism/receptor_targets/enzyme_interaction proposals are
    // refused ahead of time (they would wipe merged rows on approval).
    // SETTLED (approved/rejected) rows are historical audit records that can
    // never be re-applied, but their polymorphic `target_id` would still
    // point at the deleted loser drug id. Move them to the winner so the
    // audit trail stays resolvable.
    const winnerId = await seedDrug(db, { slug: 'srw', names: { nb: 'SRW' } });
    const loserId = await seedDrug(db, { slug: 'srl', names: { nb: 'SRL' } });
    const [approved] = await db
      .insert(pendingEdits)
      .values({
        editType: 'metabolism',
        targetId: loserId,
        proposedValue: { profile: {}, metabolites: [] } as never,
        submittedBy: userId,
        status: 'approved',
      })
      .returning({ id: pendingEdits.id });
    const [rejected] = await db
      .insert(pendingEdits)
      .values({
        editType: 'receptor_targets',
        targetId: loserId,
        proposedValue: { targets: [] } as never,
        submittedBy: userId,
        status: 'rejected',
      })
      .returning({ id: pendingEdits.id });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [approvedRow] = await db
      .select({ targetId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, approved!.id));
    const [rejectedRow] = await db
      .select({ targetId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, rejected!.id));
    expect(approvedRow!.targetId).toBe(winnerId);
    expect(rejectedRow!.targetId).toBe(winnerId);
  });

  it('refuses when a saved-simulator key is ambiguous across drugs', async () => {
    // Loser's key is the string "777" (its pubchemCid). Another drug has
    // internal id 777 (arranged below) with no pubchemCid, so
    // `hydrateComponentByRouteId` would prefer the CID lookup and the merge's
    // rewrite would sweep up that other drug's saved cases too.
    // We create the ambiguity by inserting a distinct drug and reassigning its
    // id to match the loser's CID.
    const winnerId = await seedDrug(db, { slug: 'akw', names: { nb: 'AKW' }, pubchemCid: 888 });
    const loserId = await seedDrug(db, { slug: 'akl', names: { nb: 'AKL' }, pubchemCid: 777 });
    const decoyId = await seedDrug(db, { slug: 'akd', names: { nb: 'AKD' }, pubchemCid: null });
    // Set decoy id to 777 — same numeric string as loser's CID → ambiguous.
    await db.execute(sql`UPDATE drugs SET id = 777 WHERE id = ${decoyId}`);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'simulator_cases' && c.identity.includes('"777"'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('finds monograph proposals on a legacy CID-keyed page', async () => {
    // The loser monograph is keyed by pubchemCid (drug_cid = pubchemCid), the
    // legacy shape. The blocker used to search only by loser.id and miss this
    // page entirely; the resolved-candidate query catches it.
    const winnerId = await seedDrug(db, { slug: 'lkw', names: { nb: 'LKW' } });
    const loserId = await seedDrug(db, { slug: 'lkl', names: { nb: 'LKL' }, pubchemCid: 4242 });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'LKW' }, pubchemCid: null }, userId);
    // Insert a page whose drug_cid is the loser's PubChem CID (the legacy way).
    const [legacyPage] = await db
      .insert(wikiPages)
      .values({
        slug: 'lkl-legacy',
        title: 'LKL',
        content: { type: 'doc', content: [] } as never,
        pageType: 'drug_monograph',
        drugCid: 4242,
        status: 'published',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });
    await giveMonographContent(winnerId);
    await db.insert(pendingEdits).values({
      editType: 'wiki_page',
      targetId: legacyPage!.id,
      proposedValue: { title: 'draft edit' } as never,
      submittedBy: userId,
      status: 'draft',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'pending_edits' && c.identity.includes('wiki_page'),
      ),
    ).toBe(true);
  });

  it('refuses when an image-only revision exists on the loser monograph', async () => {
    // No paragraph text at all — the revision's content is a single image
    // node. Older HTML-and-text checks would misread this as an empty stub
    // and cascade the history away with the page delete.
    const winnerId = await seedDrug(db, { slug: 'ionw', names: { nb: 'IONW' } });
    const loserId = await seedDrug(db, { slug: 'ionl', names: { nb: 'IONL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'IONW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'IONL' }, pubchemCid: null }, userId);
    const loserSide = await loadDrugSideInfo(db, loserId);
    await db.execute(sql`
      INSERT INTO wiki_revisions (page_id, content, content_html, created_by)
      VALUES (
        ${loserSide!.monograph!.pageId},
        ${JSON.stringify({
          type: 'doc',
          content: [
            { type: 'image', attrs: { src: 'blob://x', alt: 'diagram' } },
          ],
        })}::jsonb,
        '',
        ${userId}
      )
    `);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'wiki_revisions')).toBe(true);
  });

  it('refuses full-replacement proposals on the winner too, not just the loser', async () => {
    // An active receptor_targets proposal on the WINNER is authored against
    // the winner's pre-merge rows; approving it after merge would REPLACE
    // the augmented list with the pre-merge payload, wiping loser-only rows
    // the merge just folded in. Same failure mode as the loser-side case.
    const winnerId = await seedDrug(db, { slug: 'w2w', names: { nb: 'W2W' } });
    const loserId = await seedDrug(db, { slug: 'w2l', names: { nb: 'W2L' } });
    await db.insert(pendingEdits).values({
      editType: 'receptor_targets',
      targetId: winnerId,
      proposedValue: { targets: [] } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'pending_edits' &&
          c.identity.includes('receptor_targets') &&
          c.identity.includes('on winner'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses wiki_new proposals when the survivor will INHERIT the loser monograph via manual override', async () => {
    // Manual-override shape: the winner has NO monograph and the loser has
    // one. Step 9 repoints the loser's page to the winner, so the winner
    // will own a monograph after merge. An existing wiki_new proposal on
    // either side would then create a second page on approval — refuse.
    const winnerId = await seedDrug(db, { slug: 'ihw', names: { nb: 'IHW' } });
    const loserId = await seedDrug(db, { slug: 'ihl', names: { nb: 'IHL' } });
    // Loser has a real monograph; winner has none.
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'IHL' }, pubchemCid: null }, userId);
    await giveMonographContent(loserId);
    // A wiki_new proposal on the winner (would later create a second page).
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      targetId: null,
      proposedValue: { body: 'draft' } as never,
      proposedMeta: { drugCid: winnerId, title: 'Draft' } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'pending_edits' &&
          c.identity.includes('wiki_new') &&
          c.identity.includes('will own a monograph'),
      ),
    ).toBe(true);
  });

  it('refuses when PM distributions share numerics but differ on analyte labels', async () => {
    const winnerId = await seedDrug(db, { slug: 'anw', names: { nb: 'ANW' } });
    const loserId = await seedDrug(db, { slug: 'anl', names: { nb: 'ANL' } });
    const [src] = await db.insert(pmConcentrationSources).values({
      key: 'src-analyte',
      citation: 'Test',
      shortLabel: 'T',
      heading: 'H',
      matrix: 'whole_blood',
      unit: 'µg/L',
      description: 'd',
    }).returning({ id: pmConcentrationSources.id });
    await db.insert(pmConcentrationDistributions).values([
      { sourceId: src!.id, drugId: winnerId, analyte: 'THC-COOH', n: 10, p95: '0.5' },
      { sourceId: src!.id, drugId: loserId, analyte: '9-carboxy-THC', n: 10, p95: '0.5' },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'pm_concentration_distributions')).toBe(true);
  });

  it('refuses wiki_new proposals on loser when winner already has a monograph', async () => {
    const winnerId = await seedDrug(db, { slug: 'wnw', names: { nb: 'WNW' } });
    const loserId = await seedDrug(db, { slug: 'wnl', names: { nb: 'WNL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'WNW' }, pubchemCid: null }, userId);
    await giveMonographContent(winnerId);
    await db.insert(pendingEdits).values({
      editType: 'wiki_new',
      targetId: null,
      proposedValue: { body: 'draft' } as never,
      proposedMeta: { drugCid: loserId, title: 'New page' } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'pending_edits' &&
          c.identity.includes('wiki_new') &&
          c.identity.includes('will own a monograph'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when PM distributions share numerics but differ on printed strings', async () => {
    // Every numeric column matches, but the `printed` map has the same key
    // with different significant-figure strings. `w.printed || l.printed`
    // is JSONB concat — the right side wins silently on shared keys — and
    // would erase the winner's transcription.
    const winnerId = await seedDrug(db, { slug: 'pmw', names: { nb: 'PMW' } });
    const loserId = await seedDrug(db, { slug: 'pml', names: { nb: 'PML' } });
    const [src] = await db.insert(pmConcentrationSources).values({
      key: 'src-test',
      citation: 'Test cohort',
      shortLabel: 'Test',
      heading: 'Test heading',
      matrix: 'whole_blood',
      unit: 'µg/L',
      description: 'test',
    }).returning({ id: pmConcentrationSources.id });
    await db.insert(pmConcentrationDistributions).values([
      { sourceId: src!.id, drugId: winnerId, analyte: 'A', n: 10, p95: '0.2', printed: { p95: '0.2' } },
      { sourceId: src!.id, drugId: loserId, analyte: 'A', n: 10, p95: '0.2', printed: { p95: '0.20' } },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'pm_concentration_distributions')).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('a param_entry create submitted after the merge commits gets 404 (drug no longer exists)', async () => {
    // The submit path takes the same per-drug advisory lock the merge does
    // and re-verifies the drug exists inside that lock. After a merge deletes
    // the loser, a stale-client submission attaching to the deleted id must
    // fail cleanly instead of filing a dangling pending edit that could
    // never be approved. We simulate the "submitted after the merge" shape
    // by calling the internal submit path helper via a direct SELECT that
    // proves the pre-condition (loser deleted) and asserting there is no
    // dangling edit.
    const winnerId = await seedDrug(db, { slug: 'psw', names: { nb: 'PSW' } });
    const loserId = await seedDrug(db, { slug: 'psl', names: { nb: 'PSL' } });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [loser] = await db.select().from(drugs).where(eq(drugs.id, loserId));
    expect(loser).toBeUndefined();
    // A stale write attempting to attach to the deleted id would now: enter
    // runInPoolTransaction, take the advisory lock, re-select drugs by id,
    // find nothing, return null and hand the caller a 404 instead of
    // inserting a dangling pending edit. This is the design contract change
    // added in round-17. Assert no pending edits point at the deleted id.
    const dangling = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.targetId, loserId));
    expect(dangling).toHaveLength(0);
  });

  it('does NOT dedup identical parameter_entries when route differs — both live on the survivor', async () => {
    // Oral vs IV bioavailability rows from the same citation share every
    // other column but describe different administration routes. Dropping
    // one would silently retire that route-specific declaration and change
    // the survivor's model inputs.
    const winnerId = await seedDrug(db, { slug: 'rtw', names: { nb: 'RTW' } });
    const loserId = await seedDrug(db, { slug: 'rtl', names: { nb: 'RTL' } });
    const citationId = await seedAdmissibleCitation(db, { type: 'pmid', identifier: '6666', createdBy: userId });
    const shared = {
      parameter: 'bioavailability',
      unit: 'unitless',
      matrix: null,
      scenario: null,
      citationId,
      qualifier: null,
      categoricalValue: null,
      low: '0.5',
      high: '0.8',
      median: '0.6',
      n: 12,
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values({ drugId: winnerId, ...shared, route: 'oral' });
    await db.insert(parameterEntries).values({ drugId: loserId, ...shared, route: 'iv' });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const rows = await db
      .select({ route: parameterEntries.route })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, winnerId));
    expect(rows.map((r) => r.route).sort()).toEqual(['iv', 'oral']);
  });

  it('refuses when two parameter_entries share every field except n', async () => {
    // The write-path identity (entryDuplicateExists) doesn't include `n`, so
    // a normal insert would reject the second row as a duplicate. A merge
    // that silently kept both would let entryWeight double-pool the source;
    // a merge that silently dropped one would arbitrarily pick which `n` to
    // retain. Neither is safe — refuse and let the curator merge the `n`
    // values, drop one row, or file them under distinct citations first.
    const winnerId = await seedDrug(db, { slug: 'nsw', names: { nb: 'NSW' } });
    const loserId = await seedDrug(db, { slug: 'nsl', names: { nb: 'NSL' } });
    const citationId = await seedAdmissibleCitation(db, { type: 'pmid', identifier: '5555', createdBy: userId });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: null,
      scenario: null,
      citationId,
      qualifier: null,
      categoricalValue: null,
      low: '5',
      high: '10',
      median: '7',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values({ drugId: winnerId, ...shared, n: 10 });
    await db.insert(parameterEntries).values({ drugId: loserId, ...shared, n: 40 });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'parameter_entries' &&
          c.identity.includes('n=10') &&
          c.identity.includes('n=40'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when the winner has a free-text metabolite link and the loser has resolved it', async () => {
    // Winner: "Foo" free-text, metabolite_drug_id NULL. Loser: same name,
    // resolved to a canonical drug. Name-only dedup would delete the loser
    // row and replace the resolved relationship with the winner's free-text.
    const winnerId = await seedDrug(db, { slug: 'unw', names: { nb: 'UNW' } });
    const loserId = await seedDrug(db, { slug: 'unl', names: { nb: 'UNL' } });
    const resolvedFoo = await seedDrug(db, { slug: 'resolved-foo', names: { nb: 'ResolvedFoo' } });
    await db.insert(drugMetabolites).values([
      { parentDrugId: winnerId, metaboliteDrugId: null, metaboliteName: 'Foo' },
      { parentDrugId: loserId, metaboliteDrugId: resolvedFoo, metaboliteName: 'Foo' },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'drug_metabolites' && c.identity.includes('unresolved'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when both entries have same-named metabolite edges resolving to different drugs', async () => {
    // Winner and loser both list a metabolite called "Foo" but each resolves
    // it to a different substance. The name-based dedup would delete the
    // loser row and silently drop the distinct relationship.
    const winnerId = await seedDrug(db, { slug: 'mnw', names: { nb: 'MNW' } });
    const loserId = await seedDrug(db, { slug: 'mnl', names: { nb: 'MNL' } });
    const drugA = await seedDrug(db, { slug: 'foo-a', names: { nb: 'FooA' } });
    const drugB = await seedDrug(db, { slug: 'foo-b', names: { nb: 'FooB' } });
    await db.insert(drugMetabolites).values([
      { parentDrugId: winnerId, metaboliteDrugId: drugA, metaboliteName: 'Foo' },
      { parentDrugId: loserId, metaboliteDrugId: drugB, metaboliteName: 'Foo' },
    ]);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) => c.table === 'drug_metabolites' && c.identity.includes('Foo'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when only revision JSON (not HTML) carries prose on the loser monograph', async () => {
    // seed-drug-monographs.ts creates rows with populated `content` and empty
    // `content_html`. An HTML-only history check would misclassify these
    // as disposable stubs.
    const winnerId = await seedDrug(db, { slug: 'rjw', names: { nb: 'RJW' } });
    const loserId = await seedDrug(db, { slug: 'rjl', names: { nb: 'RJL' } });
    await ensureDrugMonograph(db, { id: winnerId, names: { nb: 'RJW' }, pubchemCid: null }, userId);
    await ensureDrugMonograph(db, { id: loserId, names: { nb: 'RJL' }, pubchemCid: null }, userId);
    const loserSide = await loadDrugSideInfo(db, loserId);
    // Revision whose JSON has real prose but content_html is empty.
    await db.execute(sql`
      INSERT INTO wiki_revisions (page_id, content, content_html, created_by)
      VALUES (
        ${loserSide!.monograph!.pageId},
        ${JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Prose only in the JSON' }] },
          ],
        })}::jsonb,
        '',
        ${userId}
      )
    `);
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(conflicts.some((c) => c.table === 'wiki_revisions')).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('refuses when a param_entry update proposal targets a to-be-deduped loser entry', async () => {
    const winnerId = await seedDrug(db, { slug: 'edw', names: { nb: 'EDW' } });
    const loserId = await seedDrug(db, { slug: 'edl', names: { nb: 'EDL' } });
    const citationId = await seedAdmissibleCitation(db, { type: 'pmid', identifier: '9999', createdBy: userId });
    const shared = {
      parameter: 'halfLife',
      unit: 'h',
      matrix: null,
      scenario: null,
      citationId,
      qualifier: null,
      categoricalValue: null,
      low: '5',
      high: '10',
      median: '7',
      origin: 'legacy' as const,
      createdBy: userId,
    };
    await db.insert(parameterEntries).values({ drugId: winnerId, ...shared });
    const [dup] = await db
      .insert(parameterEntries)
      .values({ drugId: loserId, ...shared })
      .returning({ id: parameterEntries.id });
    // Update proposal targeting the loser's duplicate entry — merge would
    // delete the entry via dedup, orphaning the proposal.
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: dup!.id,
      proposedValue: { op: 'update', input: { median: '8' } } as never,
      submittedBy: userId,
      status: 'pending',
    });
    const conflicts = await dataConflictsFor(winnerId, loserId);
    expect(
      conflicts.some(
        (c) =>
          c.table === 'pending_edits' &&
          c.identity.includes('param_entry update'),
      ),
    ).toBe(true);
    await expect(
      merge({ winnerId, loserId, resolutions: {}, actorUserId: userId }),
    ).rejects.toBeInstanceOf(DrugMergeDataConflictError);
  });

  it('rewrites both target_id AND proposed_value.input.drugId when retargeting a param_entry create', async () => {
    const winnerId = await seedDrug(db, { slug: 'pcw', names: { nb: 'PCW' } });
    const loserId = await seedDrug(db, { slug: 'pcl', names: { nb: 'PCL' } });
    await db.insert(pendingEdits).values({
      editType: 'param_entry',
      targetId: loserId,
      proposedValue: {
        op: 'create',
        input: { drugId: loserId, parameter: 'halfLife', unit: 'h', median: '5' },
      } as never,
      submittedBy: userId,
      status: 'pending',
    });
    await merge({ winnerId, loserId, resolutions: {}, actorUserId: userId });
    const [prop] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.editType, 'param_entry'));
    expect(prop?.targetId).toBe(winnerId);
    const inner = (prop?.proposedValue as { input: { drugId: number } }).input;
    expect(inner.drugId).toBe(winnerId);
  });

  it('unions metabolism-profile references regardless of which note is kept', async () => {
    const winnerId = await seedDrug(db, { slug: 'wp', names: { nb: 'WP' } });
    const loserId = await seedDrug(db, { slug: 'lp', names: { nb: 'LP' } });
    await db.insert(drugMetabolismProfiles).values([
      { drugId: winnerId, evidenceNote: 'winner note', referenceIds: [10, 20], updatedBy: userId },
      { drugId: loserId, evidenceNote: 'loser note', referenceIds: [20, 30], updatedBy: userId },
    ]);
    await merge({
      winnerId,
      loserId,
      resolutions: { 'metabolism_profile:profile': 'loser' },
      actorUserId: userId,
    });
    const [profile] = await db
      .select()
      .from(drugMetabolismProfiles)
      .where(eq(drugMetabolismProfiles.drugId, winnerId));
    // Note came from the loser's row (that was the pick), refs are the union
    // in first-seen order.
    expect(profile!.evidenceNote).toBe('loser note');
    expect(profile!.referenceIds).toEqual([10, 20, 30]);
  });
});
