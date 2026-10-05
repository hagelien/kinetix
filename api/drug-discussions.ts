/**
 * Discussion threads.
 *
 * Two hosts share this table (drug XOR wiki page, see schema CHECK):
 *   - Drug monographs: ?drugId=&parameter=?  — parameter optional; omit for
 *     the whole-monograph thread, or pass a drug-parameter / `fact:<id>` key.
 *   - Topic (non-monograph) wiki pages: ?wikiPageId=&parameter=fact:<id>  —
 *     atomic-fact threads only. Topic pages have no whole-page or
 *     drug-parameter threads, so a fact target key is required here.
 *
 *   GET   list a thread
 *   POST  append a comment (any authenticated user)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { postDiscussionSchema } from './_lib/schemas.js';
import {
  drugParameterDiscussions,
  users,
  agents,
  wikiPages,
} from '../db/schema.js';
import { isDrugParameterId } from './_lib/drugParameterIds.js';
import { summariseApprovalsForTargets } from './_lib/approvals.js';
import { fireAgentHookForActorAsync } from './_lib/agentHooks.js';
import {
  disputeTargetUrl,
  recordImplicitAgentApproval,
} from './_lib/agent-verifications.js';
import { notifyCommentFeedback } from './_lib/commentNotifications.js';
import { isFactDiscussionTargetKey } from '../src/lib/discussionTargets.js';
import {
  callerCan,
  callerCanReadWikiPage,
} from './_lib/permissions-store.js';
import { CAP } from '../src/lib/permissions.js';

/**
 * Which host a thread belongs to. Exactly one of drugId / wikiPageId is set,
 * mirroring the table's CHECK constraint.
 */
type DiscussionHost = { drugId: number } | { wikiPageId: number };

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const drugIdRaw = url.searchParams.get('drugId');
    const wikiPageIdRaw = url.searchParams.get('wikiPageId');
    const parameterRaw = url.searchParams.get('parameter');

    // Exactly one host. Both-set or neither-set is a client error, not a
    // silently-picked default — the table CHECK would reject the row anyway.
    if ((drugIdRaw == null) === (wikiPageIdRaw == null)) {
      error(res, 400, 'Provide exactly one of drugId or wikiPageId');
      return;
    }

    let host: DiscussionHost;
    if (drugIdRaw != null) {
      const drugId = Number(drugIdRaw);
      if (!drugId || Number.isNaN(drugId)) {
        error(res, 400, 'Missing or invalid drugId');
        return;
      }
      host = { drugId };
    } else {
      const wikiPageId = Number(wikiPageIdRaw);
      if (!wikiPageId || Number.isNaN(wikiPageId)) {
        error(res, 400, 'Missing or invalid wikiPageId');
        return;
      }
      host = { wikiPageId };
    }

    // An empty `?parameter=` is malformed, not "no parameter": it would
    // otherwise be stored as '' and read back as the whole-monograph thread.
    if (
      parameterRaw !== null &&
      !isDrugParameterId(parameterRaw) &&
      !isFactDiscussionTargetKey(parameterRaw)
    ) {
      error(res, 400, 'Invalid parameter');
      return;
    }
    const parameter = parameterRaw ?? null;

    // Topic-page threads exist only for atomic facts — there is no
    // whole-page thread and no drug-parameter to discuss, so a `fact:<id>`
    // parameter is mandatory when the host is a wiki page.
    if (
      'wikiPageId' in host &&
      !isFactDiscussionTargetKey(parameterRaw ?? '')
    ) {
      error(res, 400, 'wikiPageId threads require a fact parameter');
      return;
    }

    switch (req.method) {
      case 'GET':
        return handleList(req, res, host, parameter);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res, host, parameter);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

function hostCondition(host: DiscussionHost) {
  return 'drugId' in host
    ? eq(drugParameterDiscussions.drugId, host.drugId)
    : eq(drugParameterDiscussions.wikiPageId, host.wikiPageId);
}

async function requireReadableWikiPage(
  res: ServerResponse,
  host: DiscussionHost,
  auth: Awaited<ReturnType<typeof getUserFromRequest>>,
): Promise<{ readable: true; isDraft: boolean } | { readable: false }> {
  if (!('wikiPageId' in host)) {
    return { readable: true, isDraft: false };
  }

  const db = getDb();
  const [page] = await db
    .select({ status: wikiPages.status })
    .from(wikiPages)
    .where(eq(wikiPages.id, host.wikiPageId))
    .limit(1);

  if (!page || !(await callerCanReadWikiPage(page.status, auth))) {
    error(res, 404, 'Page not found', 'wiki_page_not_found');
    return { readable: false };
  }

  return { readable: true, isDraft: page.status === 'draft' };
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  host: DiscussionHost,
  parameter: string | null,
): Promise<void> {
  const db = getDb();
  const auth = await getUserFromRequest(req);
  const access = await requireReadableWikiPage(res, host, auth);
  if (!access.readable) return;

  const condition = parameter
    ? and(
        hostCondition(host),
        eq(drugParameterDiscussions.parameter, parameter),
      )
    : and(hostCondition(host), isNull(drugParameterDiscussions.parameter));

  const rows = await db
    .select({
      id: drugParameterDiscussions.id,
      drugId: drugParameterDiscussions.drugId,
      wikiPageId: drugParameterDiscussions.wikiPageId,
      parameter: drugParameterDiscussions.parameter,
      parentId: drugParameterDiscussions.parentId,
      body: drugParameterDiscussions.body,
      createdAt: drugParameterDiscussions.createdAt,
      author: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        // Email omitted — GET on this endpoint is public; same scrapeable
        // surface concern as drug-parameter-history. Role + isAgent are
        // public anyway via /api/agents.
        role: users.role,
        isAgent: sql<boolean>`${agents.id} is not null`,
      },
    })
    .from(drugParameterDiscussions)
    .leftJoin(users, eq(drugParameterDiscussions.createdBy, users.id))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(condition)
    .orderBy(desc(drugParameterDiscussions.createdAt))
    .limit(200);

  const approvalsMap = await summariseApprovalsForTargets({
    targetType: 'drug_discussion',
    targetIds: rows.map((r) => r.id),
    callerUserId: auth?.userId,
  });
  const enriched = rows.map((row) => ({
    ...row,
    approvals: approvalsMap.get(row.id) ?? {
      count: 0,
      approvers: [],
      ...(auth ? { approvedByMe: false } : {}),
    },
  }));

  json(
    res,
    200,
    { discussions: enriched },
    access.isDraft ? { headers: noStoreHeaders() } : undefined,
  );
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  host: DiscussionHost,
  parameter: string | null,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['discussion.comment.create']))) {
    error(res, 403, 'Commenting is not available for your account');
    return;
  }

  const access = await requireReadableWikiPage(res, host, auth);
  if (!access.readable) return;

  const parsed = await parseAndValidate(req, postDiscussionSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  // `parent_id` is not a foreign key, so a reply must be checked against the
  // thread it is posted into: a parent from another parameter, fact or host
  // would attach the reply (and its notification) to an unrelated thread.
  if (parsed.data.parentId !== undefined) {
    const [parent] = await db
      .select({ id: drugParameterDiscussions.id })
      .from(drugParameterDiscussions)
      .where(
        and(
          eq(drugParameterDiscussions.id, parsed.data.parentId),
          hostCondition(host),
          parameter
            ? eq(drugParameterDiscussions.parameter, parameter)
            : isNull(drugParameterDiscussions.parameter),
        ),
      )
      .limit(1);
    if (!parent) {
      error(res, 400, 'parentId does not belong to this discussion thread');
      return;
    }
  }
  const [row] = await db
    .insert(drugParameterDiscussions)
    .values({
      drugId: 'drugId' in host ? host.drugId : null,
      wikiPageId: 'wikiPageId' in host ? host.wikiPageId : null,
      parameter,
      parentId: parsed.data.parentId ?? null,
      body: parsed.data.body,
      createdBy: auth.userId,
    })
    .returning();

  if (row) {
    // If the commenter is an active agent, the authored discussion counts
    // as that agent's implicit approval for verification purposes.
    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'drug_discussion',
      targetId: row.id,
    });
    // Fire the agent hook (#345) so the comment evaluator can react
    // without waiting for the next scheduled cycle. Best-effort —
    // never blocks the user-facing response, never throws. The hook
    // payload is drug-scoped (the evaluator hydrates a drug row), so
    // topic-page fact comments don't fire it — they have no drug.
    if ('drugId' in host) {
      fireAgentHookForActorAsync(auth.userId, {
        kind: 'comment_posted',
        drugId: host.drugId,
        parameter,
        commentId: row.id,
        authorUserId: auth.userId,
        body: parsed.data.body,
      });
    }
    // Tell the replied-to author and the contributors of the discussed
    // parameter or fact. The comment is already saved, so a failure here is
    // logged rather than turned into an error for the commenter.
    try {
      await notifyCommentFeedback({
        comment: {
          id: row.id,
          body: row.body,
          parentId: row.parentId,
          parameter: row.parameter,
          drugId: row.drugId,
          wikiPageId: row.wikiPageId,
          createdBy: row.createdBy,
        },
        url: await disputeTargetUrl({
          targetType: 'drug_discussion',
          targetId: row.id,
        }),
      });
    } catch (err) {
      console.error('[drug-discussions] comment notification failed:', err);
    }
  }

  json(res, 201, { discussion: row });
}
