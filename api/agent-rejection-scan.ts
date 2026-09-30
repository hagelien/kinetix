/** Agent-only rejection learning scan, exposed through the API so scheduled
 * LLM routines do not need direct DATABASE_URL access. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import {
  error,
  json,
  withErrorHandling,
  noStoreHeaders,
} from "./_lib/response.js";
import { agents, pendingEdits, verificationLog } from "../db/schema.js";

const PRIVATE_AGENT_REJECTION_SCAN_HEADERS = noStoreHeaders();

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
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, auth.userId), eq(agents.status, "active")))
    .limit(1);
  if (!agent) {
    error(res, 403, "Agent token required");
    return;
  }

  const [[prior], rejections] = await db.batch([
    db
      .select({ agentNotes: verificationLog.agentNotes })
      .from(verificationLog)
      .where(eq(verificationLog.targetType, "rejection_review"))
      .orderBy(desc(verificationLog.verifiedAt))
      .limit(1),
    db
      .select({
        id: pendingEdits.id,
        editType: pendingEdits.editType,
        targetId: pendingEdits.targetId,
        parameter: pendingEdits.parameter,
        rejectionReason: pendingEdits.rejectionReason,
        rejectionComment: pendingEdits.rejectionComment,
        reviewedAt: pendingEdits.reviewedAt,
        submittedBy: pendingEdits.submittedBy,
      })
      .from(pendingEdits)
      .where(
        sql`${pendingEdits.status} = 'rejected'
          AND ${pendingEdits.submittedBy} IN (SELECT user_id FROM agents)
          AND ${pendingEdits.reviewedAt} > (
            SELECT COALESCE(MAX(verified_at), TIMESTAMP '1970-01-01')
            FROM verification_log
            WHERE target_type = 'rejection_review'
          )`,
      )
      .orderBy(desc(pendingEdits.reviewedAt))
      .limit(50),
  ] as const);

  json(
    res,
    200,
    {
      priorLedger: prior?.agentNotes ?? null,
      rejections,
    },
    { headers: PRIVATE_AGENT_REJECTION_SCAN_HEADERS },
  );
});
