/**
 * Unified disputes endpoint.
 *
 *   GET  /api/disputes[?status=&targetType=&targetId=&limit=&offset=]
 *        Deterministic dispute feed (oldest-first, stable order) for the given
 *        `status` (`open`, the default, or `resolved`). The `open` feed is the
 *        channel agents poll each cycle as their "notification" of what needs
 *        re-checking, and the list moderators triage. Readable by an active
 *        agent or a reviewer (editor/admin). `targetType` + `targetId` narrow
 *        it to the objections standing against one item — what the /review
 *        card reads to show a blocked edit's dispute — and that form is also
 *        readable by the target's own author. `status=resolved` requires both
 *        `targetType` and `targetId`: it lets the target's author (or a
 *        reviewer) recover the full row — reason and evidence — behind a
 *        ruling that already closed it, once it has dropped out of the `open`
 *        feed.
 *
 *   POST /api/disputes   { targetType, targetId, targetVersion, reasonMd, evidenceRefs? }
 *        Open (or refresh) a dispute on a target. Available to any contributor+
 *        human and to active agents — this is the first-class "dispute" verb
 *        humans previously lacked. An open dispute blocks consensus auto-apply
 *        and fans out in-app notifications to the target author + all reviewers.
 *        `targetVersion` is the same opaque token GET-queue callers and
 *        POST /api/agent-verifications already carry (verificationTargetVersion);
 *        a caller whose target moved since they read it gets 409
 *        `dispute_target_version_stale` instead of a dispute bound to content
 *        its author already revised away from (#1321).
 *
 *   PATCH /api/disputes?id=N   { resolution }
 *        Close a dispute (reviewer/editor/admin only). resolution ∈
 *        upheld | rejected | withdrawn. Fans out a dispute_resolved notice.
 *        `upheld` on a `pending_edit` also **returns** that edit to its author
 *        with the objection's own text as the return note — the ruling's
 *        documented disposition, carried out rather than only advised, under
 *        the same moderation guards as a manual return and in one transaction
 *        with the ruling. See `_lib/upheld-dispute-return.ts` for why the
 *        objection *is* the note.
 *
 * Auth is the same getUserFromRequest used everywhere (human JWT or kxat_
 * agent token). Untrusted: reasonMd / evidenceRefs are author-authored data.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getUserFromRequest } from './_lib/auth.js';
import {
  error,
  json,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { createDisputeSchema, resolveDisputeSchema } from './_lib/schemas.js';
import {
  disputeTargetUrl,
  resolveActiveAgent,
  targetAuthorUserId,
  visibleVerificationTargetIds,
} from './_lib/agent-verifications.js';
import {
  listOpenDisputes,
  resolveDisputeById,
  upsertOpenDispute,
  StaleDisputeTargetError,
} from './_lib/disputes.js';
import { verificationTargetVersion } from './_lib/verification-targets.js';
import { returnPendingEditForUpheldDispute } from './_lib/upheld-dispute-return.js';
import { runInPoolTransaction } from './_lib/db.js';
import { fanOutDisputeNotification } from './_lib/notifications.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { disputeTargetTypeSchema } from './_lib/schemas.js';
import type { DisputeTargetType } from '../db/schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (req.method) {
    case 'GET':
      return handleGet(req, res);
    case 'POST':
      assertSameOrigin(req);
      return handlePost(req, res);
    case 'PATCH':
      assertSameOrigin(req);
      return handlePatch(req, res);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const statusRaw = url.searchParams.get('status') ?? 'open';
  if (statusRaw !== 'open' && statusRaw !== 'resolved') {
    error(res, 400, `Unknown status "${statusRaw}"`);
    return;
  }
  const status = statusRaw;

  const targetTypeRaw = url.searchParams.get('targetType');
  let targetType: DisputeTargetType | undefined;
  if (targetTypeRaw) {
    const parsed = disputeTargetTypeSchema.safeParse(targetTypeRaw);
    if (!parsed.success) {
      error(res, 400, `Unknown targetType "${targetTypeRaw}"`);
      return;
    }
    targetType = parsed.data;
  }

  const targetIdRaw = url.searchParams.get('targetId');
  let targetId: number | undefined;
  if (targetIdRaw !== null) {
    const parsedId = Number(targetIdRaw);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      error(res, 400, '?targetId must be a positive integer');
      return;
    }
    if (!targetType) {
      error(res, 400, '?targetId requires ?targetType');
      return;
    }
    targetId = parsedId;
  }

  // The resolved feed only ever answers "what closed against this one
  // target?" — there is no resolved-backlog equivalent of the open queue, so
  // it always needs a target to scope to.
  if (
    status === 'resolved' &&
    (targetType === undefined || targetId === undefined)
  ) {
    error(res, 400, '?status=resolved requires ?targetType and ?targetId');
    return;
  }

  // The global feed is for the two parties that act on the backlog: agents
  // (re-check) and moderators (triage). Plain contributors don't get it.
  //
  // A single-target read is a different question — "what is standing against
  // this one item?" — and the target's own author is entitled to the answer:
  // an open dispute blocks their submission, and the dispute notification
  // already carried its reason to them. Without this they met the block with
  // no way to read, let alone answer, the objection behind it.
  const agent = await resolveActiveAgent(auth.userId);
  const mayReadQueue =
    Boolean(agent) || (await callerCan(auth.role, CAP['dispute.queue.read']));
  if (!mayReadQueue) {
    const authorUserId =
      targetType && targetId !== undefined
        ? await targetAuthorUserId({ targetType, targetId })
        : null;
    if (authorUserId === null || authorUserId !== auth.userId) {
      error(res, 403, 'Active agent or reviewer required', 'disputes_forbidden');
      return;
    }
  }

  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isInteger(limitRaw) ? limitRaw : DEFAULT_LIMIT),
  );
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isInteger(offsetRaw) ? offsetRaw : 0);

  const feed = await listOpenDisputes({
    status,
    targetType,
    targetId,
    limit,
    offset,
  });
  json(res, 200, { disputes: feed }, { headers: noStoreHeaders() });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  // Anyone who can contribute content can contest it. Agents (contributor-role
  // backing user) pass this gate too; we tag their rows source='agent'.
  if (!(await callerCan(auth.role, CAP['dispute.open']))) {
    error(
      res,
      403,
      'Contributor role required to open a dispute',
      'disputes_forbidden',
    );
    return;
  }

  const parsed = await parseAndValidate(req, createDisputeSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { targetType, targetId, reasonMd, targetVersion } = parsed.data;
  const evidenceRefs = parsed.data.evidenceRefs ?? [];

  // Target must exist and be visible to the caller's role — reuse the same
  // visibility gate agent verifications enforce so a dispute can't probe for
  // hidden draft/moderator-queue rows.
  const agent = await resolveActiveAgent(auth.userId);
  const visible = await visibleVerificationTargetIds({
    targetType,
    targetIds: [targetId],
    callerUserId: auth.userId,
    callerRole: auth.role,
    callerAgentId: agent?.id ?? null,
  });
  if (visible.length === 0) {
    error(res, 404, 'Target not found', 'disputes_target_not_found');
    return;
  }

  // Pre-check: the same target-version comparison POST /api/agent-verifications
  // makes, so a caller reading a stale target gets a 409 named clearly instead
  // of a dispute silently opened against content they never saw. The write
  // below re-checks this atomically (#1321) — this is only the cheap,
  // client-facing rejection for the common case.
  const currentVersion = await verificationTargetVersion({ targetType, targetId });
  if (!currentVersion) {
    error(res, 404, 'Target not found', 'disputes_target_not_found');
    return;
  }
  if (currentVersion !== targetVersion) {
    error(
      res,
      409,
      'Target changed since it was read',
      'dispute_target_version_stale',
    );
    return;
  }

  let id: number;
  let inserted: boolean;
  try {
    ({ id, inserted } = await upsertOpenDispute({
      targetType,
      targetId,
      createdBy: auth.userId,
      source: agent ? 'agent' : 'human',
      reasonMd,
      evidenceRefs,
      targetVersion,
    }));
  } catch (err) {
    if (err instanceof StaleDisputeTargetError) {
      error(
        res,
        409,
        'Target changed since it was read',
        'dispute_target_version_stale',
      );
      return;
    }
    throw err;
  }

  // Notify the author + reviewers only when the dispute is newly raised, not on
  // every reason edit, so an author isn't pinged repeatedly for one contest.
  let recipients = 0;
  if (inserted) {
    const authorUserId = await targetAuthorUserId({ targetType, targetId });
    ({ recipients } = await fanOutDisputeNotification({
      type: 'dispute_opened',
      disputeId: id,
      targetType,
      targetId,
      actorUserId: auth.userId,
      targetAuthorUserId: authorUserId,
      title: 'A fact or parameter you can review was disputed',
      bodyMd: reasonMd,
      url: await disputeTargetUrl({ targetType, targetId }),
    }));
  }

  json(
    res,
    inserted ? 201 : 200,
    { id, inserted, recipients },
    { headers: noStoreHeaders() },
  );
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['dispute.resolve']))) {
    error(
      res,
      403,
      'Reviewer role required to resolve a dispute',
      'disputes_forbidden',
    );
    return;
  }

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const idRaw = url.searchParams.get('id');
  const id = Number(idRaw);
  if (!idRaw || !Number.isInteger(id) || id <= 0) {
    error(res, 400, 'A positive integer ?id is required');
    return;
  }

  const parsed = await parseAndValidate(req, resolveDisputeSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const resolution = parsed.data.resolution;

  // Upholding says the objection was right, so the proposal it contests is
  // meant to go back to its author. Doing only the bookkeeping left that
  // disposition to a second, separate click the moderator had to remember —
  // and when nobody made it, a human-raised objection never reached the
  // submitting agent at all (its sweeps watch verdicts and returns, not
  // rulings). Ruling and return are therefore one act, and they commit as one:
  // the ruling closes the row the return is authorized by, so a failure
  // between them would leave a resolved dispute over a still-pending edit that
  // no retry can finish — the PATCH would answer `disputes_not_found` on the
  // row it just closed, stranding the very edit this endpoint exists to free.
  //
  // Only an uphold pays for the pool transaction. Overruling and withdrawal
  // touch one row and keep the plain http path.
  let pendingEditReturned: boolean | undefined;
  let pendingEditReturnSkipped: string | undefined;
  const mayDecide = await callerCan(auth.role, CAP['review.edit.decide']);
  const mayDecideOwn = await callerCan(auth.role, CAP['review.edit.decideOwn']);
  const mayDecideModelStructure = await callerCan(
    auth.role,
    CAP['edit.modelStructure.decide'],
  );

  const resolveAndReturn = async () => {
    const resolved = await resolveDisputeById({
      id,
      resolution,
      resolvedBy: auth.userId,
    });
    if (!resolved) return null;
    if (resolution === 'upheld' && resolved.targetType === 'pending_edit') {
      const outcome = await returnPendingEditForUpheldDispute({
        pendingEditId: resolved.targetId,
        disputeId: resolved.id,
        source: resolved.source,
        reasonMd: resolved.reasonMd,
        evidenceRefs: resolved.evidenceRefs,
        disputeRaisedAt: resolved.createdAt,
        targetVersion: resolved.targetVersion,
        resolvedBy: auth.userId,
        mayDecide,
        mayDecideOwn,
        mayDecideModelStructure,
      });
      pendingEditReturned = outcome.returned;
      if (!outcome.returned) pendingEditReturnSkipped = outcome.reason;
    }
    return resolved;
  };

  const row =
    resolution === 'upheld'
      ? await runInPoolTransaction(resolveAndReturn)
      : await resolveAndReturn();
  if (!row) {
    // Either no such dispute or it was already resolved.
    error(res, 404, 'Open dispute not found', 'disputes_not_found');
    return;
  }

  const authorUserId = await targetAuthorUserId({
    targetType: row.targetType as DisputeTargetType,
    targetId: row.targetId,
  });
  await fanOutDisputeNotification({
    type: 'dispute_resolved',
    disputeId: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    actorUserId: auth.userId,
    targetAuthorUserId: authorUserId,
    title: `Dispute ${resolution}`,
    url: await disputeTargetUrl({
      targetType: row.targetType as DisputeTargetType,
      targetId: row.targetId,
    }),
  });

  json(
    res,
    200,
    {
      id: row.id,
      resolution,
      // Present only for an upheld pending-edit ruling: `false` plus a reason
      // tells the card the proposal still needs a disposition (it was already
      // decided, or returning it would need `review.edit.decideOwn`), so the
      // moderator is not left believing the edit went back when it did not.
      ...(pendingEditReturned !== undefined ? { pendingEditReturned } : {}),
      ...(pendingEditReturnSkipped !== undefined
        ? { pendingEditReturnSkipped }
        : {}),
    },
    { headers: noStoreHeaders() },
  );
}
