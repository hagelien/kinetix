/**
 * Backfill `drug_parameter_revisions.source_diff` for revisions the aggregate
 * cache wrote before that column existed (#1378, following on #1358/PR #1363).
 *
 * `recomputeAndCacheParameterSummary` is the only writer of `source_diff`
 * (`api/_lib/parameter-entries-store.ts`), and it only ever fires for the two
 * `auto:param_entries_*` edit-summary codes. Every such revision already
 * carries the inputs the live diff itself uses — its own `reference_ids`
 * (the "next" set; empty for an `auto:param_entries_cleared` row, which never
 * sets the column) and the immediately preceding revision's `reference_ids`
 * for the same (drug, parameter) — so the diff can be reconstructed exactly,
 * without re-deriving what the aggregate itself contained at the time.
 *
 * The one thing that live diffing had that a backfill does not: a citation
 * deleted since the revision was written is gone from `citations`, so its
 * label can't be looked up there anymore. The citation-cleanup scripts write
 * pre-delete dumps before they run (kept by the operator, outside the
 * repository); pass their directory with `--backup-dir <dir>` and this script
 * also checks those for a label, and otherwise leaves it `null`
 * (`SourceDiffEntry.label` is documented as best-effort, exactly this case).
 *
 * Dry-run by default; `--apply` writes. `--limit N` bounds one run.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import { drugParameterRevisions, citations } from '../db/schema.js';
import {
  CACHE_REVISION_CLEARED_CODE,
  CACHE_REVISION_RECOMPUTED_CODE,
  citationLabel,
  diffContributingCitationIds,
  type SourceDiff,
} from '../api/_lib/parameter-entries-store.js';

const APPLY = process.argv.includes('--apply');

/**
 * `null` means "no `--limit` given" — an intentional, unbounded run. Any other
 * shape (missing value, zero, negative, not a number) is an operator mistake,
 * not a request to remove the cap: `--apply --limit 0` must refuse to touch
 * every row, not silently run unbounded (#1411 review).
 */
export function parseLimit(argv: readonly string[]): number | null {
  const index = argv.indexOf('--limit');
  if (index === -1) return null;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `--limit requires a positive integer, got ${JSON.stringify(raw ?? null)}`,
    );
  }
  return value;
}

/** `--backup-dir <dir>`, or `null` when not given (no label recovery). */
export function parseBackupDir(argv: readonly string[]): string | null {
  const index = argv.indexOf('--backup-dir');
  if (index === -1) return null;
  const raw = argv[index + 1];
  if (!raw || raw.startsWith('--')) {
    throw new Error('--backup-dir requires a directory path');
  }
  return path.resolve(raw);
}

/**
 * Labels recovered from every deletion backup in the directory, keyed by
 * citation id. A later backup wins on a collision (there shouldn't be one —
 * a citation is deleted once), which is why this is a plain last-write-wins
 * merge rather than a defended one.
 */
function loadBackupLabels(backupDir: string | null): Map<number, string> {
  const labels = new Map<number, string>();
  if (!backupDir || !fs.existsSync(backupDir)) return labels;
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.json')) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8')) as {
      citations?: { id: number; identifier: string; metadata: unknown }[];
    };
    for (const c of raw.citations ?? []) {
      labels.set(c.id, citationLabel(c));
    }
  }
  return labels;
}

interface TargetRow {
  id: number;
  drugId: number;
  parameter: string;
}

/**
 * How many candidate rows a single page fetches. Keyset-paginated on `id` (the
 * same order `--limit`'s early stop already relies on) so a bounded run never
 * materializes more of the backlog than it might need, and an unbounded run
 * still bounds each round trip (#1411 review — the previous fix only stopped
 * the per-row loop early; the initial query fetched every eligible row up
 * front regardless).
 */
const TARGET_PAGE_SIZE = 500;

async function targetPage(
  db: ReturnType<typeof getDb>,
  afterId: number,
  pageSize: number,
): Promise<TargetRow[]> {
  return db
    .select({
      id: drugParameterRevisions.id,
      drugId: drugParameterRevisions.drugId,
      parameter: drugParameterRevisions.parameter,
    })
    .from(drugParameterRevisions)
    .where(
      and(
        isNull(drugParameterRevisions.sourceDiff),
        gt(drugParameterRevisions.id, afterId),
        or(
          // Matches the exact shapes `recomputeAndCacheParameterSummary`
          // produces (`auto:param_entries_cleared[:reason]`,
          // `auto:param_entries_recomputed:N[:from:M][:reason]`) rather than
          // any string merely starting with the prefix. Nothing currently
          // stops a human write path from storing a free-text edit summary
          // that happens to start with the same prefix (`editSummary` is an
          // unrestricted `z.string().max(...)` on every write route) — this
          // narrows that collision to one requiring the exact well-formed
          // shape, which no human-authored summary produces by accident.
          // Closing it completely needs a structural marker or a reserved
          // prefix on those write paths, both out of this backfill script's
          // scope (#1411 review; tracked as #1415).
          sql`${drugParameterRevisions.editSummary} ~ ${`^${CACHE_REVISION_CLEARED_CODE}(:[a-z0-9_]+)?$`}`,
          sql`${drugParameterRevisions.editSummary} ~ ${`^${CACHE_REVISION_RECOMPUTED_CODE}:[0-9]+(:from:[0-9]+)?(:[a-z0-9_]+)?$`}`,
        ),
      ),
    )
    .orderBy(asc(drugParameterRevisions.id))
    .limit(pageSize);
}

interface RowSnapshot {
  /** This row's own `reference_ids` as of one instant — the "next" set. */
  referenceIds: number[] | null;
  /** Whether a concurrent write already resolved this row since the page was fetched. */
  sourceDiff: SourceDiff | null;
  /** The immediately preceding revision's own id, read from the same instant. */
  prevId: number | null;
  /** The immediately preceding revision's `reference_ids`, read from the same instant. */
  prevReferenceIds: number[] | null;
}

/**
 * Reads a row's own `reference_ids`/`source_diff` together with its
 * predecessor's `id`/`reference_ids` in one round trip, so all of it comes
 * from the same database snapshot. Two separate queries (fetch the page, then
 * look up the predecessor) left a gap a concurrent drug or citation merge
 * could land in — repointing `drug_id` or `reference_ids` between the two
 * reads would diff a row's new contributing set against a predecessor read
 * from before the repoint, or vice versa (#1411 review). The predecessor's
 * `id` is carried alongside its `reference_ids` so the write can revalidate
 * not just "did the content change" but "is this still the same predecessor
 * row" — a merge landing between this read and the write could make a
 * *different* row the current predecessor without changing this row's own
 * `reference_ids` at all.
 */
async function readRowSnapshot(
  db: ReturnType<typeof getDb>,
  row: TargetRow,
): Promise<RowSnapshot | null> {
  const result = await db.execute<{
    reference_ids: number[] | null;
    source_diff: SourceDiff | null;
    prev_id: number | null;
    prev_reference_ids: number[] | null;
  }>(sql`
    SELECT
      r."reference_ids" AS reference_ids,
      r."source_diff" AS source_diff,
      prev."id" AS prev_id,
      prev."reference_ids" AS prev_reference_ids
    FROM "drug_parameter_revisions" r
    LEFT JOIN LATERAL (
      SELECT p."id", p."reference_ids"
      FROM "drug_parameter_revisions" p
      WHERE p."drug_id" = r."drug_id"
        AND p."parameter" = r."parameter"
        AND p."id" < r."id"
      ORDER BY p."id" DESC
      LIMIT 1
    ) AS prev ON true
    WHERE r."id" = ${row.id}
  `);
  const found = result.rows[0];
  if (!found) return null;
  return {
    referenceIds: found.reference_ids,
    sourceDiff: found.source_diff,
    prevId: found.prev_id,
    prevReferenceIds: found.prev_reference_ids,
  };
}

export interface BackfillCounts {
  scanned: number;
  unchanged: number;
  wouldWrite: number;
  written: number;
  /** A row's state changed between being scanned and being written (or was
   *  already resolved by something else in that gap) — never actually wrong,
   *  just skipped in favor of letting a later run see the current state. */
  raced: number;
}

export async function backfillSourceDiffs(
  db: ReturnType<typeof getDb>,
  {
    apply,
    limit,
    pageSize = TARGET_PAGE_SIZE,
    backupDir = null,
    onAfterSnapshot,
  }: {
    apply: boolean;
    limit: number | null;
    pageSize?: number;
    /** Directory of citation-deletion backups to recover labels from. */
    backupDir?: string | null;
    /** Test-only: runs after a row's snapshot is read, before it is used, so a
     *  test can simulate a concurrent write landing in that gap. */
    onAfterSnapshot?: (row: TargetRow) => Promise<void>;
  },
): Promise<BackfillCounts> {
  const backupLabels = loadBackupLabels(backupDir);
  const counts: BackfillCounts = {
    scanned: 0,
    unchanged: 0,
    wouldWrite: 0,
    written: 0,
    raced: 0,
  };
  let processed = 0;
  let afterId = 0;

  pages: for (;;) {
    const page = await targetPage(db, afterId, pageSize);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;

    for (const row of page) {
      // Stop scanning entirely once the requested number of actionable rows
      // is in hand — checked before this row's own snapshot query runs, so a
      // bounded run costs one query per row it actually needed, not one per
      // row still left in the backlog (#1411 review).
      if (limit !== null && processed >= limit) break pages;
      counts.scanned += 1;

      const snapshot = await readRowSnapshot(db, row);
      await onAfterSnapshot?.(row);
      if (!snapshot || snapshot.sourceDiff !== null) {
        // Gone, or a concurrent write already resolved it since the page was
        // fetched — nothing safe to add from here.
        counts.raced += 1;
        continue;
      }
      const nextReferenceIds = snapshot.referenceIds ?? [];
      const prevReferenceIds = snapshot.prevReferenceIds ?? [];
      const { addedIds, removedIds } = diffContributingCitationIds(
        prevReferenceIds,
        nextReferenceIds,
      );
      if (addedIds.length === 0 && removedIds.length === 0) {
        // Correctly, and permanently, null — the live writer would have left
        // it exactly this way. Doesn't count against the limit: counting it
        // would let a run of unchanged rows exhaust --limit before reaching
        // an actionable one, and a later run would just re-scan the same
        // unchanged prefix forever (#1412).
        counts.unchanged += 1;
        continue;
      }

      const idsNeedingLabels = [...addedIds, ...removedIds];
      const liveRows = await db
        .select({
          id: citations.id,
          identifier: citations.identifier,
          metadata: citations.metadata,
        })
        .from(citations)
        .where(inArray(citations.id, idsNeedingLabels));
      const liveLabels = new Map(liveRows.map((r) => [r.id, citationLabel(r)]));
      const labelFor = (citationId: number): string | null =>
        liveLabels.get(citationId) ?? backupLabels.get(citationId) ?? null;

      const diff: SourceDiff = {
        added: addedIds.map((citationId) => ({ citationId, label: labelFor(citationId) })),
        removed: removedIds.map((citationId) => ({ citationId, label: labelFor(citationId) })),
      };

      if (!apply) {
        console.log(
          `would write revision ${row.id} (drug ${row.drugId}, ${row.parameter}): ` +
            `+${addedIds.length}/-${removedIds.length}`,
        );
        counts.wouldWrite += 1;
        processed += 1;
        continue;
      }

      // Conditioned on the row still holding exactly the reference_ids this
      // diff was computed from, AND its predecessor still being the same row
      // with the same reference_ids: a merge could leave this row's own
      // reference_ids untouched while repointing a different revision to sit
      // between it and its old predecessor, or changing the predecessor's own
      // reference_ids — either way the diff was computed from a predecessor
      // that's no longer current (#1411 review, second pass). The predecessor
      // is re-derived fresh inside this same statement (a CTE, not a separate
      // read), so there is no gap left for anything to land in between
      // deriving it and checking it. `to_jsonb` sidesteps needing a Postgres
      // array literal for the comparison values; a `null` column and a `null`
      // snapshot both compare as SQL NULL, which `IS NOT DISTINCT FROM`
      // treats as equal.
      const nextReferenceIdsJson =
        snapshot.referenceIds === null ? null : JSON.stringify(snapshot.referenceIds);
      const prevReferenceIdsJson =
        snapshot.prevReferenceIds === null ? null : JSON.stringify(snapshot.prevReferenceIds);
      const updated = await db.execute<{ id: number }>(sql`
        WITH current_prev AS (
          SELECT p."id" AS id, p."reference_ids" AS reference_ids
          FROM "drug_parameter_revisions" p
          JOIN "drug_parameter_revisions" r
            ON r."drug_id" = p."drug_id" AND r."parameter" = p."parameter"
          WHERE r."id" = ${row.id} AND p."id" < r."id"
          ORDER BY p."id" DESC
          LIMIT 1
        )
        UPDATE "drug_parameter_revisions" AS r
           SET "source_diff" = ${JSON.stringify(diff)}::jsonb
         WHERE r."id" = ${row.id}
           AND r."source_diff" IS NULL
           AND to_jsonb(r."reference_ids") IS NOT DISTINCT FROM ${nextReferenceIdsJson}::jsonb
           AND (SELECT id FROM current_prev) IS NOT DISTINCT FROM ${snapshot.prevId}
           AND to_jsonb((SELECT reference_ids FROM current_prev))
                 IS NOT DISTINCT FROM ${prevReferenceIdsJson}::jsonb
        RETURNING r."id"
      `);
      if (updated.rows.length === 0) {
        // Didn't consume the limit's budget: an actionable row that turned
        // out to be unwritable this time is not a completed write, and
        // counting it here would let a run of races exhaust --limit the same
        // way a run of unchanged rows could before #1412 (#1411 review,
        // third pass).
        counts.raced += 1;
        continue;
      }
      processed += 1;
      counts.written += 1;
    }

    if (page.length < pageSize) break;
  }

  return counts;
}

async function main() {
  const limit = parseLimit(process.argv);
  const backupDir = parseBackupDir(process.argv);
  const db = getDb();
  const counts = await backfillSourceDiffs(db, { apply: APPLY, limit, backupDir });
  console.log(
    `${APPLY ? 'applied' : 'dry run'}: ${counts.scanned} revision(s) missing source_diff scanned, ` +
      `${counts.unchanged} had no actual change (left null, as the live writer would have), ` +
      `${APPLY ? `${counts.written} written` : `${counts.wouldWrite} would be written`}` +
      (counts.raced > 0 ? `, ${counts.raced} raced (changed concurrently — re-run to pick up)` : ''),
  );
  if (!APPLY) console.log('re-run with --apply to write these diffs');
}

// Only when invoked as a CLI. Importing this module (the integration suite
// pulls in `backfillSourceDiffs`) must not run the script — it would query
// the real database named by DATABASE_URL, and its failure path calls
// `process.exit`, which would take the test worker with it.
if (process.argv[1]?.endsWith('backfill-parameter-revision-source-diff.ts')) {
  main().catch((err) => {
    console.error(err); // eslint-disable-line no-console
    process.exit(1);
  });
}
