/**
 * Seed the drugs table (plus metabolism profiles, metabolite links and
 * elimination routes) from data/components.ts. Idempotent via ON CONFLICT
 * upsert on pubchem_cid.
 *
 * Analytical methods are not seeded here: the analytical_methods /
 * analytical_method_components tables are maintained in the database only
 * (served by /api/methods), and this script leaves them untouched.
 *
 * Usage:
 *   npm run seed:drugs          (reads DATABASE_URL from .env)
 *   DATABASE_URL=... npm run seed:drugs
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq } from 'drizzle-orm';
import { embeddedComponents } from '../data/components';
import { seededSubstanceClass } from '../data/substanceClasses';
import {
  blockedParametersFor,
  withDrugApplicabilityLock,
} from '../api/_lib/parameterApplicabilityStore';
import { getDb } from '../api/_lib/db';
import {
  drugs,
  drugParameters,
  drugMetabolismProfiles,
  drugMetabolites,
  drugEliminationRoutes,
  bioEntities,
  bioEntityFunctions,
} from '../db/schema';
import { generateSlug } from '../api/_lib/slug';
import {
  DRUG_PARAMETERS,
  DRUG_PARAMETER_IDS,
  type DrugParameterId,
} from '../src/lib/drugParameters';
import { isStoredInDrugParameters } from '../api/_lib/drugParameterStore';
import { buildDrugSearchKey } from '../src/lib/drugNames';
import { fixtureFieldForParameter } from '../src/lib/catalogExport';
import {
  inferMetaboliteActivity,
  normalizeMetabolismName,
} from '../src/lib/metabolism';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = neon(DATABASE_URL);
const db = drizzle(client);

// The set of grouped parameters this seed script owns. Constraining
// the cleanup loop to this list — rather than every grouped id in the
// registry — prevents reseeding from wiping curated drug_parameters
// rows for parameters added by later PRs (e.g. Ki/IC50 once the spec
// registry expands) that aren't represented in `data/components.ts`.
// NB: the three interpretive bands (therapeuticConcentration /
// toxicConcentration / fatalConcentration) are deliberately NOT in this list
// even though the seeder now writes them. This list drives DELETION of
// drug_parameters rows the fixture no longer carries, and those three are
// curated through the /review queue and parameter_entries aggregation for far
// more drugs than the fixture covers — owning them here would make a re-seed
// wipe reviewed forensic thresholds. Write-only is the safe half.
const SEED_OWNED_PARAMETER_IDS: readonly DrugParameterId[] = [
  'molecularWeight',
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  'pKa',
];

interface SeedIndex {
  pubchemToDrugId: Map<number, number>;
  nameToDrugId: Map<string, number>;
}

function namesFromRaw(c: {
  name: string;
  nameEn?: string;
}): Record<string, string> {
  const names: Record<string, string> = { nb: c.name };
  if (c.nameEn) names.en = c.nameEn;
  return names;
}

function compactUnique(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const key = normalizeMetabolismName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function softValidateParam(
  paramId: DrugParameterId,
  value: unknown,
  drugName: string,
): unknown {
  if (value === null || value === undefined) return null;
  const spec = DRUG_PARAMETERS[paramId];
  const result = spec.zod.safeParse(value);
  if (!result.success) {
    console.warn(
      `[warn] ${drugName}: ${paramId} failed validation (stored as-is): ` +
        result.error.issues.map((i) => i.message).join('; '),
    );
    return value;
  }
  return result.data;
}

async function seedDrugs(): Promise<SeedIndex> {
  console.log(`Seeding ${embeddedComponents.length} drugs…`);
  const pubchemToDrugId = new Map<number, number>();
  const nameToDrugId = new Map<string, number>();
  const slugsSeen = new Set<string>();
  // Fixture values withheld because the pair is not a defined quantity for the
  // substance. Reported at the end rather than dropped silently: from the
  // operator's side a missing value otherwise looks like a fixture gap.
  const skippedNotApplicable: string[] = [];

  for (const c of embeddedComponents) {
    const baseSlug = generateSlug(c.nameEn || c.name);
    let slug = baseSlug;
    let suffix = 2;
    while (slugsSeen.has(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }
    slugsSeen.add(slug);

    const paramValues: Partial<Record<DrugParameterId, unknown>> = {};
    for (const pid of DRUG_PARAMETER_IDS) {
      // Read by the fixture's key, not the registry id. Most are identical, but
      // the three interpretive bands are not: the registry calls them
      // therapeuticConcentration / toxicConcentration / fatalConcentration
      // while the fixture stores therapeuticRange / toxicRange / lethalRange.
      // Indexing by the registry id alone silently returned undefined for all
      // three, so seeding never wrote them — 68 of the 171 committed entries
      // carry at least one, and every one of those forensic thresholds was
      // dropped on the way into the database.
      // Via `unknown`: `fixtureFieldForParameter` returns a plain `string`, and
      // `RawComponent` is an interface, so it carries no implicit index
      // signature to index into.
      paramValues[pid] = softValidateParam(
        pid,
        (c as unknown as Record<string, unknown>)[fixtureFieldForParameter(pid)],
        c.name,
      );
    }

    const names = namesFromRaw(c);
    const searchKey = buildDrugSearchKey({ names });

    // Drug-row metadata only — molecularWeight + the seven range
    // parameters now live in drug_parameters (#302 P2).
    const [inserted] = await db
      .insert(drugs)
      .values({
        slug,
        names,
        aliases: [],
        pubchemCid: c.pubchemCid,
        searchKey,
        // Analytes are classified at insert so a from-scratch database gets the
        // same applicability rules an existing one got from migration 0097 —
        // otherwise every shipped metabolite seeds as 'drug' and its
        // permanently unfillable parameters go straight back into the agent's
        // gap queue. Undefined leaves the column default ('drug').
        substanceClass: seededSubstanceClass(c.pubchemCid),
      })
      .onConflictDoUpdate({
        target: drugs.pubchemCid,
        set: {
          names,
          searchKey,
          updatedAt: new Date(),
          // substanceClass is deliberately NOT reset here. It is a scientific
          // judgement an editor may have corrected in the database, and a
          // reseed must not silently revert that — same reason `aliases` is
          // insert-only above.
        },
      })
      .returning({ id: drugs.id, pubchemCid: drugs.pubchemCid });

    if (inserted?.pubchemCid) {
      pubchemToDrugId.set(inserted.pubchemCid, inserted.id);
      for (const name of Object.values(names)) {
        const key = normalizeMetabolismName(name);
        if (key && !nameToDrugId.has(key)) nameToDrugId.set(key, inserted.id);
      }
    }

    // Upsert each grouped parameter (molecularWeight + ranges) into
    // drug_parameters and delete rows for parameters omitted from the
    // embedded data so reseeding clears stale values (matches the
    // pre-#302 column-based seed which set them to NULL on conflict).
    // The seed script has no human user, so updated_by stays NULL —
    // that's allowed by the column definition.
    if (inserted) {
      const presentValues = new Map<DrugParameterId, unknown>();
      if (c.molecularWeight !== undefined) {
        presentValues.set('molecularWeight', c.molecularWeight);
      }
      for (const pid of DRUG_PARAMETER_IDS) {
        if (!isStoredInDrugParameters(pid)) continue;
        if (pid === 'molecularWeight') continue; // handled above
        const v = paramValues[pid];
        if (v !== null && v !== undefined) {
          presentValues.set(pid, v);
        }
      }
      // Check and write as one locked unit, on the per-drug applicability lock.
      //
      // These writes bypass upsertDrugParameter and so inherit none of its
      // applicability guard. Without the check a reseed deterministically
      // recreates the contradiction the API refuses to create: an editor clears
      // a fixture-backed value and marks the pair not applicable (or
      // reclassifies the substance), and the next `npm run seed:drugs` restores
      // the fixture value alongside the marker forbidding it. Note the ordering
      // above — the drug upsert deliberately does NOT reset substance_class on
      // conflict, so the editor's classification is what this reads back.
      //
      // And without the lock the check is a check-then-write: a full reseed
      // takes a while, so an editor marking a pair partway through is a real
      // overlap. Per drug rather than per run, so no lock is held across the
      // whole catalogue.
      await withDrugApplicabilityLock(inserted.id, async () => {
        const tx = getDb();
        const blockedForDrug = await blockedParametersFor(
          tx,
          inserted.id,
          [...presentValues.keys()],
        );
        for (const parameter of blockedForDrug) {
          skippedNotApplicable.push(`${slug}:${parameter}`);
        }

        for (const [id, value] of presentValues) {
          if (blockedForDrug.includes(id)) continue;
          const row = {
            drugId: inserted.id,
            parameter: id,
            value: value as never,
          };
          // Only parameters this script OWNS may overwrite an existing row.
          //
          // The three interpretive concentration bands are seeded (so a fresh
          // database gets them — before the fixtureFieldForParameter fix they
          // were never written at all) but are not seed-owned: their
          // drug_parameters.value is a recomputed cache over reviewed
          // `parameter_entries` (weighted median + IQR). Overwriting one would
          // replace a current aggregate with a stale fixture scalar and leave it
          // wrong until the next entry mutation triggered a recompute. Insert
          // when absent, never clobber.
          if (!SEED_OWNED_PARAMETER_IDS.includes(id)) {
            await tx.insert(drugParameters).values(row).onConflictDoNothing({
              target: [drugParameters.drugId, drugParameters.parameter],
            });
            continue;
          }
          await tx
            .insert(drugParameters)
            .values(row)
            .onConflictDoUpdate({
              target: [drugParameters.drugId, drugParameters.parameter],
              set: {
                value: value as never,
                updatedAt: new Date(),
              },
            });
        }
        // Delete drug_parameters rows for the seed-owned grouped ids
        // that the embedded record no longer carries; without this, a
        // re-seed with an updated `data/components.ts` couldn't clear
        // bad values. Scoped to SEED_OWNED_PARAMETER_IDS so future
        // grouped parameters (e.g. Ki/IC50) added by later PRs and
        // populated through the UI/API are never collateral-deleted.
        for (const pid of SEED_OWNED_PARAMETER_IDS) {
          if (presentValues.has(pid)) continue;
          await tx
            .delete(drugParameters)
            .where(
              and(
                eq(drugParameters.drugId, inserted.id),
                eq(drugParameters.parameter, pid),
              ),
            );
        }
      });
    }
  }
  console.log(`  → ${pubchemToDrugId.size} drugs upserted.`);
  if (skippedNotApplicable.length) {
    console.log(
      `  → ${skippedNotApplicable.length} parameter(s) skipped as not applicable ` +
        `to their substance: ${skippedNotApplicable.join(', ')}`,
    );
  }
  return { pubchemToDrugId, nameToDrugId };
}

async function seedMetabolism(index: SeedIndex): Promise<void> {
  console.log('Seeding elimination routes and metabolite links…');
  let routeCount = 0;
  let metaboliteCount = 0;

  // Match the static enzyme strings to canonical bio_entities rows (filtered to
  // the metabolic_enzyme function) so seeded routes link to a first-class entity
  // when one exists. #791 Part B: the legacy `enzymes` table was decommissioned.
  const enzymeRows = await db
    .select({
      id: bioEntities.id,
      symbol: bioEntities.symbol,
      name: bioEntities.name,
      nameEn: bioEntities.nameEn,
    })
    .from(bioEntities)
    .innerJoin(
      bioEntityFunctions,
      eq(bioEntityFunctions.entityId, bioEntities.id),
    )
    .where(eq(bioEntityFunctions.function, 'metabolic_enzyme'));
  const enzymeIdByKey = new Map<string, number>();
  for (const e of enzymeRows) {
    for (const key of [e.symbol, e.name, e.nameEn]) {
      if (key) enzymeIdByKey.set(key.trim().toLowerCase(), e.id);
    }
  }

  for (const c of embeddedComponents) {
    const drugId = index.pubchemToDrugId.get(c.pubchemCid);
    if (!drugId) continue;

    await db
      .delete(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, drugId));
    await db
      .delete(drugEliminationRoutes)
      .where(eq(drugEliminationRoutes.drugId, drugId));
    await db
      .delete(drugMetabolismProfiles)
      .where(eq(drugMetabolismProfiles.drugId, drugId));

    const metabolism = c.metabolism;
    if (!metabolism) continue;

    const enzymeLabels = compactUnique(metabolism.enzymes);
    const eliminationRoutes = compactUnique(metabolism.eliminationRoutes);
    const metabolites = compactUnique(metabolism.metabolites);

    const routeRows = [
      ...enzymeLabels.map((label) => ({
        drugId,
        kind: 'enzyme' as const,
        bioEntityId: enzymeIdByKey.get(label.trim().toLowerCase()) ?? null,
        label,
      })),
      ...eliminationRoutes.map((label) => ({
        drugId,
        kind: 'other_unchanged' as const,
        label,
      })),
    ].map((row, sortOrder) => ({ ...row, sortOrder }));

    if (routeRows.length > 0) {
      await db.insert(drugEliminationRoutes).values(routeRows);
      routeCount += routeRows.length;
    }

    // `compactUnique` dedupes the fixture's spellings; this dedupes the
    // substances behind them. Several catalog entries name one metabolite more
    // than once (a bare name and an abbreviation — "ecgonine methyl ester" and
    // "EME"), which resolve to the same drug and are one link, not two. Since
    // 0099 the table says so too, so a second row is a unique violation rather
    // than the duplicate line the monograph used to print.
    const seenMetaboliteDrugIds = new Set<number>();
    const rows: {
      parentDrugId: number;
      metaboliteDrugId: number | null;
      metaboliteName: string;
      activity: ReturnType<typeof inferMetaboliteActivity>;
      sortOrder: number;
    }[] = [];
    for (const metaboliteName of metabolites) {
      const metaboliteDrugId =
        index.nameToDrugId.get(normalizeMetabolismName(metaboliteName)) ?? null;
      if (metaboliteDrugId !== null) {
        if (seenMetaboliteDrugIds.has(metaboliteDrugId)) continue;
        seenMetaboliteDrugIds.add(metaboliteDrugId);
      }
      rows.push({
        parentDrugId: drugId,
        metaboliteDrugId,
        metaboliteName,
        activity: inferMetaboliteActivity(metaboliteName),
        sortOrder: rows.length,
      });
    }
    if (rows.length > 0) {
      await db.insert(drugMetabolites).values(rows);
      metaboliteCount += rows.length;
    }
  }

  console.log(
    `  → ${routeCount} elimination routes, ${metaboliteCount} metabolite links seeded.`,
  );
}

async function main(): Promise<void> {
  const seedIndex = await seedDrugs();
  await seedMetabolism(seedIndex);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
