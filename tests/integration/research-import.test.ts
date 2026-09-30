import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  bioEntities,
  citations,
  drugEliminationRoutes,
  drugEnzymeInteractions,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterApplicability,
  drugParameterRevisions,
  drugParameters,
  drugReceptorTargets,
  drugIonizationConstants,
  drugs,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import { parseResearchOutput } from '../../src/lib/deepResearchImport.js';
import { runImport } from '../../api/_lib/researchImportStore.js';
import {
  getIonizationConstantsForDrug,
  seedIonizationConstants,
} from '../../api/_lib/ionizationConstantsStore.js';
import {
  collectUsedCitationIdsForDrug,
  filterUsedCitationIds,
} from '../../api/_lib/citation-usage.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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
  userId = await seedUser(db, {
    email: 'importer@example.com',
    username: 'importer',
    role: 'admin',
  });
});

const DOC = {
  schemaVersion: 'kinetix-deep-research-output-v1',
  drugIdentity: {
    names: { nb: 'Kokain', en: 'Cocaine' },
    aliases: ['coke'],
    pubchemCid: 446220,
    molecularWeight: 303.35,
  },
  kinetixParameterValues: [
    {
      parameter: 'halfLife',
      status: 'finalized',
      value: {
        min: 0.7,
        max: 1.7,
        median: 1.2,
        unit: 'h',
        note: 'acute plasma',
      },
      sourceIds: ['S1', 'S2'],
    },
    {
      parameter: 'pKa',
      status: 'finalized',
      value: { median: 8.6, unit: 'unitless' },
      sourceIds: [],
    },
  ],
  ionizationConstants: [
    {
      pKa: 8.6,
      protonatedCharge: 1,
      deprotonatedCharge: 0,
      evidenceType: 'experimental',
      note: 'free base, 25°C',
      sourceIds: ['S1', 'S2'],
    },
  ],
  pharmacodynamicTargets: [
    {
      targetSymbol: 'SLC6A3',
      targetName: 'Dopamine transporter',
      interactionType: 'inhibitor',
      tier: 'primary',
      ki: { median: 0.64, unit: 'µM' },
      assaySpecies: 'Rattus norvegicus',
      sourceIds: ['S1'],
    },
  ],
  metabolism: {
    profileEvidenceNote: 'Hydrolysed by esterases.',
    profileSourceIds: ['S1'],
    eliminationRoutes: [
      {
        kind: 'enzyme',
        enzymeOrEntitySymbol: 'CES1',
        label: 'Carboxylesterase 1',
        fraction: 0.4,
        sourceIds: ['S1'],
      },
      { kind: 'renal_unchanged', label: 'Renal', fraction: 0.05 },
    ],
    metabolites: [
      {
        metaboliteName: 'Benzoylecgonine',
        activity: 'inactive',
        conversionFraction: 0.35,
        sourceIds: ['S1'],
      },
    ],
    enzymeInteractions: [
      {
        enzymeOrEntitySymbol: 'CYP3A4',
        role: 'substrate',
        strength: 'moderate',
        sourceIds: ['S1'],
      },
    ],
  },
  sources: [
    {
      sourceId: 'S1',
      citationType: 'pmid',
      pmid: '29462364',
      title: 'Oral cocaine PK',
      year: 2018,
    },
    {
      sourceId: 'S2',
      citationType: 'pmid',
      pmid: '31150569',
      title: 'Whole blood vs plasma',
      year: 2019,
    },
  ],
};

function parse(doc: unknown) {
  const res = parseResearchOutput(doc);
  if (!res.ok) throw new Error(`parse failed: ${res.errors.join('; ')}`);
  return res.data;
}

describe('deep-research importer — full DB path (PGlite)', () => {
  it('seeds a new drug with parameters, citations, revisions, PD targets and metabolism', async () => {
    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });

    expect(stats.drugCreated).toBe(true);
    const [drug] = await db
      .select()
      .from(drugs)
      .where(eq(drugs.id, stats.drugId));
    expect(drug!.source).toBe('deep-research');
    expect(drug!.pubchemCid).toBe(446220);
    expect(drug!.names).toMatchObject({ nb: 'Kokain', en: 'Cocaine' });

    // Parameters: halfLife, pKa, and molecularWeight (lifted from drugIdentity).
    const params = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, stats.drugId));
    const byId = new Map(params.map((p) => [p.parameter, p.value]));
    expect(byId.get('halfLife')).toMatchObject({
      min: 0.7,
      max: 1.7,
      median: 1.2,
      unit: 'h',
    });
    expect(byId.get('pKa')).toEqual({ median: 8.6 }); // unit stripped
    expect(byId.get('molecularWeight')).toBe(303.35);

    // Citations deduped, and each parameter revision carries its refs.
    const cites = await db
      .select()
      .from(citations)
      .where(eq(citations.drugId, stats.drugId));
    expect(cites).toHaveLength(2);
    const s1 = cites.find((c) => c.identifier === '29462364')!;
    const revs = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, stats.drugId));
    const halfLifeRev = revs.find((r) => r.parameter === 'halfLife')!;
    expect(halfLifeRev.referenceIds).toContain(s1.id);
    expect(halfLifeRev.createdBy).toBe(userId);

    // PD target resolved to a bio_entity.
    const pd = await db
      .select()
      .from(drugReceptorTargets)
      .where(eq(drugReceptorTargets.drugId, stats.drugId));
    expect(pd).toHaveLength(1);
    expect(pd[0]!.interactionType).toBe('inhibitor');
    expect(pd[0]!.tier).toBe('primary');
    expect(pd[0]!.bioEntityId).toBeGreaterThan(0);
    expect(pd[0]!.ki).toMatchObject({ median: 0.64 });
    // #1017: the species of the assay lands on the measurement. The catalog
    // entity stays human — a rat Ki must not rewrite an entity every other drug
    // also points at.
    expect(pd[0]!.assaySpecies).toBe('Rattus norvegicus');
    const [entity] = await db
      .select({ organism: bioEntities.organism })
      .from(bioEntities)
      .where(eq(bioEntities.id, pd[0]!.bioEntityId));
    expect(entity?.organism).toBe('Homo sapiens');

    // Metabolism: profile + routes (enzyme route resolves a bio_entity) +
    // metabolites + enzyme interaction.
    const [profile] = await db
      .select()
      .from(drugMetabolismProfiles)
      .where(eq(drugMetabolismProfiles.drugId, stats.drugId));
    expect(profile!.evidenceNote).toContain('esterases');

    const routes = await db
      .select()
      .from(drugEliminationRoutes)
      .where(eq(drugEliminationRoutes.drugId, stats.drugId));
    expect(routes).toHaveLength(2);
    const enzymeRoute = routes.find((r) => r.kind === 'enzyme')!;
    expect(enzymeRoute.bioEntityId).toBeGreaterThan(0);

    const mets = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, stats.drugId));
    expect(mets).toHaveLength(1);
    expect(mets[0]!.metaboliteName).toBe('Benzoylecgonine');

    const eis = await db
      .select()
      .from(drugEnzymeInteractions)
      .where(eq(drugEnzymeInteractions.drugId, stats.drugId));
    expect(eis).toHaveLength(1);
    expect(eis[0]!.role).toBe('substrate');

    // Structured ionization constant: one +1 → 0 transition, both sources
    // aggregated onto the row's reference_ids.
    expect(stats.ionizationConstants).toBe(1);
    const ions = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, stats.drugId));
    expect(ions).toHaveLength(1);
    expect(Number(ions[0]!.pka)).toBe(8.6);
    expect(ions[0]!.protonatedCharge).toBe(1);
    expect(ions[0]!.deprotonatedCharge).toBe(0);
    expect(ions[0]!.evidenceType).toBe('experimental');
    expect(ions[0]!.referenceIds).toHaveLength(2);

    // The API read path returns the profile, including the imported note.
    const serialized = await getIonizationConstantsForDrug(db, stats.drugId);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]!.note).toBe('free base, 25°C');
    expect(serialized[0]!.referenceIds).toHaveLength(2);

    // A citation carried by the ionization constant counts as "in use" for both
    // the drug-scoped bibliography and the direct-lookup visibility filter, so
    // an ionization-only source is never treated as an orphan.
    const ionCitationId = ions[0]!.referenceIds![0]!;
    const usedForDrug = await collectUsedCitationIdsForDrug(db, stats.drugId);
    expect(usedForDrug.has(ionCitationId)).toBe(true);
    const visible = await filterUsedCitationIds(db, [ionCitationId]);
    expect(visible.has(ionCitationId)).toBe(true);
  });

  it('is idempotent — a second run adds no duplicate rows and keeps existing values', async () => {
    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    const second = await runImport(db, parse(DOC), {
      userId,
      overwrite: false,
    });

    expect(second.drugCreated).toBe(false);
    expect(second.drugId).toBe(first.drugId);
    expect(second.parameters).toBe(0); // all kept existing
    expect(second.parametersSkipped).toBeGreaterThan(0);
    expect(second.pdTargets).toBe(0);
    expect(second.routes).toBe(0);
    expect(second.metabolites).toBe(0);
    expect(second.enzymeInteractions).toBe(0);
    expect(second.ionizationConstants).toBe(0); // reconciled, not duplicated
    expect(second.ionizationConstantsSkipped).toBe(1);
    const ions = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, first.drugId));
    expect(ions).toHaveLength(1);

    const cites = await db
      .select()
      .from(citations)
      .where(eq(citations.drugId, first.drugId));
    expect(cites).toHaveLength(2);
    const routes = await db
      .select()
      .from(drugEliminationRoutes)
      .where(eq(drugEliminationRoutes.drugId, first.drugId));
    expect(routes).toHaveLength(2);
  });

  it('never overwrites a curated ionization constant (non-destructive default)', async () => {
    const drugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    // A human-curated constant for the same +1 → 0 experimental transition the
    // DOC seeds, with a different pKa. Default origin is 'curated'.
    await db.insert(drugIonizationConstants).values({
      drugId,
      pka: '9.10',
      protonatedCharge: 1,
      deprotonatedCharge: 0,
      constantType: 'macroscopic',
      evidenceType: 'experimental',
    });

    // Even with overwrite, a curated row is left alone and reported as kept.
    const stats = await runImport(db, parse(DOC), { userId, overwrite: true });
    expect(stats.ionizationConstants).toBe(0);
    expect(stats.ionizationConstantsUpdated).toBe(0);
    expect(stats.ionizationConstantsKept).toBe(1);

    const ions = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, drugId));
    expect(ions).toHaveLength(1);
    expect(Number(ions[0]!.pka)).toBe(9.1); // curated value preserved
    expect(ions[0]!.origin).toBe('curated');
  });

  it('reconciles the row that wins a concurrent insert instead of duplicating (unique-index safety net)', async () => {
    const drugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    // Two same-identity constants with DIFFERENT pKa in one call. The reconcile
    // lookup reads existing rows once (empty), so both reach the insert; the
    // second loses the unique-index race (onConflictDoNothing → empty), and the
    // store then re-reads the winner and reconciles against it rather than
    // duplicating the row.
    const constant = {
      pKa: 8.6,
      protonatedCharge: 1,
      deprotonatedCharge: 0,
      type: 'macroscopic' as const,
      evidenceType: 'experimental' as const,
      siteLabel: null,
      temperatureC: null,
      medium: null,
      note: null,
      sourceIds: [],
    };

    // Non-destructive: the losing differing reading is KEPT-and-reported (not a
    // silent "already present"), and the row is never duplicated.
    const kept = await seedIonizationConstants(
      db,
      drugId,
      [constant, { ...constant, pKa: 8.7 }],
      () => [],
      userId,
      false,
    );
    expect(kept.inserted).toBe(1);
    expect(kept.kept).toBe(1);
    let rows = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, drugId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.pka)).toBe(8.6); // winner unchanged on a kept outcome

    // Under --overwrite the losing reading's correction is applied to the winner.
    const overwritten = await seedIonizationConstants(
      db,
      drugId,
      [{ ...constant, pKa: 8.9 }],
      () => [],
      userId,
      true,
    );
    expect(overwritten.updated).toBe(1);
    rows = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, drugId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.pka)).toBe(8.9);
  });

  it('attaches new sources to an unchanged ionization constant without --overwrite (provenance-only)', async () => {
    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    let ions = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, first.drugId));
    expect(ions[0]!.referenceIds).toHaveLength(2);

    // A re-import with the SAME value but an additional citing paper. The extra
    // source must be attached even without --overwrite — additive provenance.
    const withExtraSource = parse({
      ...DOC,
      ionizationConstants: [
        { ...DOC.ionizationConstants[0], sourceIds: ['S1', 'S2', 'S5'] },
      ],
      sources: [
        ...DOC.sources,
        { sourceId: 'S5', citationType: 'pmid', pmid: '33333333', title: 'Third pKa paper', year: 2021 },
      ],
    });
    const second = await runImport(db, withExtraSource, { userId, overwrite: false });
    expect(second.ionizationConstantsUpdated).toBe(1);
    expect(second.ionizationConstantsKept).toBe(0);

    ions = await db
      .select()
      .from(drugIonizationConstants)
      .where(eq(drugIonizationConstants.drugId, first.drugId));
    expect(ions).toHaveLength(1);
    expect(ions[0]!.referenceIds).toHaveLength(3); // new source attached
  });

  it('applies a note-only correction to a research constant under --overwrite', async () => {
    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    // Same document, note corrected, everything else identical.
    const corrected = parse({
      ...DOC,
      ionizationConstants: [
        { ...DOC.ionizationConstants[0], note: 'free base, 37°C (corrected)' },
      ],
    });
    const second = await runImport(db, corrected, { userId, overwrite: true });
    expect(second.ionizationConstantsUpdated).toBe(1);
    expect(second.ionizationConstants).toBe(0);

    const serialized = await getIonizationConstantsForDrug(db, first.drugId);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]!.note).toBe('free base, 37°C (corrected)');
  });

  // Seeding a drug that already has curated values is the common case, and the
  // non-destructive default keeps them — which also means no revision is
  // written for those parameters, and a revision is the only thing that carries
  // a parameter's citations. The sources then anchor to nothing: the parameter
  // keeps its "no references" flag in the sidebar and the papers stay out of the
  // bibliography. The run must say so instead of reporting a clean import.
  it('reports the sources it could not attach when a parameter keeps its value', async () => {
    const existingDrugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    await db.insert(drugParameters).values({
      drugId: existingDrugId,
      parameter: 'halfLife',
      value: { median: 1, unit: 'h', note: 'curated' },
      updatedBy: userId,
    });

    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });

    expect(stats.drugId).toBe(existingDrugId);
    // halfLife is the only skipped parameter carrying sourceIds; pKa is skipped
    // in later runs too but cites nothing, so it must not be reported here.
    expect(stats.keptWithUnattachedSources).toEqual([
      { parameter: 'halfLife', sources: 2 },
    ]);

    // And the value really was kept, so the report is not describing a write.
    const params = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, existingDrugId));
    expect(params.find((p) => p.parameter === 'halfLife')!.value).toMatchObject({
      note: 'curated',
    });
  });

  it('reports nothing unattached when the values were actually written', async () => {
    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });
    expect(stats.keptWithUnattachedSources).toEqual([]);
    expect(stats.sourcesAttachedToUnchanged).toBe(0);
  });

  // The stored value already IS the researched value, so the document's sources
  // back it and attaching them invents nothing. Skipping the write would strand
  // them permanently: the non-destructive path writes no revision, and
  // --overwrite has no value to change, so it lands here too.
  it('attaches sources to an existing value identical to the researched one', async () => {
    const existingDrugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    const halfLifeValue = parse(DOC).parameters.find(
      (p) => p.parameter === 'halfLife',
    )!.value;
    await db.insert(drugParameters).values({
      drugId: existingDrugId,
      parameter: 'halfLife',
      value: halfLifeValue,
      updatedBy: userId,
    });

    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });

    expect(stats.drugId).toBe(existingDrugId);
    expect(stats.sourcesAttachedToUnchanged).toBe(1);
    // Not reported as unattached — they were attached.
    expect(stats.keptWithUnattachedSources).toEqual([]);

    const revs = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, existingDrugId));
    const halfLifeRevs = revs.filter((r) => r.parameter === 'halfLife');
    expect(halfLifeRevs).toHaveLength(1);
    expect(halfLifeRevs[0]!.referenceIds).toHaveLength(2);
    // A provenance-only write: the value on both sides of the revision is the
    // one that was already stored.
    expect(halfLifeRevs[0]!.newValue).toEqual(halfLifeValue);
    expect(halfLifeRevs[0]!.oldValue).toEqual(halfLifeValue);

    // Re-running must not append an identical provenance revision.
    const second = await runImport(db, parse(DOC), { userId, overwrite: false });
    expect(second.sourcesAttachedToUnchanged).toBe(0);
    const after = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, existingDrugId));
    expect(after.filter((r) => r.parameter === 'halfLife')).toHaveLength(1);
  });

  // The remediation the kept-value report points the operator at has to work:
  // re-running with --overwrite must leave no parameter both unchanged and
  // uncited.
  it('attaches sources on the --overwrite re-run the kept-value report asks for', async () => {
    const existingDrugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    await db.insert(drugParameters).values({
      drugId: existingDrugId,
      parameter: 'halfLife',
      value: { median: 1, unit: 'h', note: 'auto-extracted' },
      updatedBy: userId,
    });

    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    expect(first.keptWithUnattachedSources).toEqual([
      { parameter: 'halfLife', sources: 2 },
    ]);

    const second = await runImport(db, parse(DOC), { userId, overwrite: true });
    expect(second.keptWithUnattachedSources).toEqual([]);

    const revs = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, existingDrugId));
    const halfLife = revs.filter((r) => r.parameter === 'halfLife');
    expect(halfLife).toHaveLength(1);
    expect(halfLife[0]!.referenceIds).toHaveLength(2);
  });

  it('maps pre-existing citations through the batched source lookup', async () => {
    const [existing] = await db
      .insert(citations)
      .values({
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'Cached PubMed row' },
        createdBy: userId,
      })
      .returning({ id: citations.id });

    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });

    expect(stats.citations).toBe(2);
    const cites = await db.select().from(citations);
    expect(cites).toHaveLength(2);
    expect(cites.find((c) => c.identifier === '29462364')!.id).toBe(
      existing!.id,
    );
    expect(cites.find((c) => c.identifier === '31150569')!.drugId).toBe(
      stats.drugId,
    );

    const revs = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, stats.drugId));
    const halfLifeRev = revs.find((r) => r.parameter === 'halfLife')!;
    expect(halfLifeRev.referenceIds).toContain(existing!.id);
  });

  it('--overwrite replaces an existing parameter value and writes a new revision', async () => {
    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    const changed = structuredClone(DOC);
    changed.kinetixParameterValues[0]!.value = {
      min: 0.8,
      max: 1.5,
      median: 1.1,
      unit: 'h',
      note: 'revised',
    };
    const second = await runImport(db, parse(changed), {
      userId,
      overwrite: true,
    });

    expect(second.parameters).toBeGreaterThan(0);
    const params = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.drugId, first.drugId));
    const halfLife = params.find((p) => p.parameter === 'halfLife')!;
    expect(halfLife.value).toMatchObject({ min: 0.8, max: 1.5 });
    const revs = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, first.drugId));
    const halfLifeRevs = revs.filter((r) => r.parameter === 'halfLife');
    expect(halfLifeRevs.length).toBeGreaterThanOrEqual(2); // original + overwrite
  });

  it('links metabolites through exact search-key candidates', async () => {
    const metaboliteId = await seedDrug(db, {
      slug: 'benzoylecgonine',
      names: { nb: 'Benzoylecgonine', en: 'Benzoylecgonine' },
      searchKey: 'benzoylecgonine\tbec',
    });
    await seedDrug(db, {
      slug: 'norbenzoylecgonine',
      names: { en: 'Norbenzoylecgonine' },
      searchKey: 'norbenzoylecgonine',
    });

    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });

    const mets = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, stats.drugId));
    expect(mets).toHaveLength(1);
    expect(mets[0]!.metaboliteDrugId).toBe(metaboliteId);
  });

  it('reports a metabolite the drug already links under another spelling', async () => {
    // The Norwegian name is what the monograph carries; the document writes
    // the English one. Since 0099 those are one substance, so the document's
    // row is refused — but `metabolites: 0` alone reads as an idempotent
    // re-run, and the paper's conversion fraction and citation went nowhere.
    const metaboliteId = await seedDrug(db, {
      slug: 'benzoylecgonin',
      names: { nb: 'benzoylecgonin', en: 'Benzoylecgonine' },
      searchKey: 'benzoylecgonin\tbenzoylecgonine',
    });
    const first = await runImport(db, parse(DOC), { userId, overwrite: false });
    await db
      .update(drugMetabolites)
      .set({ metaboliteName: 'benzoylecgonin' })
      .where(eq(drugMetabolites.parentDrugId, first.drugId));

    const second = await runImport(db, parse(DOC), { userId, overwrite: false });

    expect(second.metabolites).toBe(0);
    expect(second.metabolitesKept).toEqual([
      { name: 'Benzoylecgonine', linkedAs: 'benzoylecgonin' },
    ]);
    const mets = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, second.drugId));
    expect(mets).toHaveLength(1);
    expect(mets[0]!.metaboliteDrugId).toBe(metaboliteId);
  });

  it('reports a second spelling the same document introduced', async () => {
    // Both names resolve to one drug, so the second row is refused by the
    // substance index — a conflict this run created rather than inherited,
    // which is just as capable of losing the paper's evidence silently.
    const metaboliteId = await seedDrug(db, {
      slug: 'benzoylecgonin',
      names: { nb: 'benzoylecgonin', en: 'Benzoylecgonine' },
      searchKey: 'benzoylecgonin\tbenzoylecgonine',
    });
    const doc = parse(DOC);
    doc.metabolism.metabolites.push({
      ...doc.metabolism.metabolites[0]!,
      name: 'benzoylecgonin',
    });

    const stats = await runImport(db, doc, { userId, overwrite: false });

    expect(stats.metabolites).toBe(1);
    expect(stats.metabolitesKept).toEqual([
      { name: 'benzoylecgonin', linkedAs: 'Benzoylecgonine' },
    ]);
    const mets = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, stats.drugId));
    expect(mets).toHaveLength(1);
    expect(mets[0]!.metaboliteDrugId).toBe(metaboliteId);
  });

  it('stays silent when the same spelling is simply re-imported', async () => {
    await seedDrug(db, {
      slug: 'benzoylecgonine',
      names: { en: 'Benzoylecgonine' },
      searchKey: 'benzoylecgonine',
    });
    await runImport(db, parse(DOC), { userId, overwrite: false });
    const second = await runImport(db, parse(DOC), { userId, overwrite: false });

    // An ordinary idempotent re-run has nothing to reconcile, so it must not
    // be dressed up as a conflict the operator needs to look at.
    expect(second.metabolites).toBe(0);
    expect(second.metabolitesKept).toEqual([]);
  });
});

// ─── Source values (kildeverdier) ───────────────────────────────────────────
// v2 of the contract: a parameter may carry `sourceValues[]`, one reading per
// paper, which become `parameter_entries` rows. Without them an imported value
// is a hand-authored scalar with citations bolted on — no entry list, no forest
// plot, and the grandfather rule keeps it only until someone adds the first
// real entry, whose lone aggregate then replaces the synthesized number.

const ENTRY_DOC = {
  ...DOC,
  kinetixParameterValues: [
    {
      parameter: 'halfLife',
      status: 'finalized',
      value: { min: 0.7, max: 1.7, median: 1.2, unit: 'h' },
      sourceIds: ['S1', 'S2'],
      sourceValues: [
        { sourceId: 'S1', low: 0.7, high: 1.3, median: 1, unit: 'h', n: 12 },
        { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h', comments: 'chronic users' },
      ],
    },
  ],
};

describe('deep-research importer — source values', () => {
  it('writes one parameter_entries row per source and derives the value from them', async () => {
    const stats = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });

    expect(stats.entries).toBe(2);
    expect(stats.entriesSkipped).toBe(0);
    expect(stats.entrySourcesUnresolved).toBe(0);
    expect(stats.entriesInvalid).toEqual([]);

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, stats.drugId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin === 'deep-research')).toBe(true);
    expect(rows.every((r) => r.parameter === 'halfLife')).toBe(true);
    expect(rows.every((r) => r.unit === 'h')).toBe(true);
    // Every entry is citation-gated — the whole point is per-paper provenance.
    expect(rows.every((r) => r.citationId != null)).toBe(true);
    expect(new Set(rows.map((r) => r.citationId)).size).toBe(2);
    expect(rows.find((r) => r.n === 12)).toBeTruthy();

    // The recompute at the end of runImport publishes the aggregate, so the
    // parameter is now a derived cache rather than a seeded scalar.
    const [halfLife] = await db
      .select()
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, stats.drugId),
          eq(drugParameters.parameter, 'halfLife'),
        ),
      );
    expect(halfLife!.value).toMatchObject({ derivedFromEntries: true });
  });

  it('is idempotent — a re-run recognises its own readings', async () => {
    const first = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });
    const second = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });

    expect(second.entries).toBe(0);
    expect(second.entriesSkipped).toBe(2);
    expect(second.entriesKept).toEqual([]);
    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    expect(rows).toHaveLength(2);
  });

  // Codex P1 on #1360: the same-reading test must round as Postgres rounds
  // into numeric(14, 6). `toFixed` rounds the binary double, so a decimal tie
  // like 1.3000005 reads as 1.300000 while the stored row holds 1.300001 — and
  // the re-run reports its own unchanged reading as a changed one (which
  // --overwrite would then rewrite, conflicting every open proposal on it).
  it('recognises its own reading at a decimal tie of the stored scale', async () => {
    const tieDoc = {
      ...ENTRY_DOC,
      kinetixParameterValues: [
        {
          ...ENTRY_DOC.kinetixParameterValues[0]!,
          sourceValues: [
            { sourceId: 'S1', low: 0.7, high: 1.3000005, median: 1, unit: 'h', n: 12 },
          ],
        },
      ],
    };
    const first = await runImport(db, parse(tieDoc), { userId, overwrite: false });
    const second = await runImport(db, parse(tieDoc), { userId, overwrite: false });

    expect(second.entries).toBe(0);
    expect(second.entriesSkipped).toBe(1);
    expect(second.entriesKept).toEqual([]);
    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.high).toBe('1.300001');
  });

  // A document re-researched after migration 0135 labels its readings. The
  // unlabelled row an older import wrote for the same paper is the SAME
  // observation, so the label must reconcile against it — reported, or applied
  // under --overwrite — never insert the paper a second time.
  it('reconciles a newly labelled reading against the unlabelled row it wrote', async () => {
    const first = await runImport(db, parse(ENTRY_DOC), { userId, overwrite: false });
    const labelledDoc = {
      ...ENTRY_DOC,
      kinetixParameterValues: [
        {
          ...ENTRY_DOC.kinetixParameterValues[0]!,
          sourceValues: [
            {
              sourceId: 'S1',
              low: 0.7,
              high: 1.3,
              centralValue: 1,
              centralStatistic: 'arithmetic_mean',
              intervalKind: 'range',
              unit: 'h',
              n: 12,
            },
            ENTRY_DOC.kinetixParameterValues[0]!.sourceValues[1]!,
          ],
        },
      ],
    };

    const kept = await runImport(db, parse(labelledDoc), { userId, overwrite: false });
    expect(kept.entries).toBe(0);
    expect(kept.entriesKept).toEqual([{ parameter: 'halfLife', entries: 1 }]);

    const applied = await runImport(db, parse(labelledDoc), { userId, overwrite: true });
    expect(applied.entries).toBe(0);
    expect(applied.entriesUpdated).toBe(1);

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    expect(rows).toHaveLength(2);
    const s1 = rows.find((r) => r.n === 12)!;
    expect(s1).toMatchObject({
      median: null,
      centralValue: '1.000000',
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'range',
    });
  });

  it('reports a changed reading instead of applying or duplicating it', async () => {
    const first = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });
    const corrected = structuredClone(ENTRY_DOC);
    corrected.kinetixParameterValues[0]!.sourceValues[0]!.median = 1.05;

    const second = await runImport(db, parse(corrected), {
      userId,
      overwrite: false,
    });

    expect(second.entries).toBe(0);
    expect(second.entriesUpdated).toBe(0);
    expect(second.entriesKept).toEqual([{ parameter: 'halfLife', entries: 1 }]);
    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.median)).sort()).toEqual([1, 1.6]);
  });

  it('--overwrite corrects its own row in place rather than pooling both readings', async () => {
    const first = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });
    const corrected = structuredClone(ENTRY_DOC);
    corrected.kinetixParameterValues[0]!.sourceValues[0]!.median = 1.05;

    const second = await runImport(db, parse(corrected), {
      userId,
      overwrite: true,
    });

    expect(second.entriesUpdated).toBe(1);
    expect(second.entries).toBe(0);
    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.median)).sort()).toEqual([1.05, 1.6]);
  });

  it('never rewrites a row a human authored, even from the same paper', async () => {
    const first = await runImport(db, parse(ENTRY_DOC), {
      userId,
      overwrite: false,
    });
    const [seeded] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId))
      .limit(1);
    // A curator's own reading of the same paper — a second observation, not a
    // correction of ours.
    await db.insert(parameterEntries).values({
      drugId: first.drugId,
      parameter: 'halfLife',
      median: '0.9',
      unit: 'h',
      citationId: seeded!.citationId,
      createdBy: userId,
      origin: 'contributor',
    });

    const corrected = structuredClone(ENTRY_DOC);
    corrected.kinetixParameterValues[0]!.sourceValues[0]!.median = 1.05;
    await runImport(db, parse(corrected), { userId, overwrite: true });

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, first.drugId));
    const contributor = rows.filter((r) => r.origin === 'contributor');
    expect(contributor).toHaveLength(1);
    expect(Number(contributor[0]!.median)).toBe(0.9);
  });
  // Every entry written before migration 0119 carries no source quote, and the
  // sentences cannot be reconstructed by hand — so for importer-owned rows a
  // re-import is the only route by which they can ever acquire one. That route
  // has to survive the idempotency check, which classifies a row by its NUMBERS.
  describe('reconciling a source quote on an unchanged reading', () => {
    const quoted = (quote: string) => {
      const doc = structuredClone(ENTRY_DOC);
      (doc.kinetixParameterValues[0]!.sourceValues[0]! as { quote?: string })
        .quote = quote;
      return doc;
    };
    const QUOTE = 'The mean terminal half-life was 1.0 h (range 0.7–1.3).';
    const ACCENTED = 'La demi-vie terminale était de 1,0 h.';

    it('backfills a quote onto its own unchanged row under --overwrite', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });

      const second = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });

      // Updated, not inserted: the reading is the same observation.
      expect(second.entriesUpdated).toBe(1);
      expect(second.entries).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => Number(r.median) === 1)!.sourceQuote).toBe(QUOTE);
      // The numbers are untouched — only the provenance was filled in.
      expect(rows.map((r) => Number(r.median)).sort()).toEqual([1, 1.6]);
    });

    // `n` is the other thing the sentence states, and it weights the aggregate.
    // A document that corrects the cohort size without moving the number is
    // describing the SAME observation, so it lands in this branch — and a
    // reconciliation that wrote only the quote would leave the row asserting a
    // corrected sentence over the old sample size.
    it('corrects the cohort size together with the quote on an unchanged reading', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });

      const corrected = quoted('In 24 subjects the mean half-life was 1.0 h.');
      (corrected.kinetixParameterValues[0]!.sourceValues[0]! as { n?: number })
        .n = 24;
      const second = await runImport(db, parse(corrected), {
        userId,
        overwrite: true,
      });

      expect(second.entriesUpdated).toBe(1);
      expect(second.entries).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const row = rows.find((r) => Number(r.median) === 1)!;
      expect(row.sourceQuote).toBe('In 24 subjects the mean half-life was 1.0 h.');
      expect(row.n).toBe(24);
    });

    // The importer under `--overwrite` is a direct writer of this table, like
    // the admin routes, and a proposal queued against a row it rewrites is now
    // stale. Leaving it approvable is how an approval silently reverses the
    // import — and, worse, how an UNATTENDED approval publishes: the consensus
    // gate resolves what the entry will carry from the row as it was before
    // the rewrite, while the write it authorizes evaluates against the row as
    // it is after, which can clear the very quote the gate was promised.
    it('conflicts a pending proposal against a row it rewrites', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const target = rows.find((r) => Number(r.median) === 1)!;

      const [proposal] = await db
        .insert(pendingEdits)
        .values({
          editType: 'param_entry',
          targetId: target.id,
          parameter: 'halfLife',
          proposedValue: {
            op: 'update',
            patch: { median: 1, unit: 'h', comments: 'Typo fixed.' },
          } as never,
          status: 'pending',
          submittedBy: userId,
        })
        .returning({ id: pendingEdits.id });

      // The same reading with a corrected cohort size: identical numbers, so it
      // reconciles the row in place rather than inserting beside it.
      const corrected = quoted(QUOTE);
      (corrected.kinetixParameterValues[0]!.sourceValues[0]! as { n?: number })
        .n = 24;
      await runImport(db, parse(corrected), { userId, overwrite: true });

      const [after] = await db
        .select()
        .from(pendingEdits)
        .where(eq(pendingEdits.id, proposal!.id));
      expect(
        (after!.proposedMeta as Record<string, unknown> | null)?.conflict,
      ).toBeTruthy();
    });

    // The mirror of the case above, and the one that makes the rule consistent
    // with the PATCH path: `n` is in `SOURCE_QUOTE_EVIDENCE_FIELDS`, so a
    // cohort size that moves detaches a quote nobody has replaced. Every
    // document written before this field existed is silent about the quote, so
    // this is the ordinary shape of a correction, not an exotic one.
    it('detaches the quote when a silent document corrects the cohort size', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });

      // The same numbers, a corrected `n`, and no `quote` key anywhere.
      const corrected = structuredClone(ENTRY_DOC);
      (corrected.kinetixParameterValues[0]!.sourceValues[0]! as { n?: number })
        .n = 24;
      await runImport(db, parse(corrected), { userId, overwrite: true });

      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const row = rows.find((r) => Number(r.median) === 1)!;
      expect(row.n).toBe(24);
      // "in 12 participants" is not evidence for a reading filed as n=24, and
      // the sample size is what weights the row in the pooled aggregate.
      expect(row.sourceQuote).toBeNull();
    });

    it('reports a quote-only change without --overwrite rather than applying it', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });

      const second = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: false,
      });

      expect(second.entriesUpdated).toBe(0);
      expect(second.entries).toBe(0);
      expect(second.entriesKept).toEqual([{ parameter: 'halfLife', entries: 1 }]);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sourceQuote == null)).toBe(true);
    });

    // The mirror of the backfill case, and the more dangerous direction. A
    // document written before this field existed omits `quote` on EVERY
    // reading — that is the whole reason it stays optional. Re-importing one
    // under --overwrite to correct a number must not take the silence as an
    // instruction to delete provenance the document never mentioned, which may
    // have been added by a curator by hand and cannot be reconstructed.
    it('keeps a stored quote when the document does not mention one', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: false,
      });
      const before = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      expect(before.sourceQuote).toBe(QUOTE);

      // The older document: same readings, no `quote` key anywhere.
      const second = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: true,
      });

      expect(second.entriesUpdated).toBe(0);
      expect(second.entries).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => Number(r.median) === 1)!.sourceQuote).toBe(QUOTE);
    });

    // …but silence must NOT preserve it when the reading itself changes. The
    // rule is one rule, not two: a quote is evidence for a specific reading, so
    // it survives exactly as long as that reading does. Keeping a sentence that
    // states 1.0 h against a corrected value of 1.05 h would attach words from
    // the document to a number the document does not state — the very error a
    // stored quote exists to expose.
    it('clears the quote when an unquoted document changes the reading', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: false,
      });
      const corrected = structuredClone(ENTRY_DOC);
      corrected.kinetixParameterValues[0]!.sourceValues[0]!.median = 1.05;

      await runImport(db, parse(corrected), { userId, overwrite: true });

      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const updated = rows.find((r) => Number(r.median) === 1.05)!;
      expect(updated.sourceQuote).toBeNull();
    });

    it('takes a replacement quote the corrected document supplies', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: false,
      });
      const corrected = structuredClone(quoted('Corrected: the mean was 1.05 h.'));
      corrected.kinetixParameterValues[0]!.sourceValues[0]!.median = 1.05;

      await runImport(db, parse(corrected), { userId, overwrite: true });

      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows.find((r) => Number(r.median) === 1.05)!.sourceQuote).toBe(
        'Corrected: the mean was 1.05 h.',
      );
    });

    // Clearing still has to be possible — the guard is against silence, not
    // against intent — so an explicit null in the document removes it.
    it('clears the quote when the document says so explicitly', async () => {
      const first = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: false,
      });
      const cleared = structuredClone(ENTRY_DOC);
      (
        cleared.kinetixParameterValues[0]!.sourceValues[0]! as {
          quote?: string | null;
        }
      ).quote = null;

      const second = await runImport(db, parse(cleared), {
        userId,
        overwrite: true,
      });

      expect(second.entriesUpdated).toBe(1);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows.find((r) => Number(r.median) === 1)!.sourceQuote).toBeNull();
    });

    // The trap in this fix. A quote is provenance ABOUT a reading, not part of
    // the reading, so it must not make an incoming value look like a different
    // observation: an incoming value with no matching row is INSERTED, and a
    // second row from the same paper double-weights it in the aggregate. Guard
    // it on a human's row, which the importer may never rewrite and so cannot
    // reconcile — the case where an over-eager identity check does its damage.
    // Identity has to be wide enough as well as narrow enough. The importer's
    // own row can be re-scoped by a curator to a specific administration route
    // — an oral Tmax and an intravenous one from the same paper, matrix and
    // scenario are the comparison the paper exists to report, not one reading
    // recorded twice. If the identity ignores the route, a re-import writes one
    // source value's sentence and cohort size onto the other observation's
    // record: provenance that reads correct, attached to a number it does not
    // describe. That is the #1201 failure class with the quote itself as the
    // carrier.
    // A document re-exported with its accents composed the other way states the
    // SAME sentence — the update and the merge both define those forms as one.
    // Calling it a change is wrong in both modes: without --overwrite the
    // importer reports the entry kept when nothing differs, and with it the
    // rewrite marks every open proposal against the row conflicted, sending
    // contributors to rebase against a change nobody made.
    it('does not call a re-encoded quote a change', async () => {
      const first = await runImport(db, parse(quoted(ACCENTED.normalize('NFC'))), {
        userId,
        overwrite: true,
      });
      const before = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      expect(before.sourceQuote).toBe(ACCENTED.normalize('NFC'));

      const second = await runImport(
        db,
        parse(quoted(ACCENTED.normalize('NFD'))),
        { userId, overwrite: true },
      );

      // Nothing was rewritten and nothing was reported as kept-back.
      expect(second.entriesUpdated).toBe(0);
      expect(second.entriesKept).toHaveLength(0);
      const after = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => r.id === before.id)!;
      expect(after.sourceQuote).toBe(before.sourceQuote);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    // …and a genuinely different sentence is still a change, or the fix to the
    // false positive would have closed the backfill this branch exists for.
    it('still backfills a sentence that really differs', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });
      const second = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });
      expect(second.entriesUpdated).toBe(1);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows.find((r) => Number(r.median) === 1)!.sourceQuote).toBe(QUOTE);
    });

    it('never writes a quote onto a row scoped to another route', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });
      const seeded = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      // A curator recognises the reading as the intravenous arm and says so.
      await db
        .update(parameterEntries)
        .set({ route: 'iv' })
        .where(eq(parameterEntries.id, seeded.id));

      const second = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });

      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const scoped = rows.find((r) => r.id === seeded.id)!;
      // The other observation's record is left exactly as the curator left it.
      expect(scoped.route).toBe('iv');
      expect(scoped.sourceQuote).toBeNull();
      // The document's own reading lands on a row of its own, where a curator
      // can see both and merge them if they really are one observation.
      const unscoped = rows.filter(
        (r) => r.route === null && Number(r.median) === 1,
      );
      expect(unscoped).toHaveLength(1);
      expect(unscoped[0]!.sourceQuote).toBe(QUOTE);
    });

    it('never duplicates a human’s reading when the document gains a quote', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });
      const seeded = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      // Re-own that exact reading as a curator's, so the importer has no row of
      // its own to reconcile and the quote has nowhere legitimate to go.
      await db
        .update(parameterEntries)
        .set({ origin: 'contributor', createdBy: userId })
        .where(eq(parameterEntries.id, seeded.id));

      const second = await runImport(db, parse(quoted(QUOTE)), {
        userId,
        overwrite: true,
      });

      expect(second.entries).toBe(0);
      expect(second.entriesUpdated).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      // The curator's row is untouched — numbers, origin and absent quote.
      const contributor = rows.filter((r) => r.origin === 'contributor');
      expect(contributor).toHaveLength(1);
      expect(Number(contributor[0]!.median)).toBe(1);
      expect(contributor[0]!.sourceQuote).toBeNull();
    });
  });

  // #1289: `observationContext` is in `SOURCE_QUOTE_EVIDENCE_FIELDS`
  // (src/lib/parameterEntries.ts) — a change to it is a change to what the
  // reading IS, so it reconciles on an unchanged reading like `n`, and it
  // detaches a stored quote like `n` does, while a silent document preserves
  // it like a silent document preserves a stored quote.
  describe('reconciling observation context on an unchanged reading', () => {
    const withContext = (context: string) => {
      const doc = structuredClone(ENTRY_DOC);
      (
        doc.kinetixParameterValues[0]!.sourceValues[0]! as {
          observationContext?: string;
        }
      ).observationContext = context;
      return doc;
    };
    const CONTEXT = 'Adult postoperative patients, single dose.';

    it('backfills context onto its own unchanged row under --overwrite', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });

      const second = await runImport(db, parse(withContext(CONTEXT)), {
        userId,
        overwrite: true,
      });

      expect(second.entriesUpdated).toBe(1);
      expect(second.entries).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => Number(r.median) === 1)!.observationContext).toBe(
        CONTEXT,
      );
      expect(rows.map((r) => Number(r.median)).sort()).toEqual([1, 1.6]);
    });

    it('reports a context-only change without --overwrite rather than applying it', async () => {
      const first = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: false,
      });

      const second = await runImport(db, parse(withContext(CONTEXT)), {
        userId,
        overwrite: false,
      });

      expect(second.entriesUpdated).toBe(0);
      expect(second.entries).toBe(0);
      expect(second.entriesKept).toEqual([{ parameter: 'halfLife', entries: 1 }]);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.observationContext == null)).toBe(true);
    });

    it('keeps a stored context when the document does not mention one', async () => {
      const first = await runImport(db, parse(withContext(CONTEXT)), {
        userId,
        overwrite: false,
      });
      const before = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      expect(before.observationContext).toBe(CONTEXT);

      // The older document: same reading, no `observationContext` key anywhere.
      const second = await runImport(db, parse(ENTRY_DOC), {
        userId,
        overwrite: true,
      });

      expect(second.entriesUpdated).toBe(0);
      expect(second.entries).toBe(0);
      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      expect(
        rows.find((r) => Number(r.median) === 1)!.observationContext,
      ).toBe(CONTEXT);
    });

    it('detaches a stored quote when a silent document corrects the context', async () => {
      const quotedWithContext = withContext(CONTEXT);
      (
        quotedWithContext.kinetixParameterValues[0]!.sourceValues[0]! as {
          quote?: string;
        }
      ).quote = 'The mean terminal half-life was 1.0 h.';
      const first = await runImport(db, parse(quotedWithContext), {
        userId,
        overwrite: true,
      });
      const before = (
        await db
          .select()
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, first.drugId))
      ).find((r) => Number(r.median) === 1)!;
      expect(before.sourceQuote).not.toBeNull();

      // The same reading, a corrected context, and no `quote` key anywhere.
      const corrected = withContext('Healthy volunteers, repeated dosing.');
      await runImport(db, parse(corrected), { userId, overwrite: true });

      const rows = await db
        .select()
        .from(parameterEntries)
        .where(eq(parameterEntries.drugId, first.drugId));
      const row = rows.find((r) => Number(r.median) === 1)!;
      expect(row.observationContext).toBe('Healthy volunteers, repeated dosing.');
      // The old sentence is not evidence for a reading now filed under a
      // different population/regimen.
      expect(row.sourceQuote).toBeNull();
    });
  });

  it('skips a parameter the substance cannot have, and reports it', async () => {
    // This store writes drug_parameters directly rather than through
    // upsertDrugParameter, so it does not inherit that guard. Without its own
    // check an import publishes a value for a pair the gap queue has been told
    // cannot exist — monograph serving a number the queue calls impossible.
    const drugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    await db.insert(drugParameterApplicability).values({
      drugId,
      parameter: 'halfLife',
      reason: 'Not a defined quantity for this substance.',
    });

    const stats = await runImport(db, parse(DOC), { userId, overwrite: true });

    expect(stats.parametersNotApplicable).toEqual(['halfLife']);
    const stored = await db
      .select({ parameter: drugParameters.parameter })
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect(stored.map((r) => r.parameter)).not.toContain('halfLife');
    // The rest of the document still imports — one impossible parameter must
    // not fail a twenty-parameter run.
    expect(stored.map((r) => r.parameter)).toContain('pKa');
  });

  it('skips a parameter ruled out by the substance class', async () => {
    const drugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
      substanceClass: 'metabolite',
    });
    const doc = structuredClone(DOC);
    doc.kinetixParameterValues[0] = {
      parameter: 'bioavailability',
      status: 'finalized',
      value: { min: 0.5, max: 0.6, unit: 'fraction' },
      sourceIds: ['S1'],
    } as never;

    const stats = await runImport(db, parse(doc), { userId, overwrite: true });

    expect(stats.parametersNotApplicable).toEqual(['bioavailability']);
    const stored = await db
      .select({ parameter: drugParameters.parameter })
      .from(drugParameters)
      .where(eq(drugParameters.drugId, drugId));
    expect(stored.map((r) => r.parameter)).not.toContain('bioavailability');
  });

  it('imports normally when nothing is marked', async () => {
    const stats = await runImport(db, parse(DOC), { userId, overwrite: false });
    expect(stats.parametersNotApplicable).toEqual([]);
  });
});
