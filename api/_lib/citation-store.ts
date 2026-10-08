import { and, eq, or, sql } from 'drizzle-orm';
import { citationFreetextAliases, citations } from '../../db/schema.js';
import {
  addressableHandles,
  canonicalCitationHandle,
  citationHandleRank,
  mergeAltIds,
  normalizeHandleIdentifier,
  type CitationAltIds,
  type CitationHandle,
  type CitationHandleType,
} from '../../src/lib/citationHandles.js';
import {
  assertNoConflictingCohortBaselines,
  mergeCitations,
} from './citation-merge.js';
import {
  normalizeReferenceMetadata,
  type ReferenceMetadata,
} from './reference-metadata.js';
import { getDb, inTransaction } from './db.js';
import {
  isMutuallySameWork,
  isSameWork,
  matchableFingerprint,
} from '../../src/lib/citationWorkMatch.js';

type Db = ReturnType<typeof getDb>;

/**
 * The single place a citation row is created (#1018).
 *
 * `citations` is unique on `(type, identifier)`, so a paper declared as `doi`
 * in one seed and as `pmid` in another used to land in two rows — and since
 * `paper_reviews` is unique on `citation_id`, that meant two independent
 * reviews of one paper, with the `read_in_full` attestation attached to only
 * one of them. Every write path now resolves through here instead of inserting
 * on its own declared type: the strongest handle wins, the weaker ones are kept
 * as `metadata.altIds`, and a row that already exists under a weaker handle is
 * promoted in place rather than duplicated.
 *
 * No network calls happen here. The crosswalk (which PMID a DOI belongs to) is
 * resolved by the caller — the route or the CLI — and handed in, exactly like
 * `resolveAuthoritativeMetadata` in `api/references.ts`. That keeps the store
 * deterministic and keeps NCBI's rate ceiling out of the DB layer.
 */

export interface ResolveCitationInput {
  type: CitationHandleType;
  identifier: string;
  metadata?: ReferenceMetadata | null;
  drugId?: number | null;
  /**
   * Handles the caller already knows for this paper — from a research-output
   * source object carrying both a PMID and a DOI, or from an ID-converter
   * lookup. Merged with any alt ids the incoming metadata carries.
   */
  crosswalk?: CitationAltIds | null;
}

export interface ResolveCitationResult {
  id: number;
  type: CitationHandleType;
  identifier: string;
  /** True when no row for this paper existed under any of its handles. */
  created: boolean;
  /** Set when an existing row was re-filed under a stronger handle. */
  promotedFrom?: CitationHandle;
  /** Ids of rows that were the same paper and got folded into this one. */
  mergedIds: number[];
  /**
   * Ids that are the same paper but were left unfolded: another merge into
   * this survivor held the lock. Nothing is lost — the next write declaring
   * the handle, or `merge:split-citations`, folds them — but until then the
   * paper is still split, so callers that care can say so.
   */
  deferredIds?: number[];
}

/**
 * Everywhere a row for one of these handles could be sitting, as one OR
 * predicate: its own `(type, identifier)` columns, or its stored
 * `metadata.altIds`.
 *
 * The altIds arm is not redundant with the column arm. The crosswalk that would
 * have turned an incoming DOI into its PMID is a best-effort network call, so
 * when NCBI is slow or down the incoming paper is known by its DOI alone. If
 * the existing row is filed under its PMID and carries that DOI in altIds,
 * comparing columns to columns finds nothing and the write inserts a second row
 * — precisely the split this module exists to prevent, re-created by an
 * unavailable third party. The row already knows the handle locally; it costs
 * nothing to ask it.
 *
 * DOIs compare case-insensitively on both arms. A DOI is case-insensitive by
 * specification, but `citations.identifier` is plain text and its unique index
 * is case-sensitive, so `10.1093/JAT/BKAA107` and `10.1093/jat/bkaa107` are two
 * rows as far as Postgres is concerned — the same split in a different disguise.
 * An existing row keeps its own spelling; only newly created rows are written in
 * the normalized (lower-case) form.
 *
 * Migration 0094 indexes the three altIds expressions this builds, so the added
 * arms stay index-served rather than turning every reference write into a
 * sequential scan of `citations`.
 *
 * Exported so the integration test can EXPLAIN this exact predicate rather than
 * a hand-written copy of it: a copy only proves the copy is indexable, while
 * the shipped expression drifts from the migration and production silently
 * falls back to a full scan on every reference write.
 */
export function handleMatch(handles: ReadonlyArray<CitationHandle>) {
  return or(
    ...handles.flatMap((h) => {
      const own = and(
        eq(citations.type, h.type),
        h.type === 'doi'
          ? sql`lower(${citations.identifier}) = ${h.identifier.toLowerCase()}`
          : eq(citations.identifier, h.identifier),
      );
      // `freetext` is never an alt id: it identifies nothing to cross-reference.
      // What it can be is a spelling a merge folded into another row (0143),
      // which must find that row rather than mint the duplicate again. The
      // subquery is served by the alias table's unique index on `identifier`.
      if (h.type === 'freetext') {
        return [
          own,
          sql`${citations.id} IN (SELECT ${citationFreetextAliases.citationId} FROM ${citationFreetextAliases} WHERE ${citationFreetextAliases.identifier} = ${h.identifier})`,
        ];
      }
      const alt =
        h.type === 'doi'
          ? sql`lower(${citations.metadata} -> 'altIds' ->> 'doi') = ${h.identifier.toLowerCase()}`
          : h.type === 'pmid'
            ? sql`${citations.metadata} -> 'altIds' ->> 'pmid' = ${h.identifier}`
            : sql`${citations.metadata} -> 'altIds' ->> 'url' = ${h.identifier}`;
      return [own, alt];
    }),
  );
}

/**
 * Resolve — or create — the one citation row for a paper.
 *
 * Order matters. Existing rows are looked up under every handle the paper is
 * known by BEFORE anything is written, because the whole failure mode is a
 * write that only checked its own declared handle.
 */
export async function resolveCitation(
  db: Db,
  input: ResolveCitationInput,
  userId: number | null,
): Promise<ResolveCitationResult> {
  const incomingMetadata = normalizeReferenceMetadata(input.metadata);
  const canonical = canonicalCitationHandle(
    { type: input.type, identifier: input.identifier },
    mergeAltIds(incomingMetadata?.altIds, input.crosswalk),
  );
  const handles = addressableHandles(canonical);

  const existing = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
      drugId: citations.drugId,
    })
    .from(citations)
    .where(handleMatch(handles));

  if (existing.length === 0 && canonical.type === 'freetext') {
    const sameWork = await findSameWorkForFreetext(
      db,
      canonical.identifier,
      incomingMetadata,
    );
    if (sameWork) {
      return {
        id: sameWork.id,
        type: sameWork.type as CitationHandleType,
        identifier: sameWork.identifier,
        created: false,
        mergedIds: [],
      };
    }
  }

  if (existing.length === 0) {
    const [row] = await db
      .insert(citations)
      .values({
        drugId: input.drugId ?? null,
        type: canonical.type,
        identifier: canonical.identifier,
        metadata: mergeMetadata(incomingMetadata, canonical.altIds),
        createdBy: userId,
      })
      // Two concurrent writers of the same new paper: the loser re-reads below.
      .onConflictDoNothing({
        target: [citations.type, citations.identifier],
      })
      .returning({ id: citations.id });

    if (row) {
      return {
        id: row.id,
        type: canonical.type,
        identifier: canonical.identifier,
        created: true,
        mergedIds: [],
      };
    }
    const [raced] = await db
      .select({ id: citations.id })
      .from(citations)
      .where(
        handleMatch([
          { type: canonical.type, identifier: canonical.identifier },
        ]),
      )
      .limit(1);
    if (!raced) {
      throw new Error(
        `resolveCitation: ${canonical.type}:${canonical.identifier} neither inserted nor found`,
      );
    }
    return {
      id: raced.id,
      type: canonical.type,
      identifier: canonical.identifier,
      created: false,
      mergedIds: [],
    };
  }

  // Strongest existing handle wins, so a promotion never demotes a row that is
  // already filed correctly. Ties break on the lower id — the older row is the
  // one more things point at.
  const sorted = [...existing].sort(
    (a, b) => citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
  );
  const survivor = sorted[0]!;
  // Over the whole group, before the first merge. `mergeCitations` checks the
  // pair it is handed, and these go in one at a time: with three or more rows
  // the first duplicate can be committed into a survivor that carried no
  // cohort, and the second can then collide with it — leaving this call
  // throwing with one citation already merged. There is no transaction here to
  // undo it with.
  await assertNoConflictingCohortBaselines(
    db,
    sorted.map((row) => row.id),
  );
  const mergedIds: number[] = [];
  const deferredIds: number[] = [];
  const duplicates = sorted.slice(1);
  // Only when there is something to merge. Outside an existing transaction
  // `runInPoolTransaction` opens a WebSocket pool of its own, and the ordinary
  // case here — one existing row for the paper — has nothing for it to wrap.
  //
  // One transaction around the whole group, joining the caller's if there is
  // one. `mergeCitations` says in its own docs to wrap the call where
  // atomicity matters, and this is where it matters: two requests resolving
  // the same paper concurrently converge on this survivor, and the advisory
  // lock the merge takes is transaction-scoped — on the auto-commit client it
  // releases the moment its own SELECT returns and serializes nothing. This is
  // what gives it something to hold.
  //
  // `getDb()` inside resolves to the transaction, so the merges run on it
  // rather than beside it.
  if (duplicates.length > 0) {
    await inTransaction(async () => {
      const tx = getDb();
      for (const duplicate of duplicates) {
        const stats = await mergeCitations(tx, survivor.id, duplicate.id, {
          actorUserId: userId,
        });
        // A deferred merge did not happen, so it is not reported as one. The
        // resolution is unaffected either way: the survivor is the survivor —
        // but the paper stays split until something folds it, which is worth
        // saying out loud rather than returning as success.
        if (stats.deferred) deferredIds.push(duplicate.id);
        else mergedIds.push(duplicate.id);
      }
    });
    if (deferredIds.length > 0) {
      // Not an error and not nothing: the paper is still split until something
      // folds it, and a caller that never hears about it cannot know its
      // reviews are still divided.
      console.warn(
        `resolveCitation: left ${deferredIds.length} duplicate(s) of citation ` +
          `${survivor.id} unfolded — another merge into it held the lock. ` +
          `They fold on the next write declaring the handle, or via merge:split-citations.`,
      );
    }
  }

  // Re-read after the merges: `mergeCitations` folds the losers' handles into
  // the survivor's metadata, and overwriting with a pre-merge snapshot would
  // drop them again.
  const [current] = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations)
    .where(eq(citations.id, survivor.id))
    .limit(1);
  const currentMetadata = normalizeReferenceMetadata(current?.metadata) ?? {};

  const promote =
    citationHandleRank(canonical.type) < citationHandleRank(survivor.type);
  const promotedFrom: CitationHandle | undefined = promote
    ? { type: survivor.type as CitationHandleType, identifier: survivor.identifier }
    : undefined;

  // Promotion re-files the row in place. Keeping the id is the point: the paper
  // review, the parameter entries and every referenceIds array stay attached,
  // which a delete-and-recreate would sever.
  const altIds = mergeAltIds(
    mergeAltIds(currentMetadata.altIds, canonical.altIds),
    promote
      ? ({ [survivor.type]: survivor.identifier } as CitationAltIds)
      : ({
          [canonical.type]: canonical.identifier,
        } as CitationAltIds),
  );
  const finalType = promote ? canonical.type : (survivor.type as CitationHandleType);
  const finalIdentifier = promote ? canonical.identifier : survivor.identifier;
  delete altIds[finalType as keyof CitationAltIds];

  await db
    .update(citations)
    .set({
      type: finalType,
      identifier: finalIdentifier,
      // Cached metadata already on the row wins; the incoming payload fills
      // gaps. A seed's hand-typed title never overwrites a resolved one.
      metadata: mergeMetadata({ ...(incomingMetadata ?? {}), ...currentMetadata }, altIds),
    })
    .where(eq(citations.id, survivor.id));

  return {
    id: survivor.id,
    type: finalType,
    identifier: finalIdentifier,
    created: false,
    promotedFrom,
    mergedIds,
    ...(deferredIds.length > 0 ? { deferredIds } : {}),
  };
}

/**
 * The row a free-text citation already has under different wording, if any.
 *
 * Free text has no handle to look up, so the exact-text lookup above only
 * catches a writer repeating itself character for character — and research
 * agents never do. Without this, every rewording of one reference became a row
 * of its own, beside the PMID row the paper already had: six rows for one
 * Schulz & Schmoldt review, each a separate candidate in the PDF inbox.
 *
 * Matched on the bibliographic record (first author, year, title) by
 * `citationWorkMatch.ts`, which errs towards a duplicate over a wrong merge.
 * The strongest handle among the matches wins, so a reworded reference to a
 * paper filed under its PMID lands on the PMID row. When the matches reach two
 * different resolvable handles the reference is ambiguous and nothing is
 * reused.
 *
 * Narrowed in SQL to rows of the same year; the rest is compared in memory.
 * Only a free-text write that found no exact match gets here.
 */
async function findSameWorkForFreetext(
  db: Db,
  identifier: string,
  metadata: ReferenceMetadata | null,
): Promise<{ id: number; type: string; identifier: string } | null> {
  const incoming = matchableFingerprint({
    type: 'freetext',
    identifier,
    metadata,
  });
  if (!incoming) return null;

  const candidates = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations)
    .where(sql`${citations.metadata} ->> 'year' = ${String(incoming.year)}`);

  const matches = candidates.flatMap((row) => {
    const metadata = normalizeReferenceMetadata(row.metadata);
    const fingerprint = matchableFingerprint({
      type: row.type,
      identifier: row.identifier,
      metadata,
    });
    if (!fingerprint || !isSameWork(incoming, fingerprint)) return [];
    let handleKey: string | null = null;
    if (row.type !== 'freetext') {
      const canonical = canonicalCitationHandle(
        { type: row.type as CitationHandleType, identifier: row.identifier },
        metadata?.altIds,
      );
      handleKey = `${canonical.type}:${canonical.identifier}`;
    }
    return [{ ...row, fingerprint, handleKey }];
  });
  if (matches.length === 0) return null;

  const resolvable = new Set(
    matches.flatMap((row) => (row.handleKey ? [row.handleKey] : [])),
  );
  if (resolvable.size > 1) return null;
  // Each match agrees with the incoming wording; they must also agree with one
  // another. Similarity is not transitive, so a short wording can sit between
  // two different papers — attaching it to either would be a guess.
  if (!isMutuallySameWork(matches)) return null;

  return [...matches].sort(
    (a, b) => citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
  )[0]!;
}

function mergeMetadata(
  metadata: ReferenceMetadata | null | undefined,
  altIds: CitationAltIds,
): ReferenceMetadata | null {
  const base = { ...(metadata ?? {}) };
  if (Object.keys(altIds).length > 0) base.altIds = altIds;
  else delete base.altIds;
  return Object.keys(base).length > 0 ? base : null;
}

/**
 * The alt handles a research-output source object carries directly. A deep
 * research source usually reports both a PMID and a DOI, so the crosswalk that
 * decides the canonical handle is already in hand — no lookup required.
 */
export function crosswalkFromFields(fields: {
  pmid?: string | null;
  doi?: string | null;
  pmcid?: string | null;
  url?: string | null;
}): CitationAltIds {
  const out: CitationAltIds = {};
  for (const key of ['pmid', 'doi', 'pmcid', 'url'] as const) {
    const raw = fields[key];
    if (typeof raw === 'string' && raw.trim()) {
      out[key] = normalizeHandleIdentifier(key, raw);
    }
  }
  return out;
}

/**
 * Citation rows that are the same paper filed twice. Used by the backfill CLI
 * to report split pairs; the write path never needs it because it looks up by
 * handle set instead.
 */
export async function findSplitCitationGroups(db: Db): Promise<
  Array<{
    key: string;
    rows: Array<{ id: number; type: string; identifier: string }>;
  }>
> {
  const rows = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations)
    .where(sql`${citations.type} IN ('pmid', 'doi', 'url')`);

  const byKey = new Map<
    string,
    Array<{ id: number; type: string; identifier: string }>
  >();
  for (const row of rows) {
    const metadata = normalizeReferenceMetadata(row.metadata);
    const canonical = canonicalCitationHandle(
      {
        type: row.type as CitationHandleType,
        identifier: row.identifier,
      },
      metadata?.altIds,
    );
    const key = `${canonical.type}:${canonical.identifier}`;
    const list = byKey.get(key) ?? [];
    list.push({ id: row.id, type: row.type, identifier: row.identifier });
    byKey.set(key, list);
  }

  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      rows: group.sort(
        (a, b) =>
          citationHandleRank(a.type) - citationHandleRank(b.type) || a.id - b.id,
      ),
    }));
}
