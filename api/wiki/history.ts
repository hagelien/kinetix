import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, desc, lt } from "drizzle-orm";
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from "../_lib/response.js";
import { getDb } from "../_lib/db.js";
import { getUserFromRequest } from "../_lib/auth.js";
import {
  callerCan,
  callerCanReadWikiPage,
} from "../_lib/permissions-store.js";
import { CAP } from "../../src/lib/permissions.js";
import { wikiPages, wikiRevisions, users } from "../../db/schema.js";
import { summariseApprovalsForTargets } from "../_lib/approvals.js";
import { buildWordDiff, textFromContent } from "../../src/lib/textDiff.js";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const MAX_DIFF_CELLS = 250_000;

async function canReadRevisionDiff(
  role: string | null | undefined,
): Promise<boolean> {
  return callerCan(role, CAP["wiki.history.read"]);
}

function parseNonNegativeInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function diffCellCount(before: string, after: string): number {
  const beforeWords = before.split(/\s+/).filter(Boolean).length;
  const afterWords = after.split(/\s+/).filter(Boolean).length;
  return (beforeWords + 1) * (afterWords + 1);
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    error(res, 405, "Method not allowed");
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const slug = url.searchParams.get("slug");
  if (!slug) {
    error(res, 400, "Missing slug parameter");
    return;
  }
  const revisionIdParam = url.searchParams.get("revisionId");
  const revisionId = revisionIdParam ? Number(revisionIdParam) : null;
  if (
    revisionIdParam &&
    (!Number.isInteger(revisionId) || Number(revisionId) <= 0)
  ) {
    error(res, 400, "Invalid revisionId parameter");
    return;
  }
  const limit = Math.min(
    parseNonNegativeInt(url.searchParams.get("limit"), DEFAULT_HISTORY_LIMIT),
    MAX_HISTORY_LIMIT,
  );
  const offset = parseNonNegativeInt(url.searchParams.get("offset"), 0);

  const db = getDb();

  try {
    // Page lookup and auth are independent — run in parallel to save one
    // Neon HTTP round-trip on authenticated requests.
    const [[page], auth] = await Promise.all([
      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          status: wikiPages.status,
        })
        .from(wikiPages)
        .where(eq(wikiPages.slug, slug))
        .limit(1),
      getUserFromRequest(req),
    ]);

    if (!page) {
      error(res, 404, "Page not found");
      return;
    }

    if (
      !(await callerCanReadWikiPage(
        page.status,
        page.status === "published" ? null : auth,
      ))
    ) {
      error(res, 404, "Page not found");
      return;
    }

    if (revisionId !== null) {
      if (!(await canReadRevisionDiff(auth?.role))) {
        error(res, 403, "wiki.diffReviewerRequired");
        return;
      }

      const [currentRevision] = await db
        .select({
          id: wikiRevisions.id,
          content: wikiRevisions.content,
        })
        .from(wikiRevisions)
        .where(
          and(
            eq(wikiRevisions.pageId, page.id),
            eq(wikiRevisions.id, revisionId),
          ),
        )
        .limit(1);

      if (!currentRevision) {
        error(res, 404, "Revision not found");
        return;
      }

      const [previousRevision] = await db
        .select({
          content: wikiRevisions.content,
        })
        .from(wikiRevisions)
        .where(
          and(
            eq(wikiRevisions.pageId, page.id),
            lt(wikiRevisions.id, currentRevision.id),
          ),
        )
        .orderBy(desc(wikiRevisions.id))
        .limit(1);

      const beforeText = textFromContent(previousRevision?.content);
      const afterText = textFromContent(currentRevision.content);
      if (diffCellCount(beforeText, afterText) > MAX_DIFF_CELLS) {
        error(res, 413, "wiki.diffTooLarge");
        return;
      }

      const diff = buildWordDiff(beforeText, afterText);

      json(
        res,
        200,
        { revisionId: currentRevision.id, diff },
        { headers: noStoreHeaders() },
      );
      return;
    }

    const rows = await db
      .select({
        id: wikiRevisions.id,
        editSummary: wikiRevisions.editSummary,
        createdAt: wikiRevisions.createdAt,
        createdBy: {
          username: users.username,
        },
      })
      .from(wikiRevisions)
      .leftJoin(users, eq(wikiRevisions.createdBy, users.id))
      .where(eq(wikiRevisions.pageId, page.id))
      .orderBy(desc(wikiRevisions.createdAt), desc(wikiRevisions.id))
      .limit(limit + 1)
      .offset(offset);
    const revisions = rows.slice(0, limit);

    // Batch-load approval summaries so each revision row carries its
    // own stamp count + approver preview without N+1 queries (#344).
    const approvalsMap = await summariseApprovalsForTargets({
      targetType: "wiki_revision",
      targetIds: revisions.map((r) => r.id),
      callerUserId: auth?.userId,
    });
    const enriched = revisions.map((r) => ({
      ...r,
      approvals: approvalsMap.get(r.id) ?? {
        count: 0,
        approvers: [],
        ...(auth ? { approvedByMe: false } : {}),
      },
    }));

    const responseInit =
      page.status !== "published" || auth
        ? { headers: noStoreHeaders() }
        : undefined;
    json(
      res,
      200,
      {
        pageTitle: page.title,
        revisions: enriched,
        limit,
        offset,
        hasMore: rows.length > limit,
      },
      responseInit,
    );
  } catch {
    error(res, 500, "Failed to fetch history");
  }
});
