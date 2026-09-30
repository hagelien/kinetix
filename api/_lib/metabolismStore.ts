import { asc, eq, inArray } from 'drizzle-orm';
import {
  bioEntities,
  drugEliminationRoutes,
  drugInteractions,
  drugMetabolismProfiles,
  drugMetabolites,
  drugs,
} from '../../db/schema.js';
import type {
  DrugEliminationRoute,
  DrugMetaboliteLink,
  DrugMetabolism,
  EliminationRouteKind,
  EntityMetabolismDrug,
  MetabolismFractionRange,
  MetaboliteActivity,
  RelatedMetabolismDrug,
} from '../../src/lib/metabolism.js';
import {
  dedupeMetaboliteLinks,
  fractionRangeRepresentative,
  normalizeMetabolismName,
} from '../../src/lib/metabolism.js';
import { ENTITY_RANKS, type EntityRank } from '../../src/lib/bioEntities.js';
import { isUniqueViolation } from './drugs-helpers.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Build a 0–1 fraction range from its three stored columns (drizzle numerics
// round-trip as strings). Returns null when the range carries nothing.
function fractionRangeFromColumns(
  min: unknown,
  median: unknown,
  max: unknown,
): MetabolismFractionRange | null {
  const mn = numericOrNull(min);
  const md = numericOrNull(median);
  const mx = numericOrNull(max);
  if (mn === null && md === null && mx === null) return null;
  return { min: mn, median: md, max: mx };
}

function activityOrUnknown(value: string): MetaboliteActivity {
  return value === 'active' || value === 'inactive' ? value : 'unknown';
}

const RANK_SET: ReadonlySet<string> = new Set(ENTITY_RANKS);

function entityRankOrNull(value: string | null): EntityRank | null {
  return value && RANK_SET.has(value) ? (value as EntityRank) : null;
}

const VALID_ROUTE_KINDS: ReadonlySet<string> = new Set([
  'enzyme',
  'metabolized',
  'renal_unchanged',
  'fecal_biliary',
  'other_unchanged',
]);

function routeKindOrEnzyme(value: string): EliminationRouteKind {
  return (VALID_ROUTE_KINDS.has(value) ? value : 'enzyme') as EliminationRouteKind;
}

function relatedDrug(row: {
  relatedDrugId: number | null;
  relatedSlug: string | null;
  relatedNames: Record<string, string> | null;
  relatedPubchemCid: number | null;
}): RelatedMetabolismDrug | null {
  if (!row.relatedDrugId || !row.relatedSlug || !row.relatedNames) return null;
  return {
    id: row.relatedDrugId,
    slug: row.relatedSlug,
    names: row.relatedNames,
    pubchemCid: row.relatedPubchemCid,
  };
}

function serializeLink(row: {
  id: number;
  parentDrugId: number;
  metaboliteDrugId: number | null;
  metaboliteName: string;
  conversionFraction: unknown;
  conversionFractionMin: unknown;
  conversionFractionMax: unknown;
  activity: string;
  sortOrder: number;
  evidenceNote: string | null;
  referenceIds: number[] | null;
  relatedDrugId: number | null;
  relatedSlug: string | null;
  relatedNames: Record<string, string> | null;
  relatedPubchemCid: number | null;
}): DrugMetaboliteLink {
  return {
    id: row.id,
    parentDrugId: row.parentDrugId,
    metaboliteDrugId: row.metaboliteDrugId,
    metaboliteName: row.metaboliteName,
    conversionFraction: fractionRangeFromColumns(
      row.conversionFractionMin,
      row.conversionFraction,
      row.conversionFractionMax,
    ),
    activity: activityOrUnknown(row.activity),
    sortOrder: row.sortOrder,
    evidenceNote: row.evidenceNote,
    referenceIds: row.referenceIds,
    drug: relatedDrug(row),
  };
}

function serializeRoute(row: {
  id: number;
  kind: string;
  bioEntityId: number | null;
  label: string | null;
  fraction: unknown;
  fractionMin: unknown;
  fractionMax: unknown;
  note: string | null;
  referenceIds: number[] | null;
  sortOrder: number;
  bioSlug: string | null;
  bioSymbol: string | null;
  bioName: string | null;
  bioNameEn: string | null;
  bioClass: string | null;
  bioRank: string | null;
}): DrugEliminationRoute {
  // The unified bio_entities row is the catalog identity. The legacy enzymes
  // fallback was removed once the #785 backfill was verified total and enforced
  // (#791 Part B): a route either resolves to a bio_entity or carries only a
  // free-text label (non-enzyme / unmatched routes). `enzyme.id` is the
  // bio_entity id so the editor round-trips against the unified registry.
  const enzyme =
    row.bioEntityId != null && row.bioSymbol
      ? {
          id: row.bioEntityId,
          slug: row.bioSlug ?? '',
          symbol: row.bioSymbol,
          name: row.bioName ?? row.bioSymbol,
          nameEn: row.bioNameEn,
          enzymeClass: row.bioClass,
          rank: entityRankOrNull(row.bioRank),
        }
      : null;
  return {
    id: row.id,
    kind: routeKindOrEnzyme(row.kind),
    enzymeId: enzyme?.id ?? null,
    enzyme,
    label: row.label,
    fraction: fractionRangeFromColumns(
      row.fractionMin,
      row.fraction,
      row.fractionMax,
    ),
    note: row.note,
    referenceIds: row.referenceIds,
    sortOrder: row.sortOrder,
  };
}

const metaboliteSelect = {
  id: drugMetabolites.id,
  parentDrugId: drugMetabolites.parentDrugId,
  metaboliteDrugId: drugMetabolites.metaboliteDrugId,
  metaboliteName: drugMetabolites.metaboliteName,
  conversionFraction: drugMetabolites.conversionFraction,
  conversionFractionMin: drugMetabolites.conversionFractionMin,
  conversionFractionMax: drugMetabolites.conversionFractionMax,
  activity: drugMetabolites.activity,
  sortOrder: drugMetabolites.sortOrder,
  evidenceNote: drugMetabolites.evidenceNote,
  referenceIds: drugMetabolites.referenceIds,
  relatedDrugId: drugs.id,
  relatedSlug: drugs.slug,
  relatedNames: drugs.names,
  relatedPubchemCid: drugs.pubchemCid,
} as const;

export async function getDrugMetabolism(
  db: Db,
  drugId: number,
): Promise<DrugMetabolism | null> {
  // All four queries are independent — run them in parallel.
  const [[profile], routeRows, metaboliteRows, precursorRows] =
    await Promise.all([
      db
        .select()
        .from(drugMetabolismProfiles)
        .where(eq(drugMetabolismProfiles.drugId, drugId))
        .limit(1),
      db
        .select({
          id: drugEliminationRoutes.id,
          kind: drugEliminationRoutes.kind,
          bioEntityId: drugEliminationRoutes.bioEntityId,
          label: drugEliminationRoutes.label,
          fraction: drugEliminationRoutes.fraction,
          fractionMin: drugEliminationRoutes.fractionMin,
          fractionMax: drugEliminationRoutes.fractionMax,
          note: drugEliminationRoutes.note,
          referenceIds: drugEliminationRoutes.referenceIds,
          sortOrder: drugEliminationRoutes.sortOrder,
          bioSlug: bioEntities.slug,
          bioSymbol: bioEntities.symbol,
          bioName: bioEntities.name,
          bioNameEn: bioEntities.nameEn,
          bioClass: bioEntities.entityClass,
          bioRank: bioEntities.rank,
        })
        .from(drugEliminationRoutes)
        .leftJoin(
          bioEntities,
          eq(drugEliminationRoutes.bioEntityId, bioEntities.id),
        )
        .where(eq(drugEliminationRoutes.drugId, drugId))
        .orderBy(
          asc(drugEliminationRoutes.sortOrder),
          asc(drugEliminationRoutes.id),
        ),
      db
        .select(metaboliteSelect)
        .from(drugMetabolites)
        .leftJoin(drugs, eq(drugMetabolites.metaboliteDrugId, drugs.id))
        .where(eq(drugMetabolites.parentDrugId, drugId))
        .orderBy(asc(drugMetabolites.sortOrder), asc(drugMetabolites.id)),
      db
        .select(metaboliteSelect)
        .from(drugMetabolites)
        .leftJoin(drugs, eq(drugMetabolites.parentDrugId, drugs.id))
        .where(eq(drugMetabolites.metaboliteDrugId, drugId))
        .orderBy(asc(drugMetabolites.sortOrder), asc(drugMetabolites.id)),
    ]);

  // Both link lists are deduped by substance on the way out. The unique index
  // and the write-path checks are what keep duplicates out of the table; this
  // is the read-side net for rows that predate them (see
  // dedupeMetaboliteLinks), so a monograph never lists one metabolite twice.
  const metabolism: DrugMetabolism = {
    routes: routeRows.map(serializeRoute),
    evidenceNote: profile?.evidenceNote ?? null,
    metabolites: dedupeMetaboliteLinks(metaboliteRows.map(serializeLink)),
    precursors: dedupeMetaboliteLinks(precursorRows.map(serializeLink)),
  };

  if (
    metabolism.routes.length === 0 &&
    !metabolism.evidenceNote &&
    metabolism.metabolites.length === 0 &&
    metabolism.precursors.length === 0
  ) {
    return null;
  }

  return metabolism;
}

/**
 * Every drug the metabolism database links to a bio entity, read from the
 * entity's side (the reverse of {@link getDrugMetabolism}'s route list). Backs
 * the entity monograph's "metabolises these drugs" section.
 *
 * Ordered by how much of the dose runs through the entity (largest share
 * first), with fraction-less routes last and ties broken alphabetically, so
 * the entity's most significant substrates lead the list. Sorting happens in
 * JS because the representative value of a range is a fallback chain
 * (median → midpoint → whichever bound exists), not a single column.
 */
export async function listEntityMetabolismDrugs(
  db: Db,
  entityId: number,
): Promise<EntityMetabolismDrug[]> {
  const rows = await db
    .select({
      routeId: drugEliminationRoutes.id,
      fraction: drugEliminationRoutes.fraction,
      fractionMin: drugEliminationRoutes.fractionMin,
      fractionMax: drugEliminationRoutes.fractionMax,
      note: drugEliminationRoutes.note,
      drugId: drugs.id,
      drugSlug: drugs.slug,
      drugNames: drugs.names,
      drugPubchemCid: drugs.pubchemCid,
    })
    .from(drugEliminationRoutes)
    .innerJoin(drugs, eq(drugEliminationRoutes.drugId, drugs.id))
    .where(eq(drugEliminationRoutes.bioEntityId, entityId));

  return rows
    .map((row) => ({
      routeId: row.routeId,
      drug: {
        id: row.drugId,
        slug: row.drugSlug,
        names: row.drugNames ?? {},
        pubchemCid: row.drugPubchemCid,
      },
      fraction: fractionRangeFromColumns(
        row.fractionMin,
        row.fraction,
        row.fractionMax,
      ),
      note: row.note,
    }))
    .sort((a, b) => {
      const fa = fractionRangeRepresentative(a.fraction);
      const fb = fractionRangeRepresentative(b.fraction);
      if (fa !== fb) {
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fb - fa;
      }
      return pickDrugDisplayName(a.drug.names).localeCompare(
        pickDrugDisplayName(b.drug.names),
      );
    });
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * 4xx-mapped error for metabolism write failures (missing drug, dangling
 * link, duplicate name, unique-constraint clash). The API layer surfaces
 * `statusHint` so submitters and reviewers see actionable feedback instead
 * of a generic 500.
 */
export class MetabolismWriteError extends Error {
  constructor(
    message: string,
    public readonly statusHint = 400,
  ) {
    super(message);
    this.name = 'MetabolismWriteError';
  }
}

export interface EliminationRouteWriteInput {
  kind: EliminationRouteKind;
  enzymeId?: number | null;
  fraction?: MetabolismFractionRange | null;
  label?: string | null;
  note?: string | null;
  referenceIds?: number[] | null;
}

export interface MetaboliteWriteInput {
  metaboliteName: string;
  metaboliteDrugId?: number | null;
  conversionFraction?: MetabolismFractionRange | null;
  activity: MetaboliteActivity;
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface PrecursorWriteInput {
  precursorDrugId: number;
  conversionFraction?: MetabolismFractionRange | null;
  activity: MetaboliteActivity;
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismProfileWriteInput {
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismWriteInput {
  profile: MetabolismProfileWriteInput;
  routes: EliminationRouteWriteInput[];
  metabolites: MetaboliteWriteInput[];
  precursors: PrecursorWriteInput[];
}

function pickDrugDisplayName(names: Record<string, string> | null): string {
  if (!names) return '';
  return names.nb || names.en || Object.values(names)[0] || '';
}

// drizzle's numeric columns round-trip as strings; coerce to a fixed string
// (or null) so the stored value matches what getDrugMetabolism reads back.
function fractionToColumn(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function cleanReferenceIds(value: number[] | null | undefined): number[] | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Validate a metabolism write payload against live data without mutating
 * anything: the target drug must exist and carry a name (precursor links
 * anchor on it), every linked metabolite/precursor drug id and every linked
 * enzyme id must resolve, no link may be the drug itself, and metabolite
 * names must be unique within the payload. Returns the target drug's display
 * name so callers can reuse it for precursor rows.
 */
export async function validateMetabolismInput(
  db: Db,
  drugId: number,
  input: MetabolismWriteInput,
): Promise<string> {
  const [drug] = await db
    .select({ id: drugs.id, names: drugs.names })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drug) throw new MetabolismWriteError('Drug not found', 404);
  const drugName = pickDrugDisplayName(drug.names);
  if (!drugName) {
    throw new MetabolismWriteError(
      'Drug has no name to anchor precursor links',
      400,
    );
  }

  const linkedIds = new Set<number>();
  for (const m of input.metabolites) {
    if (m.metaboliteDrugId != null) linkedIds.add(m.metaboliteDrugId);
  }
  for (const p of input.precursors) linkedIds.add(p.precursorDrugId);
  if (linkedIds.has(drugId)) {
    throw new MetabolismWriteError(
      'A drug cannot be its own metabolite or precursor',
      400,
    );
  }
  const linkedNames = new Map<number, Record<string, string> | null>();
  if (linkedIds.size > 0) {
    const found = await db
      .select({ id: drugs.id, names: drugs.names })
      .from(drugs)
      .where(inArray(drugs.id, [...linkedIds]));
    for (const row of found) linkedNames.set(row.id, row.names);
    const missing = [...linkedIds].filter((id) => !linkedNames.has(id));
    if (missing.length > 0) {
      throw new MetabolismWriteError(
        `Linked drug(s) not found: ${missing.join(', ')}`,
        400,
      );
    }
  }

  // #785 Phase 7: route.enzymeId now references the unified bio_entities
  // catalog (the search endpoint serves bio_entity ids), so validate there.
  const entityIds = new Set<number>();
  for (const r of input.routes) {
    if (r.enzymeId != null) entityIds.add(r.enzymeId);
  }
  if (entityIds.size > 0) {
    const found = await db
      .select({ id: bioEntities.id })
      .from(bioEntities)
      .where(inArray(bioEntities.id, [...entityIds]));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = [...entityIds].filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new MetabolismWriteError(
        `Enzyme(s) not found: ${missing.join(', ')}`,
        400,
      );
    }
  }

  // Uniqueness is per substance, not per spelling. A payload may not name the
  // same metabolite twice, however it spells it on the second row: the
  // monograph renders the linked drug's localized name, so two rows pointing
  // at one drug — or a free-text row spelled the way a linked row's drug is
  // spelled in some locale — print the same line twice and are indexed as one
  // row by `drug_metabolites_parent_metabolite_drug_idx`.
  const seen = new Map<string, string>();
  const claim = (identity: string, label: string) => {
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new MetabolismWriteError(
        `Each metabolite may be listed once for this drug: "${previous}" and "${label}" are the same substance`,
        400,
      );
    }
    seen.set(identity, label);
  };

  // Locale spellings of every linked metabolite, so a free-text row naming one
  // of them resolves to that substance rather than to its own string. A name
  // two linked substances share maps to null — `drugs.names` has no cross-drug
  // uniqueness, so a spelling can be one drug's Norwegian name and another's
  // English one, and a free-text row carrying it names neither in particular.
  // Rejecting it as a duplicate of whichever came first would refuse a payload
  // over a collision the editor cannot see.
  const identityByName = new Map<string, string | null>();
  for (const m of input.metabolites) {
    if (m.metaboliteDrugId == null) continue;
    const identity = `drug:${m.metaboliteDrugId}`;
    for (const name of [
      m.metaboliteName,
      ...Object.values(linkedNames.get(m.metaboliteDrugId) ?? {}),
    ]) {
      const key = normalizeMetabolismName(String(name ?? ''));
      if (!key) continue;
      if (!identityByName.has(key)) identityByName.set(key, identity);
      else if (identityByName.get(key) !== identity) {
        identityByName.set(key, null);
      }
    }
  }

  // Two checks, because the table enforces two things. Identity first, since
  // "these are the same substance" is the more useful thing to be told when
  // both apply.
  const labels = new Set<string>();
  for (const m of input.metabolites) {
    const label = m.metaboliteName.trim();
    const key = normalizeMetabolismName(label);
    claim(
      m.metaboliteDrugId != null
        ? `drug:${m.metaboliteDrugId}`
        : ((identityByName.get(key) ?? undefined) ?? `name:${key}`),
      label,
    );
    // `drug_metabolites_parent_name_idx` is still there and still keys on the
    // label, so two *different* substances that display the same name — which
    // the editor prefills from the linked drug, and which `drugs.names` does
    // not keep unique across drugs — cannot both be stored. Accepting the
    // payload here would 500 on the insert for an admin, and queue a
    // contributor edit that fails at approval instead of at submission.
    if (labels.has(key)) {
      throw new MetabolismWriteError(
        `Two metabolites cannot share the name "${label}" — rename one of them`,
        400,
      );
    }
    labels.add(key);
  }

  // Precursors anchor on the drug being edited, so every row carries the same
  // metabolite name — two rows for one precursor differ in nothing at all and
  // would otherwise surface as a bare unique-violation 409.
  const seenPrecursors = new Set<number>();
  for (const p of input.precursors) {
    if (seenPrecursors.has(p.precursorDrugId)) {
      throw new MetabolismWriteError(
        `Each precursor may be listed once for this drug (drug ${p.precursorDrugId} appears twice)`,
        400,
      );
    }
    seenPrecursors.add(p.precursorDrugId);
  }

  return drugName;
}

/**
 * Replace a drug's entire metabolism box (profile note + elimination/metabolism
 * routes + metabolite links + precursor links) with `input`. Metabolites are
 * the rows where the drug is the parent; precursors are the rows where the drug
 * is the metabolite, so editing precursors reuses the same junction table from
 * the reverse side. Must run inside a transaction.
 */
export async function replaceDrugMetabolism(
  db: Db,
  drugId: number,
  input: MetabolismWriteInput,
  userId: number,
): Promise<void> {
  const drugName = await validateMetabolismInput(db, drugId, input);

  // Elimination / metabolism routes. #785 Phase 7: route.enzymeId is a unified
  // bio_entities id, written to bio_entity_id (the legacy enzyme_id column was
  // dropped in #791 Part B step 4).
  await db
    .delete(drugEliminationRoutes)
    .where(eq(drugEliminationRoutes.drugId, drugId));
  if (input.routes.length > 0) {
    await db.insert(drugEliminationRoutes).values(
      input.routes.map((r, sortOrder) => ({
        drugId,
        kind: r.kind,
        bioEntityId: r.kind === 'enzyme' ? (r.enzymeId ?? null) : null,
        label: r.label?.trim() || null,
        fraction: fractionToColumn(r.fraction?.median ?? null),
        fractionMin: fractionToColumn(r.fraction?.min ?? null),
        fractionMax: fractionToColumn(r.fraction?.max ?? null),
        note: r.note?.trim() || null,
        referenceIds: cleanReferenceIds(r.referenceIds),
        sortOrder,
      })),
    );
  }

  // Metabolites: rows where this drug is the parent.
  await db
    .delete(drugMetabolites)
    .where(eq(drugMetabolites.parentDrugId, drugId));
  if (input.metabolites.length > 0) {
    await db.insert(drugMetabolites).values(
      input.metabolites.map((m, sortOrder) => ({
        parentDrugId: drugId,
        metaboliteDrugId: m.metaboliteDrugId ?? null,
        metaboliteName: m.metaboliteName.trim(),
        conversionFraction: fractionToColumn(m.conversionFraction?.median ?? null),
        conversionFractionMin: fractionToColumn(m.conversionFraction?.min ?? null),
        conversionFractionMax: fractionToColumn(m.conversionFraction?.max ?? null),
        activity: m.activity,
        sortOrder,
        evidenceNote: m.evidenceNote?.trim() || null,
        referenceIds: cleanReferenceIds(m.referenceIds),
      })),
    );
  }

  // Precursors: rows where this drug is the metabolite (reverse direction).
  await db
    .delete(drugMetabolites)
    .where(eq(drugMetabolites.metaboliteDrugId, drugId));
  if (input.precursors.length > 0) {
    try {
      await db.insert(drugMetabolites).values(
        input.precursors.map((p, sortOrder) => ({
          parentDrugId: p.precursorDrugId,
          metaboliteDrugId: drugId,
          metaboliteName: drugName.slice(0, 300),
          conversionFraction: fractionToColumn(p.conversionFraction?.median ?? null),
          conversionFractionMin: fractionToColumn(p.conversionFraction?.min ?? null),
          conversionFractionMax: fractionToColumn(p.conversionFraction?.max ?? null),
          activity: p.activity,
          sortOrder,
          evidenceNote: p.evidenceNote?.trim() || null,
          referenceIds: cleanReferenceIds(p.referenceIds),
        })),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new MetabolismWriteError(
          'A precursor already lists this drug as a metabolite under a different name',
          409,
        );
      }
      throw err;
    }
  }

  // Profile: one row per drug, carrying only the box-level note now. Drop it
  // when empty so getDrugMetabolism reflects the cleared note.
  await db
    .delete(drugMetabolismProfiles)
    .where(eq(drugMetabolismProfiles.drugId, drugId));
  const prof = input.profile;
  const profileHasData =
    Boolean(prof.evidenceNote && prof.evidenceNote.trim()) ||
    (prof.referenceIds != null && prof.referenceIds.length > 0);
  if (profileHasData) {
    await db.insert(drugMetabolismProfiles).values({
      drugId,
      evidenceNote: prof.evidenceNote?.trim() || null,
      referenceIds: cleanReferenceIds(prof.referenceIds),
      updatedBy: userId,
    });
  }

  // Audit / popularity signal, matching the drug-parameter write path.
  await db.insert(drugInteractions).values({
    drugId,
    userId,
    eventType: 'edit',
  });
}

/** Map a validated {@link metabolismWriteSchema} payload to a write input. */
export function toMetabolismWriteInput(data: {
  profile: MetabolismProfileWriteInput;
  routes: EliminationRouteWriteInput[];
  metabolites: MetaboliteWriteInput[];
  precursors: Array<PrecursorWriteInput & { precursorName?: string }>;
}): MetabolismWriteInput {
  return {
    profile: data.profile,
    routes: data.routes.map((r) => ({
      kind: r.kind,
      enzymeId: r.enzymeId,
      label: r.label,
      fraction: r.fraction,
      note: r.note,
      referenceIds: r.referenceIds,
    })),
    metabolites: data.metabolites,
    precursors: data.precursors.map((p) => ({
      precursorDrugId: p.precursorDrugId,
      conversionFraction: p.conversionFraction,
      activity: p.activity,
      evidenceNote: p.evidenceNote,
      referenceIds: p.referenceIds,
    })),
  };
}
