/**
 * Fold citation rows that are the same paper under two handles (#1018).
 *
 * Why this exists
 * ───────────────
 * `citations` is unique on `(type, identifier)` and every write path used to
 * take the declared `citationType` at face value, so one paper declared as
 * `doi` in one seed and as `pmid` in another became two rows. That is worse
 * than a duplicate row: `paper_reviews` is unique on `citation_id`, so the two
 * rows carry two independent reviews — and since `read_in_full` is what lets a
 * reference back a fact or a parameter, the same source came out admissible
 * under one handle and inadmissible under the other.
 *
 * The write path no longer creates such pairs (`api/_lib/citation-store.ts`
 * resolves a paper under every handle it is known by before inserting). This
 * script is for the rows that already exist.
 *
 * How a pair is identified
 * ────────────────────────
 * Two rows are the same paper when their handles crosswalk to the same
 * article. The crosswalk comes from two places, cheapest first:
 *   1. `metadata.altIds` already on the row — written by the current write
 *      path, and by this script's own merges.
 *   2. NCBI's ID converter (`--resolve`), which places a DOI on its PMID.
 * Without `--resolve` the scan only finds pairs the stored metadata already
 * proves, so a first run on legacy data will want it.
 *
 * Free-text rows have no handle, so a second pass matches them on their
 * bibliographic record instead — first author, year and title, by
 * `src/lib/citationWorkMatch.ts` — and folds every rewording of one reference
 * into the strongest row for that work (its PMID row when there is one). A
 * cluster that reaches two different resolvable handles is reported and left
 * alone, as is a free-text row whose wording does not match its own record.
 *
 * Which row wins
 * ──────────────
 * The one filed under the stronger handle (PMID > DOI > URL), because that is
 * where the paper belongs; ties go to the lower id, which is the older row and
 * usually the more-referenced one. The loser's handle is preserved on the
 * winner as an alt id, so nothing becomes unfindable and a later write
 * declaring it resolves back to the same row.
 *
 * Where both rows carry a paper review, `read_in_full` wins outright — losing
 * that attestation would silently make every claim citing the paper
 * inadmissible — and the newest wins between two reviews of equal standing.
 * The losing review's revision history is re-parented onto the surviving
 * review rather than deleted: it is review history of this paper either way.
 *
 * Safety
 * ──────
 * - Dry-run by default. `--apply` runs each group's merges inside one pool
 *   transaction, so the advisory lock they take has something to hold: this
 *   script runs against a live deployment, and the merge racing it is an API
 *   request resolving the same paper. An interrupted run rolls that group back
 *   rather than leaving a pair half-repointed; every step is still written to
 *   be repeatable, so re-running is the fix either way.
 * - Re-running after a completed `--apply` is a no-op.
 * - Destructive: the loser row is deleted after everything pointing at it has
 *   been repointed. Take a Neon snapshot before `--apply`.
 *
 * Usage
 * ─────
 *   DATABASE_URL=… npx tsx scripts/merge-split-citations.ts                 # dry-run, stored crosswalks only
 *   DATABASE_URL=… npx tsx scripts/merge-split-citations.ts --resolve       # dry-run, ask NCBI too
 *   DATABASE_URL=… npx tsx scripts/merge-split-citations.ts --resolve --apply --user-email me@example.com
 *
 * `--apply` requires `--user-email`: a merge can change which paper review
 * backs a parameter entry, and the summary recompute that follows needs an
 * author for its revisions.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, inArray } from 'drizzle-orm';
import { citations, paperReviews, users } from '../db/schema';
import {
  canonicalCitationHandle,
  citationHandleRank,
  mergeAltIds,
  type CitationAltIds,
  type CitationHandleType,
} from '../src/lib/citationHandles';
import { normalizeReferenceMetadata } from '../api/_lib/reference-metadata';
import {
  assertNoConflictingCohortBaselines,
  chooseSurvivingReview,
  countCitationUsage,
  mergeCitations,
} from '../api/_lib/citation-merge';
import { resolveCitationCrosswalk } from '../api/_lib/citation-crosswalk';
import { getDb, runInPoolTransaction } from '../api/_lib/db';
import {
  clusterSameWorks,
  type WorkRecord,
} from '../src/lib/citationWorkMatch';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const resolveOnline = process.argv.includes('--resolve');

/**
 * Who the parameter-summary recompute is attributed to.
 *
 * A merge can change which paper review backs an entry, and the review's score
 * is a weight in source-weighted aggregation — so cached parameter values have
 * to be recomputed, and the resulting revisions need an author. Same
 * `--user-email` convention as `seed-pm-am-ratios.ts`.
 */
function parseUserEmail(): string | null {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--user-email') return argv[i + 1] ?? null;
    if (a.startsWith('--user-email=')) return a.slice('--user-email='.length);
  }
  return null;
}

const userEmail = parseUserEmail();

/** NCBI is queried in batches; the converter caps a request at 200 ids. */
const RESOLVE_BATCH = 100;

interface CitationRow {
  id: number;
  type: CitationHandleType;
  identifier: string;
  altIds: CitationAltIds;
  metadata: WorkRecord | null;
}

function groupKey(row: CitationRow): string {
  const canonical = canonicalCitationHandle(
    { type: row.type, identifier: row.identifier },
    row.altIds,
  );
  return `${canonical.type}:${canonical.identifier}`;
}

async function main(): Promise<void> {
  const client = neon(DATABASE_URL!);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(client) as any;

  // Required for --apply, and resolved before anything is written.
  //
  // A merge can change which paper review backs a parameter entry, which
  // changes the entry's weight in source-weighted aggregation, so the cached
  // summaries have to be recomputed — and those revisions need an author. This
  // is not optional-with-a-warning, because the recompute has no second chance:
  // re-running the script after a completed merge finds no split pairs left, so
  // nothing would trigger it and the stale values would sit there indefinitely.
  let actorUserId: number | null = null;
  if (apply) {
    if (!userEmail) {
      console.error(
        '--apply requires --user-email <address>: merging can change which paper\n' +
          'review backs a parameter entry, and the resulting summary recompute needs\n' +
          'an author to attribute its revisions to.',
      );
      process.exit(1);
    }
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, userEmail))
      .limit(1);
    if (!row) {
      console.error(
        `No user with email "${userEmail}". Pass --user-email <address> for an existing account.`,
      );
      process.exit(1);
    }
    actorUserId = row.id;
  }

  const raw = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations);

  const allRows: CitationRow[] = raw.map(
    (row: {
      id: number;
      type: string;
      identifier: string;
      metadata: unknown;
    }) => {
      const metadata = normalizeReferenceMetadata(row.metadata);
      return {
        id: row.id,
        type: row.type as CitationHandleType,
        identifier: row.identifier,
        altIds: metadata?.altIds ?? {},
        metadata,
      };
    },
  );
  const rows = allRows.filter((row) => row.type !== 'freetext');
  console.log(`Scanning ${rows.length} resolvable citation rows…`);

  if (resolveOnline) {
    // Only rows with nothing stored need asking: a row that already carries a
    // crosswalk was written (or merged) by the current code path.
    const needing = rows.filter(
      (row) => Object.keys(row.altIds).length === 0 && row.type !== 'url',
    );
    console.log(`Resolving ${needing.length} handles against NCBI…`);
    for (let i = 0; i < needing.length; i += RESOLVE_BATCH) {
      const batch = needing.slice(i, i + RESOLVE_BATCH);
      const resolved = await resolveCitationCrosswalk(
        batch.map((row) => ({ type: row.type, identifier: row.identifier })),
      );
      for (const row of batch) {
        const alt = resolved.get(`${row.type}:${row.identifier}`);
        if (alt) row.altIds = mergeAltIds(row.altIds, alt);
      }
    }
  }

  const groups = new Map<string, CitationRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const splits = [...groups.entries()].filter(([, group]) => group.length > 1);

  let merged = 0;
  let refused = 0;
  let deferred = 0;

  /**
   * Report one group, then (with --apply) fold `losers` into `winner`.
   * `ordered` is every row shown for the group, winner first.
   */
  const foldGroup = async (
    label: string,
    ordered: CitationRow[],
    winner: CitationRow,
    losers: CitationRow[],
  ): Promise<void> => {
    const reviews = await db
      .select({
        id: paperReviews.id,
        citationId: paperReviews.citationId,
        readInFull: paperReviews.readInFull,
        updatedAt: paperReviews.updatedAt,
      })
      .from(paperReviews)
      .where(
        inArray(
          paperReviews.citationId,
          ordered.map((row) => row.id),
        ),
      );

    console.log(`\n  ${label}`);
    for (const row of ordered) {
      const usage = await countCitationUsage(db, row.id);
      const review = reviews.find(
        (r: { citationId: number }) => r.citationId === row.id,
      );
      const reviewNote = review
        ? review.readInFull
          ? ' [review: read in full]'
          : ' [review: abstract only]'
        : '';
      console.log(
        `    ${row.id === winner.id ? 'KEEP  ' : 'MERGE '} #${row.id} ${row.type}:${row.identifier} — ${usage} usage(s)${reviewNote}`,
      );
    }

    // Report the review decision before making it: losing a read-in-full
    // attestation is the one outcome an operator must be able to veto.
    if (reviews.length > 1) {
      const surviving = reviews.reduce(
        (
          best: (typeof reviews)[number],
          candidate: (typeof reviews)[number],
        ) => chooseSurvivingReview(best, candidate).winner,
      );
      console.log(
        `    review kept: #${surviving.id} (read_in_full=${surviving.readInFull})`,
      );
    }

    // Over the whole group, and before the first of its merges. `mergeCitations`
    // checks the pair it is given, which is not enough here: the losers go in
    // one at a time, so the first can be committed into a winner that carried
    // no cohort and the second can then collide with it — a group reported as
    // refused with one citation already merged. Reported in the dry run too,
    // since the point of the dry run is to say what --apply will do.
    //
    // Refused per group rather than for the whole run: the other groups are
    // unrelated papers, and one unresolvable admission is no reason to leave
    // them split.
    try {
      await assertNoConflictingCohortBaselines(
        db,
        ordered.map((row) => row.id),
      );
    } catch (err) {
      console.log(`    REFUSED — ${err instanceof Error ? err.message : String(err)}`);
      refused += 1;
      return;
    }

    if (!apply) return;

    // In a pool transaction, so the merge's advisory lock has something to
    // hold. This runs against a live deployment: the second merge racing this
    // group is an API request resolving the same paper, not another run of
    // this script — so "one sequential process" says nothing about whether it
    // needs serializing. Without the transaction the lock is skipped here and
    // two folds into one empty survivor can combine two transcriptions.
    //
    // `getDb()` inside resolves to the transaction; the script's own
    // auto-commit client stays for the reads above, which decide nothing that
    // the merge does not re-check under the lock.
    await runInPoolTransaction(async () => {
      const tx = getDb();
      for (const loser of losers) {
        const stats = await mergeCitations(tx, winner.id, loser.id, {
          actorUserId,
        });
        if (stats.deferred) {
          console.log(
            `    deferred #${loser.id} → #${winner.id}: another merge into this paper` +
              ` was running. Re-run to pick it up.`,
          );
          deferred += 1;
          continue;
        }
        console.log(
          `    merged #${loser.id} → #${winner.id}: ${stats.rowsRepointed} row(s), ` +
            `${stats.jsonDocumentsRewritten} document(s), ` +
            `${stats.reviewRevisionsMoved} review revision(s), ` +
            `${stats.reviewsDropped} review(s) dropped`,
        );
        if (stats.summaryRecompute === 'ran') {
          console.log('    parameter summaries recomputed');
        }
        merged += 1;
      }
    });
  };

  if (splits.length === 0) {
    console.log('No split pairs found.');
  } else {
    console.log(`\nFound ${splits.length} paper(s) occupying more than one row:`);
  }
  for (const [key, group] of splits) {
    const ordered = [...group].sort(
      (a, b) =>
        citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
    );
    await foldGroup(key, ordered, ordered[0]!, ordered.slice(1));
  }

  // Second pass: free text, matched on its bibliographic record. Every
  // resolvable row carries its handle group's key, so a PMID row and the DOI
  // row the first pass folds into it count as one paper here, in a dry run as
  // much as after --apply.
  const keyOfRow = new Map<number, string>();
  const survivorOfKey = new Map<string, CitationRow>();
  for (const [key, group] of groups) {
    for (const row of group) keyOfRow.set(row.id, key);
    survivorOfKey.set(
      key,
      [...group].sort(
        (a, b) =>
          citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
      )[0]!,
    );
  }
  const clusters = clusterSameWorks(
    allRows.map((row) => ({ ...row, handleKey: keyOfRow.get(row.id) ?? null })),
  );
  const ambiguous = clusters.filter((cluster) => cluster.ambiguous);
  const foldable = clusters.filter((cluster) => !cluster.ambiguous);
  if (foldable.length === 0) {
    console.log('\nNo reworded free-text duplicates found.');
  } else {
    console.log(
      `\nFound ${foldable.length} work(s) with free-text duplicates (matched on author, year and title):`,
    );
  }
  for (const cluster of foldable) {
    const ordered = [...cluster.rows].sort(
      (a, b) =>
        citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
    );
    // The row the first pass keeps for that paper, which is not always the one
    // the title matched: the matched row may be the DOI twin it folds away.
    let winner =
      survivorOfKey.get(keyOfRow.get(ordered[0]!.id) ?? '') ?? ordered[0]!;
    // All free text: no row is filed better than another, and the survivor's
    // wording and record become the paper's for every claim citing it. Keep
    // the one most of them already cite — the oldest is as likely as not a
    // one-off wording ("…, 12th edition — Diazepam").
    if (winner.type === 'freetext') {
      let best = -1;
      for (const row of ordered) {
        const usage = await countCitationUsage(db, row.id);
        if (usage > best) {
          best = usage;
          winner = row;
        }
      }
    }
    // Only the free text: resolvable rows here were folded (or reported) by
    // the first pass.
    const kept = winner;
    const losers = ordered.filter(
      (row) => row.id !== kept.id && row.type === 'freetext',
    );
    await foldGroup(
      `${winner.metadata?.authors?.[0] ?? '?'} ${winner.metadata?.year ?? ''} — ${winner.metadata?.title ?? winner.identifier}`,
      [winner, ...losers],
      winner,
      losers,
    );
  }
  if (ambiguous.length > 0) {
    console.log(
      `\n${ambiguous.length} free-text cluster(s) left alone: they match more than one` +
        ` PMID/DOI/URL. Run with --resolve first, or merge by hand:`,
    );
    for (const cluster of ambiguous) {
      console.log(
        `  ${cluster.rows.map((row) => `#${row.id} ${row.type}:${row.identifier.slice(0, 60)}`).join('\n    ')}`,
      );
    }
  }

  if (deferred > 0) {
    console.log(
      `\n${deferred} merge(s) deferred: another merge into the same paper held the` +
        ` lock. Re-run to pick them up.`,
    );
  }
  if (refused > 0) {
    console.log(
      `\n${refused} group(s) refused: two admissions of one dataset from different URLs.` +
        ` Re-admit the dataset (§34.3), then re-run.`,
    );
  }
  if (!apply) {
    console.log('\nDry run — re-run with --apply to merge.');
    return;
  }
  console.log(`\nMerged ${merged} duplicate row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
