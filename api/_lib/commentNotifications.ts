/**
 * Feedback notices for a new discussion comment (#1233 follow-up).
 *
 * A comment is feedback for three kinds of human participant:
 *
 *   - the author of the comment it replies to (`comment_reply`);
 *   - the contributors of the parameter or fact it is posted on
 *     (`comment_on_contribution`): for a drug parameter, the submitter of the
 *     latest revision someone submitted for review, and everyone who entered a
 *     source value by hand; for a wiki fact (`fact:<factId>`), the submitter of
 *     the most recent approved edit of that fact. Nobody is a contributor by
 *     having triggered a recompute, run an import, or approved their own
 *     ingested item — those rows carry a user id, not a submission;
 *   - everyone else who already commented in the same thread
 *     (`comment_in_thread`), so joining a discussion on someone else's
 *     submission means hearing how it continues.
 *
 * Each person is told once — a reply outranks "comment on your contribution",
 * which outranks "comment in a discussion you joined" — and never about their
 * own comment. Agents are skipped by {@link notifyContributionFeedback}. A
 * comment on the monograph as a whole (`parameter = null`) has no single
 * contributor; it notifies the replied-to author and the thread's other
 * participants.
 */
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { notifyContributionFeedback } from './notifications.js';
import { callerCanReadWikiPage } from './permissions-store.js';

/** Upper bound on contributors told about one comment on a busy parameter. */
const MAX_CONTRIBUTOR_RECIPIENTS = 25;
const EXCERPT_LENGTH = 300;

function excerpt(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, EXCERPT_LENGTH).trimEnd()}…`;
}

async function parentAuthor(args: {
  parentId: number;
  drugId: number | null;
  wikiPageId: number | null;
  parameter: string | null;
}): Promise<number | null> {
  // The parent must be in the same thread — same host AND same parameter or
  // fact: `parentId` is not a foreign key and is not validated against the
  // thread, so a stray id must not route a notice (and the comment text) to
  // an unrelated conversation's author.
  const result = await getDb().execute<{ created_by: number }>(sql`
    SELECT created_by
    FROM drug_parameter_discussions
    WHERE id = ${args.parentId}
      AND drug_id IS NOT DISTINCT FROM ${args.drugId}::int
      AND wiki_page_id IS NOT DISTINCT FROM ${args.wikiPageId}::int
      AND parameter IS NOT DISTINCT FROM ${args.parameter}::text
  `);
  return result.rows[0]?.created_by ?? null;
}

async function parameterContributors(
  drugId: number,
  parameter: string,
): Promise<number[]> {
  // The same notion of "submitted" as contributionAuthorUserId: a revision
  // counts only when it came from an edit someone ELSE reviewed (not an
  // aggregate recompute, an import or a self-approved ingestion), and a source
  // value only when it was entered by hand (`origin = 'contributor'`), not
  // migrated or ingested.
  const result = await getDb().execute<{ user_id: number }>(sql`
    SELECT user_id FROM (
      (
        SELECT pe.submitted_by AS user_id
        FROM drug_parameter_revisions dr
        JOIN pending_edits pe ON pe.id = dr.pending_edit_id
        WHERE dr.drug_id = ${drugId} AND dr.parameter = ${parameter}
          AND (dr.edit_summary IS NULL OR dr.edit_summary NOT LIKE 'auto:%')
          AND pe.reviewed_by IS DISTINCT FROM pe.submitted_by
        ORDER BY dr.created_at DESC, dr.id DESC
        LIMIT 1
      )
      UNION
      SELECT DISTINCT created_by AS user_id
      FROM parameter_entries
      WHERE drug_id = ${drugId} AND parameter = ${parameter}
        AND created_by IS NOT NULL
        AND origin = 'contributor'
    ) t
    LIMIT ${MAX_CONTRIBUTOR_RECIPIENTS}
  `);
  return result.rows.map((r) => r.user_id);
}

async function factAuthor(
  factId: string,
  host: { drugId: number | null; wikiPageId: number | null },
): Promise<number | null> {
  // Same factId resolution as factVerificationLevels: `add` carries it on the
  // proposed node, replace/remove/reorder on fact_target_anchor. A factId is
  // unique only within its page, so the edit must target the thread's own
  // page: the topic page itself, or the drug's monograph page(s).
  const onHostPage =
    host.wikiPageId !== null
      ? sql`target_id = ${host.wikiPageId}`
      : sql`target_id IN (SELECT id FROM wiki_pages WHERE drug_cid = ${host.drugId})`;
  const result = await getDb().execute<{ submitted_by: number }>(sql`
    SELECT submitted_by
    FROM pending_edits
    WHERE edit_type = 'wiki_fact'
      AND status = 'approved'
      -- Reviewed by someone else: a fact its submitter approved themselves
      -- (conversation ingestion) was never submitted for review.
      AND reviewed_by IS DISTINCT FROM submitted_by
      AND ${onHostPage}
      -- Only edits that wrote the fact's content: a reorder or remove names
      -- the fact too, but its submitter did not author it.
      AND (fact_operation IS NULL OR fact_operation IN ('add', 'replace'))
      AND COALESCE(
        fact_target_anchor->>'factId',
        proposed_value->'attrs'->>'factId'
      ) = ${factId}
    ORDER BY reviewed_at DESC NULLS LAST, id DESC
    LIMIT 1
  `);
  return result.rows[0]?.submitted_by ?? null;
}

/** Everyone who has already commented in the thread, earliest first. */
async function threadParticipants(args: {
  commentId: number;
  drugId: number | null;
  wikiPageId: number | null;
  parameter: string | null;
}): Promise<number[]> {
  const result = await getDb().execute<{ user_id: number }>(sql`
    SELECT created_by AS user_id
    FROM drug_parameter_discussions
    WHERE id <> ${args.commentId}
      AND drug_id IS NOT DISTINCT FROM ${args.drugId}::int
      AND wiki_page_id IS NOT DISTINCT FROM ${args.wikiPageId}::int
      AND parameter IS NOT DISTINCT FROM ${args.parameter}::text
    GROUP BY created_by
    ORDER BY min(created_at), created_by
    LIMIT ${MAX_CONTRIBUTOR_RECIPIENTS}
  `);
  return result.rows.map((r) => r.user_id);
}

/**
 * Whether `userId` may currently read the discussion's host. Drug monographs
 * are always readable; a topic page may have been unpublished since the
 * recipient contributed to it, and the notice carries the comment text, so it
 * goes only to someone the page's CURRENT visibility policy admits — the same
 * `callerCanReadWikiPage` the discussion endpoint answers 404 with.
 */
function hostReadableBy(wikiPageId: number | null): (userId: number) => Promise<boolean> {
  if (wikiPageId === null) return async () => true;
  let status: Promise<string | null> | undefined;
  return async (userId) => {
    status ??= getDb()
      .execute<{ status: string }>(sql`SELECT status FROM wiki_pages WHERE id = ${wikiPageId}`)
      .then((r) => r.rows[0]?.status ?? null);
    const pageStatus = await status;
    if (pageStatus === null) return false;
    if (pageStatus === 'published') return true;
    const user = await getDb().execute<{ role: string }>(
      sql`SELECT role FROM users WHERE id = ${userId}`,
    );
    const role = user.rows[0]?.role;
    return role ? callerCanReadWikiPage(pageStatus, { role }) : false;
  };
}

export async function notifyCommentFeedback(args: {
  comment: {
    id: number;
    body: string;
    parentId: number | null;
    parameter: string | null;
    drugId: number | null;
    wikiPageId: number | null;
    createdBy: number;
  };
  url: string;
}): Promise<void> {
  const { comment } = args;
  const told = new Set<number>([comment.createdBy]);
  const body = excerpt(comment.body);
  const mayRead = hostReadableBy(comment.wikiPageId);

  if (comment.parentId !== null) {
    const parent = await parentAuthor({
      parentId: comment.parentId,
      drugId: comment.drugId,
      wikiPageId: comment.wikiPageId,
      parameter: comment.parameter,
    });
    if (parent !== null && !told.has(parent) && (await mayRead(parent))) {
      told.add(parent);
      await notifyContributionFeedback({
        recipientUserId: parent,
        actorUserId: comment.createdBy,
        type: 'comment_reply',
        targetType: 'drug_discussion',
        targetId: comment.id,
        title: 'New reply to your comment',
        bodyMd: body,
        url: args.url,
      });
    }
  }

  let contributors: number[] = [];
  if (comment.parameter === null) {
    // A monograph-wide comment: no single contributor.
  } else if (comment.parameter.startsWith('fact:')) {
    const author = await factAuthor(comment.parameter.slice('fact:'.length), {
      drugId: comment.drugId,
      wikiPageId: comment.wikiPageId,
    });
    if (author !== null) contributors = [author];
  } else if (comment.drugId !== null) {
    contributors = await parameterContributors(comment.drugId, comment.parameter);
  }
  for (const userId of contributors) {
    if (told.has(userId)) continue;
    told.add(userId);
    if (!(await mayRead(userId))) continue;
    await notifyContributionFeedback({
      recipientUserId: userId,
      actorUserId: comment.createdBy,
      type: 'comment_on_contribution',
      targetType: 'drug_discussion',
      targetId: comment.id,
      title: 'New comment on your contribution',
      bodyMd: body,
      url: args.url,
    });
  }

  const participants = await threadParticipants({
    commentId: comment.id,
    drugId: comment.drugId,
    wikiPageId: comment.wikiPageId,
    parameter: comment.parameter,
  });
  for (const userId of participants) {
    if (told.has(userId)) continue;
    told.add(userId);
    if (!(await mayRead(userId))) continue;
    await notifyContributionFeedback({
      recipientUserId: userId,
      actorUserId: comment.createdBy,
      type: 'comment_in_thread',
      targetType: 'drug_discussion',
      targetId: comment.id,
      title: 'New comment in a discussion you joined',
      bodyMd: body,
      url: args.url,
    });
  }
}
