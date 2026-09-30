/**
 * Agents listing endpoint (#319 P1).
 *
 *   GET /api/agents — list active agents with maintainer info + basic
 *     contribution stats. Authenticated users only (anonymous users are
 *     limited to the drug table per the #310 spec).
 *
 * P1 is read-only; admin CRUD + token-minting flows land in P2.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from "./_lib/response.js";
import { getDb, withDbRetry } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import { agents, users, pendingEdits } from "../db/schema.js";
import { ROLES } from "../src/lib/roles.js";

// Both filters belong here: `agents.status = 'active'` is the
// authoritative lifecycle source, and the inner-join on
// `users.role IN (contributor, editor, admin)` defends against the
// documented kill switch (`agents/remote-routine-setup.md`), which
// demotes the user directly without touching the agents row.
const ACTIVE_AGENT_ROLES: readonly string[] = [
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];

interface AgentSummary {
  id: number;
  name: string;
  nameEn: string | null;
  slug: string;
  description: string | null;
  descriptionEn: string | null;
  status: "active" | "suspended" | "deactivated";
  createdAt: string;
  agent: {
    userId: number;
    username: string;
    displayName: string | null;
    // Email omitted — any authenticated user can call this endpoint, so
    // including email would let low-privilege accounts harvest addresses
    // for all agent operators and their maintainers. Same rationale as
    // the wiki-pages and drug-discussions endpoints.
  };
  maintainer: {
    userId: number;
    username: string;
    displayName: string | null;
  } | null;
  stats: {
    /** Total pending edits the agent has submitted (any status). */
    submittedEdits: number;
    /** Approved-and-merged subset. */
    approvedEdits: number;
  };
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    error(res, 405, "Method not allowed");
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, "Authentication required");
    return;
  }

  const db = getDb();
  // INNER JOIN users so a row only surfaces when the linked user is
  // still a real contributor+. The kill switch flips users.role to
  // `authenticated`, which excludes the row here as a safety net even
  // if `agents.status` is still 'active'.
  const agentRows = await withDbRetry(() =>
    db
      .select({
        id: agents.id,
        name: agents.name,
        nameEn: agents.nameEn,
        slug: agents.slug,
        description: agents.description,
        descriptionEn: agents.descriptionEn,
        status: agents.status,
        createdAt: agents.createdAt,
        agentUserId: agents.userId,
        maintainerUserId: agents.maintainerUserId,
      })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(
        and(
          eq(agents.status, "active"),
          inArray(users.role, ACTIVE_AGENT_ROLES),
        ),
      )
      .orderBy(agents.name),
  );

  if (agentRows.length === 0) {
    json(res, 200, { agents: [] }, { headers: noStoreHeaders() });
    return;
  }

  const agentUserIds = agentRows.map((r) => r.agentUserId);
  const maintainerUserIds = agentRows
    .map((r) => r.maintainerUserId)
    .filter((id): id is number => typeof id === "number");
  const allUserIds = Array.from(
    new Set([...agentUserIds, ...maintainerUserIds]),
  );

  // Use inArray (IN (…)) rather than `= ANY(${…})`: a JS array interpolated
  // into a sql`` template is spread as positional placeholders, so
  // `= ANY(${arr})` emits `= ANY(($1, $2, $3))` — a row constructor, not an
  // array — and Postgres raises `op ANY/ALL (array) requires array on right
  // side`. inArray() compiles to `IN ($1, $2, $3)`, which accepts the same
  // positional list.
  const userRows = await withDbRetry(() =>
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(users)
      .where(inArray(users.id, allUserIds)),
  );
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // One stats row per agent. Two pass: total edits + approved edits.
  // Cheaper than per-agent count subqueries because the WHERE
  // submittedBy IN (…) hits the existing pending_edits_submitted_by_idx.
  const statsRows = await withDbRetry(() =>
    db
      .select({
        submittedBy: pendingEdits.submittedBy,
        status: pendingEdits.status,
        count: sql<number>`count(*)::int`,
      })
      .from(pendingEdits)
      .where(inArray(pendingEdits.submittedBy, agentUserIds))
      .groupBy(pendingEdits.submittedBy, pendingEdits.status),
  );

  type Stats = AgentSummary["stats"];
  const statsByAgent = new Map<number, Stats>();
  for (const row of statsRows) {
    const cur = statsByAgent.get(row.submittedBy) ?? {
      submittedEdits: 0,
      approvedEdits: 0,
    };
    cur.submittedEdits += row.count;
    if (row.status === "approved") cur.approvedEdits += row.count;
    statsByAgent.set(row.submittedBy, cur);
  }

  const list: AgentSummary[] = agentRows.map((r) => {
    const agentUser = userById.get(r.agentUserId);
    const maintainerUser =
      r.maintainerUserId != null
        ? (userById.get(r.maintainerUserId) ?? null)
        : null;
    const stats = statsByAgent.get(r.agentUserId) ?? {
      submittedEdits: 0,
      approvedEdits: 0,
    };
    return {
      id: r.id,
      name: r.name,
      nameEn: r.nameEn,
      slug: r.slug,
      description: r.description,
      descriptionEn: r.descriptionEn,
      status: r.status as AgentSummary["status"],
      createdAt: r.createdAt.toISOString(),
      agent: {
        userId: r.agentUserId,
        username: agentUser?.username ?? "",
        displayName: agentUser?.displayName ?? null,
      },
      maintainer: maintainerUser
        ? {
            userId: maintainerUser.id,
            username: maintainerUser.username,
            displayName: maintainerUser.displayName ?? null,
          }
        : null,
      stats,
    };
  });

  json(res, 200, { agents: list }, { headers: noStoreHeaders() });
});
