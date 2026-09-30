import { asc, eq, inArray } from 'drizzle-orm';
import {
  bioEntities,
  drugInteractions,
  drugReceptorTargets,
  drugs,
} from '../../db/schema.js';
import { isUniqueViolation } from './drugs-helpers.js';
import { findOrCreateEntityBySymbol } from './bioEntityStore.js';
import type { getDb } from './db.js';
import {
  isMechanismTier,
  type DrugReceptorTargetSummary,
} from '../../src/lib/receptorTargets.js';
import type { ReceptorMechanismInput } from './schemas.js';
import { targetSlug } from './slug.js';

type Db = ReturnType<typeof getDb>;

function rangeOrNull(value: unknown): DrugReceptorTargetSummary['affinity'] {
  if (value && typeof value === 'object') {
    return value as DrugReceptorTargetSummary['affinity'];
  }
  return null;
}

export async function getDrugReceptorTargets(
  db: Db,
  drugId: number,
): Promise<DrugReceptorTargetSummary[]> {
  // The unified bio_entities row is the catalog identity. The legacy
  // receptor_targets fallback was removed after the #785 backfill was verified
  // total and enforced (#791 Part B): drug_receptor_targets.bio_entity_id is
  // NOT NULL, so every mechanism resolves against the unified registry.
  const rows = await db
    .select({
      id: drugReceptorTargets.id,
      drugId: drugReceptorTargets.drugId,
      bioEntityId: drugReceptorTargets.bioEntityId,
      interactionType: drugReceptorTargets.interactionType,
      tier: drugReceptorTargets.tier,
      affinity: drugReceptorTargets.affinity,
      potency: drugReceptorTargets.potency,
      efficacy: drugReceptorTargets.efficacy,
      ki: drugReceptorTargets.ki,
      ic50: drugReceptorTargets.ic50,
      ec50: drugReceptorTargets.ec50,
      emax: drugReceptorTargets.emax,
      selectivityRatio: drugReceptorTargets.selectivityRatio,
      assaySpecies: drugReceptorTargets.assaySpecies,
      referenceIds: drugReceptorTargets.referenceIds,
      evidenceNote: drugReceptorTargets.evidenceNote,
      bioSlug: bioEntities.slug,
      bioSymbol: bioEntities.symbol,
      bioName: bioEntities.name,
      bioNameEn: bioEntities.nameEn,
      bioClass: bioEntities.entityClass,
      bioOrganism: bioEntities.organism,
    })
    .from(drugReceptorTargets)
    .leftJoin(
      bioEntities,
      eq(drugReceptorTargets.bioEntityId, bioEntities.id),
    )
    .where(eq(drugReceptorTargets.drugId, drugId))
    .orderBy(asc(drugReceptorTargets.id));

  return rows
    .map((row) => {
      const target =
        row.bioEntityId != null && row.bioSymbol
          ? {
              id: row.bioEntityId,
              slug: row.bioSlug ?? '',
              symbol: row.bioSymbol,
              name: row.bioName ?? row.bioSymbol,
              nameEn: row.bioNameEn,
              targetClass: row.bioClass,
              organism: row.bioOrganism ?? 'Homo sapiens',
            }
          : null;
      if (!target) return null;
      return {
        id: row.id,
        drugId: row.drugId,
        receptorTargetId: target.id,
        interactionType: row.interactionType,
        tier: isMechanismTier(row.tier) ? row.tier : null,
        affinity: rangeOrNull(row.affinity),
        potency: rangeOrNull(row.potency),
        efficacy: rangeOrNull(row.efficacy),
        ki: rangeOrNull(row.ki),
        ic50: rangeOrNull(row.ic50),
        ec50: rangeOrNull(row.ec50),
        emax: rangeOrNull(row.emax),
        selectivityRatio: rangeOrNull(row.selectivityRatio),
        assaySpecies: row.assaySpecies,
        referenceIds: row.referenceIds ?? [],
        evidenceNote: row.evidenceNote,
        target,
      };
    })
    .filter((r): r is DrugReceptorTargetSummary => r !== null);
}

export class ReceptorTargetWriteError extends Error {
  constructor(
    message: string,
    public readonly statusHint = 400,
    /**
     * Stable, locale-independent code the React boundary maps to a translated
     * string (AGENTS.md i18n rule). `message` stays English prose for logs and
     * as a fallback when the client doesn't recognise the code.
     */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ReceptorTargetWriteError';
  }
}


/** A measurement object is meaningful only if it carries a numeric reading. */
function measurementOrNull(
  value: ReceptorMechanismInput['ki'],
): Record<string, unknown> | null {
  if (!value) return null;
  const hasReading =
    value.min !== undefined ||
    value.max !== undefined ||
    value.mean !== undefined ||
    value.median !== undefined;
  return hasReading ? { ...value } : null;
}

function cleanReferenceIds(value: number[] | null | undefined): number[] | null {
  if (!value || value.length === 0) return null;
  const unique = [...new Set(value.filter((id) => Number.isInteger(id) && id > 0))];
  return unique.length > 0 ? unique : null;
}

/**
 * Stable key for a mechanism's target so duplicates can be detected before the
 * `(drug_id, receptor_target_id, interaction_type)` unique index would reject
 * them. Existing targets key on their id; new targets key on their derived slug.
 */
function mechanismTargetKey(m: ReceptorMechanismInput): string {
  if (m.receptorTargetId != null) return `id:${m.receptorTargetId}`;
  return `slug:${targetSlug(m.targetSymbol, m.targetName)}`;
}

/**
 * Validate a receptor-targets write payload without mutating anything: the drug
 * must exist, every linked catalog id must resolve, new targets must carry a
 * usable symbol/name, and no two mechanisms may share the same
 * target + interaction type (the unique index).
 */
export async function validateReceptorTargetsInput(
  db: Db,
  drugId: number,
  mechanisms: ReceptorMechanismInput[],
): Promise<void> {
  const [drug] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drug)
    throw new ReceptorTargetWriteError(
      'Drug not found',
      404,
      'receptor_target_drug_not_found',
    );

  const linkedIds = new Set<number>();
  for (const m of mechanisms) {
    if (m.receptorTargetId != null) {
      linkedIds.add(m.receptorTargetId);
    } else if (!targetSlug(m.targetSymbol, m.targetName)) {
      throw new ReceptorTargetWriteError(
        'A new receptor target needs a symbol or name',
        400,
        'receptor_target_symbol_or_name_required',
      );
    }
  }
  if (linkedIds.size > 0) {
    // #785 Phase 7: receptorTargetId references the unified bio_entities catalog.
    const found = await db
      .select({ id: bioEntities.id })
      .from(bioEntities)
      .where(inArray(bioEntities.id, [...linkedIds]));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = [...linkedIds].filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new ReceptorTargetWriteError(
        `Receptor target(s) not found: ${missing.join(', ')}`,
        400,
        'receptor_target_links_missing',
      );
    }
  }

  const seen = new Set<string>();
  for (const m of mechanisms) {
    const key = `${mechanismTargetKey(m)}|${m.interactionType.toLowerCase()}`;
    if (seen.has(key)) {
      throw new ReceptorTargetWriteError(
        'Each target may appear only once per interaction type',
        409,
        'receptor_target_duplicate',
      );
    }
    seen.add(key);
  }
}

/**
 * Resolve a mechanism's target to a unified bio_entities id (#785 Phase 7). An
 * existing link carries the bio_entity id directly; a symbol/name pair resolves
 * via the dedup-aware findOrCreateEntityBySymbol, which reuses a matching entity
 * (and ensures it carries the drug_target function) or creates a new one.
 * Caches within a single write so repeated symbols resolve to one entity.
 */
async function resolveEntityId(
  db: Db,
  m: ReceptorMechanismInput,
  cache: Map<string, number>,
): Promise<number> {
  if (m.receptorTargetId != null) return m.receptorTargetId;
  const symbol = (m.targetSymbol ?? m.targetName ?? '').trim();
  const name = (m.targetName ?? m.targetSymbol ?? '').trim();
  const slug = targetSlug(m.targetSymbol, m.targetName);
  const cached = cache.get(slug);
  if (cached) return cached;

  const entityId = await findOrCreateEntityBySymbol(
    db,
    { symbol: (symbol || name).slice(0, 80), name: (name || symbol).slice(0, 200) },
    'drug_target',
  );
  cache.set(slug, entityId);
  return entityId;
}

/**
 * Replace a drug's entire set of receptor-target mechanisms with `mechanisms`.
 * Clears the existing rows and re-inserts, creating any catalog targets that
 * were supplied by symbol/name. Must run inside a transaction.
 */
export async function replaceDrugReceptorTargets(
  db: Db,
  drugId: number,
  mechanisms: ReceptorMechanismInput[],
  userId: number,
): Promise<void> {
  await validateReceptorTargetsInput(db, drugId, mechanisms);

  // #785 Phase 7: resolve each mechanism to a unified bio_entities id and write
  // it to bio_entity_id (the legacy receptor_target_id column was dropped in
  // #791 Part B step 4).
  const cache = new Map<string, number>();
  const rows = [];
  for (const m of mechanisms) {
    const bioEntityId = await resolveEntityId(db, m, cache);
    rows.push({
      drugId,
      bioEntityId,
      interactionType: m.interactionType.trim() || 'unspecified',
      tier: m.tier ?? null,
      affinity: measurementOrNull(m.affinity),
      potency: measurementOrNull(m.potency),
      efficacy: measurementOrNull(m.efficacy),
      ki: measurementOrNull(m.ki),
      ic50: measurementOrNull(m.ic50),
      ec50: measurementOrNull(m.ec50),
      emax: measurementOrNull(m.emax),
      selectivityRatio: measurementOrNull(m.selectivityRatio),
      assaySpecies: m.assaySpecies?.trim() || null,
      referenceIds: cleanReferenceIds(m.referenceIds),
      evidenceNote: m.evidenceNote?.trim() || null,
      createdBy: userId,
      updatedBy: userId,
    });
  }

  await db
    .delete(drugReceptorTargets)
    .where(eq(drugReceptorTargets.drugId, drugId));
  if (rows.length > 0) {
    try {
      await db.insert(drugReceptorTargets).values(rows as never);
    } catch (err) {
      // The (drug, target, interaction) unique index can still fire when two
      // rows resolve to the same target — e.g. a new symbol that maps to an
      // already-linked catalog id. Surface it as a clean conflict.
      if (isUniqueViolation(err)) {
        throw new ReceptorTargetWriteError(
          'Each target may appear only once per interaction type',
          409,
        );
      }
      throw err;
    }
  }

  // Audit / popularity signal, matching the metabolism + parameter write paths.
  await db.insert(drugInteractions).values({
    drugId,
    userId,
    eventType: 'edit',
  });
}
