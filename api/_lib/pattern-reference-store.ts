/**
 * Reading the atlas for matching (§7.7, §13.3).
 *
 * Admission decided once, at insert, that a cohort's citation was a publication
 * somebody had read (migration 0108). This is the other half: the part of that
 * decision which can stop being true, re-read on every case.
 *
 * ## Why matching re-reads instead of trusting admission
 *
 * A classification is a claim about the handles a citation carried when it was
 * asked, and handles move — a merge promotes one, a `PATCH` adds an alias, two
 * registries turn out to disagree. Deferring to "the next admission" would let
 * a cohort go on scoring cases against a verdict that expired months earlier,
 * because admission happens once and matching happens every time. So a cohort
 * whose citation is not *currently* a resolved, admissible publication
 * contributes nothing — skipped exactly as an unprovenanced band is (§7.7),
 * with no quarantine pass and no revalidation sweep over already-admitted rows.
 *
 * The read-in-full condition is deliberately not re-checked here. That one is a
 * statement about the moment of admission — a human vouched for this paper —
 * and a review later replaced does not retroactively unadmit a cohort. What can
 * expire is the classification, and that is what this reads.
 *
 * ## Skipped cohorts are counted, not silently dropped
 *
 * A band that quietly loses half its cohorts still renders, with a smaller n
 * and no mark anywhere. Every exclusion is therefore returned beside the
 * cohorts, with the reason, so a caller can say "three cohorts withheld: two
 * awaiting re-resolution, one conflicted" rather than presenting a thinner
 * distribution as the whole literature.
 */
import { sql } from 'drizzle-orm';
import {
  judgeClassificationForAtlas,
  readClassification,
  type CohortAdmissionRefusal,
} from './citation-work-kind.js';
import { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

/** A cohort as matching needs it: identity, stratification, and its citation. */
export interface MatchableCohort {
  id: number;
  citationId: number;
  name: string;
  cohortType: string;
  timeOrigin: string;
  subgroupKey: string | null;
  evidenceTier: string | null;
  populationNote: string | null;
  analyticalNote: string | null;
  sourceDatasetHash: string;
  importerVersion: string;
  transformationVersion: string;
}

/** A cohort the atlas holds but matching will not use, and why. */
export interface WithheldCohort {
  id: number;
  citationId: number;
  reason: CohortAdmissionRefusal;
}

export interface MatchableCohorts {
  cohorts: MatchableCohort[];
  withheld: WithheldCohort[];
}

interface CohortRow extends Record<string, unknown> {
  cohort_id: number;
  citation_id: number;
  name: string;
  cohort_type: string;
  time_origin: string;
  subgroup_key: string | null;
  evidence_tier: string | null;
  population_note: string | null;
  analytical_note: string | null;
  source_dataset_hash: string;
  importer_version: string;
  transformation_version: string;
  citation_type: string;
  citation_identifier: string;
  citation_metadata: unknown;
  work_kind: string | null;
  work_kind_status: string;
  work_kind_handles: string[] | null;
  work_kind_verdicts: unknown;
}

/**
 * Every admitted cohort whose citation still passes the classification half of
 * admission, plus the ones it does not and the reason for each.
 *
 * The filter runs in TypeScript rather than in the query, and that is the same
 * decision migration 0108 records: currency compares the row's handle set
 * against the examined one, the handle set comes from
 * `src/lib/citationHandles.ts`, and a second derivation in SQL would be a
 * second parser whose disagreements are silent. One implementation, read here.
 */
export async function loadMatchableCohorts(
  db: Db,
  cohortIds?: readonly number[],
): Promise<MatchableCohorts> {
  if (cohortIds && cohortIds.length === 0) {
    return { cohorts: [], withheld: [] };
  }

  const result = await db.execute<CohortRow>(sql`
    SELECT co."id" AS cohort_id,
           co."citation_id",
           co."name",
           co."cohort_type",
           co."time_origin",
           co."subgroup_key",
           co."evidence_tier",
           co."population_note",
           co."analytical_note",
           co."source_dataset_hash",
           co."importer_version",
           co."transformation_version",
           c."type" AS citation_type,
           c."identifier" AS citation_identifier,
           c."metadata" AS citation_metadata,
           c."work_kind",
           c."work_kind_status",
           c."work_kind_handles",
           c."work_kind_verdicts"
      FROM "pattern_reference_cohorts" co
      JOIN "citations" c ON c."id" = co."citation_id"
     ${
       cohortIds
         ? sql`WHERE co."id" = ANY(ARRAY(
             SELECT jsonb_array_elements_text(${JSON.stringify([...cohortIds])}::jsonb)::int
           ))`
         : sql``
     }
     ORDER BY co."id"
  `);

  const cohorts: MatchableCohort[] = [];
  const withheld: WithheldCohort[] = [];

  for (const row of result.rows) {
    const classification = readClassification({
      id: Number(row.citation_id),
      type: row.citation_type,
      identifier: row.citation_identifier,
      metadata: row.citation_metadata,
      workKind: row.work_kind,
      workKindStatus: row.work_kind_status,
      workKindHandles: row.work_kind_handles,
      workKindVerdicts: row.work_kind_verdicts,
    });
    const refusal = judgeClassificationForAtlas(classification);
    if (refusal) {
      withheld.push({
        id: Number(row.cohort_id),
        citationId: Number(row.citation_id),
        reason: refusal,
      });
      continue;
    }
    cohorts.push({
      id: Number(row.cohort_id),
      citationId: Number(row.citation_id),
      name: row.name,
      cohortType: row.cohort_type,
      timeOrigin: row.time_origin,
      subgroupKey: row.subgroup_key,
      evidenceTier: row.evidence_tier,
      populationNote: row.population_note,
      analyticalNote: row.analytical_note,
      sourceDatasetHash: row.source_dataset_hash,
      importerVersion: row.importer_version,
      transformationVersion: row.transformation_version,
    });
  }

  return { cohorts, withheld };
}

/**
 * The withheld cohorts summarised by reason, for the one line a caller shows.
 *
 * Kept separate from the display layer because the count is the fact and the
 * wording is not: what a reader needs is that something was withheld and
 * roughly why, and `unresolved` (waiting on a registry) is a different message
 * from `conflicted` (waiting on a human).
 */
export function withheldByReason(
  withheld: readonly WithheldCohort[],
): Record<CohortAdmissionRefusal, number> {
  const counts = {
    unresolved: 0,
    stale: 0,
    conflicted: 0,
    not_a_publication: 0,
    not_read_in_full: 0,
  } satisfies Record<CohortAdmissionRefusal, number>;
  for (const entry of withheld) counts[entry.reason] += 1;
  return counts;
}
