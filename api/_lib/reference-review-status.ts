import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { citations, paperReviews } from '../../db/schema.js';
import { getDb } from './db.js';

/**
 * Of the given citation ids, return those that are **resolvable** (pmid/doi/url,
 * i.e. not `freetext`) but lack an approved read-in-full paper review.
 *
 * This is the complement of the read-in-full reference gate
 * (`assertReferencesJudged`) applied to already-live claims. The gate runs at
 * write time and even accepts a *pending* review, so a fact or parameter can
 * still end up citing a resolvable source that has no completed full review —
 * e.g. a legacy claim created before the gate existed, a claim whose pending
 * review was later rejected, or a review since flipped to `readInFull: false`.
 * Surfacing those is the whole point: agents must not let an abstract-only (or
 * never-reviewed) source back a factual claim.
 *
 * `freetext` citations cannot be reviewed, so they are never flagged. Only the
 * live, approved `paper_reviews` table counts here — a review that is merely
 * pending has not been confirmed, so the claim stays flagged until it lands.
 */
export async function findCitationsNeedingFullReview(
  citationIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(citationIds)].filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  const flagged = new Set<number>();
  if (ids.length === 0) return flagged;

  const db = getDb();
  // Left-join the read-in-full review; the rows that survive `isNull` are the
  // resolvable citations with no such review — exactly the flagged set.
  const rows = await db
    .select({ id: citations.id })
    .from(citations)
    .leftJoin(
      paperReviews,
      and(
        eq(paperReviews.citationId, citations.id),
        eq(paperReviews.readInFull, true),
      ),
    )
    .where(
      and(
        inArray(citations.id, ids),
        ne(citations.type, 'freetext'),
        isNull(paperReviews.id),
      ),
    );

  for (const row of rows) flagged.add(row.id);
  return flagged;
}
