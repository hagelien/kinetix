/**
 * Hook-triggered agent notifications (#345).
 *
 * Fires a POST to the Claude Code Routine API ("fire" endpoint) every
 * time a user-visible event happens that we want the kinetix-agent to
 * react to:
 *
 * - A new discussion comment is posted.
 * - A wiki fact / wiki section / drug parameter revision is approved.
 *
 * The agent receives the event context as the routine's "extra turn"
 * text and is responsible for evaluating it (per
 * `agents/comment-and-fact-evaluator.md`). It either posts feedback
 * via the existing API surfaces or stamps the relevant target
 * through `/api/approvals` (#344).
 *
 * Configuration is env-only:
 * - `CLAUDE_CODE_AGENT_HOOK_URL`   — full fire URL, e.g.
 *     `https://api.anthropic.com/v1/claude_code/routines/<id>/fire`
 * - `CLAUDE_CODE_AGENT_HOOK_TOKEN` — bearer token authorized for that
 *     routine.
 *
 * Best-effort by design: missing config is a no-op (recorded as
 * `skipped`); network or 4xx/5xx failures are logged, persisted with
 * outcome `failed`, and swallowed. The hook must never block the
 * triggering write (a comment POST or a pending-edit approval).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, afterTransactionCommit } from './db.js';
import { agentHookRuns, agents, users } from '../../db/schema.js';
import { ROLES } from '../../src/lib/roles.js';

// Mirror the kill-switch defence in api/agents.ts: a contributor+ role
// on the backing users row is the second gate that an operator can
// flip independently of `agents.status` (see
// agents/remote-routine-setup.md). Keep this in sync with the
// ACTIVE_AGENT_ROLES list there.
const ACTIVE_AGENT_ROLES: readonly string[] = [
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';

/**
 * Map an event to a (targetType, targetId) pair so admins can pivot
 * the hook-runs log against the resource it touched. Returns
 * `[null, null]` when no clean mapping exists.
 */
function eventTarget(event: AgentHookEvent): [string | null, number | null] {
  switch (event.kind) {
    case 'comment_posted':
      return ['drug_discussion', event.commentId];
    case 'wiki_fact_approved':
    case 'wiki_section_approved':
    case 'parameter_approved':
    case 'monograph_approved':
    case 'paper_review_approved':
    case 'learning_unit_approved':
    case 'edit_returned':
      return ['pending_edit', event.pendingEditId];
  }
}

/**
 * Best-effort log of one hook attempt. Wrapped in its own try/catch
 * so a logging DB failure never blocks the user-facing request — the
 * hook itself is already fire-and-forget.
 */
async function recordRun(args: {
  event: AgentHookEvent;
  outcome: 'success' | 'failed' | 'skipped';
  httpStatus?: number | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  try {
    const [targetType, targetId] = eventTarget(args.event);
    await getDb()
      .insert(agentHookRuns)
      .values({
        event: args.event.kind,
        targetType,
        targetId,
        outcome: args.outcome,
        httpStatus: args.httpStatus ?? null,
        errorMessage: args.errorMessage
          ? args.errorMessage.slice(0, 500)
          : null,
        durationMs: args.durationMs ?? null,
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[agentHook] failed to persist run for ${args.event.kind}: ${message}`,
    );
  }
}

export type AgentHookEvent =
  | {
      kind: 'comment_posted';
      drugId: number;
      parameter: string | null;
      commentId: number;
      authorUserId: number;
      body: string;
    }
  | {
      kind: 'wiki_fact_approved';
      pendingEditId: number;
      revisionId: number;
      pageId: number;
      sectionId: string;
      operation: 'add' | 'replace' | 'remove' | 'reorder';
      factStatement: string | null;
    }
  | {
      kind: 'wiki_section_approved';
      pendingEditId: number;
      revisionId: number;
      pageId: number;
      operation: 'add' | 'edit' | 'reorder' | 'remove';
      sectionId: string | null;
    }
  | {
      kind: 'parameter_approved';
      pendingEditId: number;
      revisionId: number;
      drugId: number;
      parameter: string;
    }
  | {
      kind: 'monograph_approved';
      pendingEditId: number;
      revisionId: number;
      pageId: number;
    }
  | {
      kind: 'paper_review_approved';
      pendingEditId: number;
      paperReviewId: number;
      citationId: number;
    }
  | {
      kind: 'learning_unit_approved';
      pendingEditId: number;
      revisionId: number;
      unitId: number;
    }
  // Unlike the `*_approved` events (which wake the agent about *human*-driven
  // changes), this one notifies the SUBMITTING agent that a reviewer returned
  // its own edit for revision. Without it a returned edit lingers: neither the
  // rejection ledger (scans `rejected`) nor the dispute sweep (scans `pending`)
  // surfaces a `returned` row, and the reviewer cannot re-review it until the
  // submitter resubmits. See `fireAgentHookForSubmitterAsync`.
  | {
      kind: 'edit_returned';
      pendingEditId: number;
      editType: string;
      targetId: number | null;
    };

interface FirePayload {
  /** The "optional extra turn" the routine appends to its prompt. */
  text: string;
}

/**
 * Format the event locator into the JSON snippet the agent reads as
 * the routine's extra turn.
 *
 * Do not include end-user prose here. The Routines API appends this
 * string as an extra turn, so embedding a discussion body or fact
 * statement would turn untrusted user text into agent input with
 * privileged tooling available. The agent receives only structured
 * identifiers and must fetch any content through the Kinetix API,
 * treating that fetched content as untrusted data.
 */
function describeEvent(event: AgentHookEvent): string {
  switch (event.kind) {
    case 'comment_posted': {
      return JSON.stringify({
        event: {
          kind: 'comment_posted',
          drug_id: event.drugId,
          parameter: event.parameter ?? null,
          comment_id: event.commentId,
          author_user_id: event.authorUserId,
        },
      });
    }
    case 'wiki_fact_approved':
      return JSON.stringify({
        event: {
          kind: 'wiki_fact_approved',
          page_id: event.pageId,
          section_id: event.sectionId,
          operation: event.operation,
          revision_id: event.revisionId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'wiki_section_approved':
      return JSON.stringify({
        event: {
          kind: 'wiki_section_approved',
          page_id: event.pageId,
          operation: event.operation,
          section_id: event.sectionId ?? null,
          revision_id: event.revisionId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'parameter_approved':
      return JSON.stringify({
        event: {
          kind: 'parameter_approved',
          drug_id: event.drugId,
          parameter: event.parameter,
          revision_id: event.revisionId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'monograph_approved':
      return JSON.stringify({
        event: {
          kind: 'monograph_approved',
          page_id: event.pageId,
          revision_id: event.revisionId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'paper_review_approved':
      return JSON.stringify({
        event: {
          kind: 'paper_review_approved',
          citation_id: event.citationId,
          paper_review_id: event.paperReviewId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'learning_unit_approved':
      return JSON.stringify({
        event: {
          kind: 'learning_unit_approved',
          unit_id: event.unitId,
          revision_id: event.revisionId,
          pending_edit_id: event.pendingEditId,
        },
      });
    case 'edit_returned':
      // Only structured identifiers — never the reviewer's return comment. The
      // agent fetches that (untrusted) prose through the Kinetix API and treats
      // it as data, per the security note above.
      return JSON.stringify({
        event: {
          kind: 'edit_returned',
          pending_edit_id: event.pendingEditId,
          edit_type: event.editType,
          target_id: event.targetId ?? null,
        },
      });
  }
}

/**
 * Best-effort POST to the Claude Code routine fire endpoint. Never
 * throws — callers must be safe to ignore the return value. Every
 * call records exactly one row in `agent_hook_runs` (success,
 * failed, or skipped) so admins can audit hook health.
 */
export async function fireAgentHook(event: AgentHookEvent): Promise<void> {
  // Kill-switch: set CLAUDE_CODE_AGENT_HOOKS_DISABLED=1 to pause
  // hook-triggered agent runs without clearing credentials. The
  // scheduled drug-db-maintainer routine runs a catch-up sweep
  // (§7 of agents/drug-db-maintainer.md) when this is set.
  if (process.env.CLAUDE_CODE_AGENT_HOOKS_DISABLED === '1') {
    await recordRun({ event, outcome: 'skipped' });
    return;
  }

  const url = process.env.CLAUDE_CODE_AGENT_HOOK_URL;
  const token = process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN;
  if (!url || !token) {
    // Hook isn't configured for this environment (e.g. local dev /
    // preview deployment without secrets). Stay silent at the console
    // — logging on every write would be too noisy — but persist the
    // attempt so the admin panel can flag a misconfigured deploy.
    await recordRun({ event, outcome: 'skipped' });
    return;
  }

  // Allowlist the target hostname so the bearer token is never sent to
  // an arbitrary server if the env var is misconfigured or compromised
  // (e.g. pointing to an internal metadata service or attacker host).
  let parsedHookUrl: URL;
  try {
    parsedHookUrl = new URL(url);
  } catch {
    console.warn('[agentHook] CLAUDE_CODE_AGENT_HOOK_URL is not a valid URL; skipping');
    await recordRun({ event, outcome: 'skipped' });
    return;
  }
  if (
    parsedHookUrl.protocol !== 'https:' ||
    parsedHookUrl.hostname !== 'api.anthropic.com'
  ) {
    console.warn(
      `[agentHook] CLAUDE_CODE_AGENT_HOOK_URL must target https://api.anthropic.com (got ${parsedHookUrl.hostname}); skipping`,
    );
    await recordRun({ event, outcome: 'skipped' });
    return;
  }

  // Per-agent opt-in (migration 0028): the system can carry several
  // agents but only the ones with `hooks_enabled = TRUE` should drive
  // the hook routine. Skip when no active agent has opted in so a
  // scheduled-only agent never causes spurious fires against a
  // routine URL that was left configured from an earlier deploy.
  if (!(await hasHookSubscriber())) {
    await recordRun({ event, outcome: 'skipped' });
    return;
  }

  const payload: FirePayload = { text: describeEvent(event) };
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[agentHook] fire ${event.kind} returned ${res.status}: ${body.slice(0, 200)}`,
      );
      await recordRun({
        event,
        outcome: 'failed',
        httpStatus: res.status,
        errorMessage: body.slice(0, 500),
        durationMs,
      });
      return;
    }
    await recordRun({
      event,
      outcome: 'success',
      httpStatus: res.status,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agentHook] fire ${event.kind} threw: ${message}`);
    await recordRun({
      event,
      outcome: 'failed',
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
  }
}

// Module-level cache for hasHookSubscriber(). Agent status changes are rare
// (operator action, not user action), so a 60-second TTL is safe: worst case
// a newly-enabled agent delays one minute before its first hook fires, and a
// newly-disabled agent may fire one extra event. Both are acceptable. The
// cache prevents a redundant agents JOIN users round-trip on every comment
// post and every approval in warm Vercel instances.
let _hookSubscriberCache: { value: boolean; expiresAt: number } | null = null;
const HOOK_SUBSCRIBER_TTL_MS = 60_000;

// Module-level cache for the set of user IDs that back registered agents.
// Agent creation is an operator action (rare), so a 60-second TTL is safe
// and matches the hasHookSubscriber TTL above. Caching the entire set avoids
// a per-event DB round-trip on every comment post and every approval — the
// 7 fireAgentHookForActorAsync call sites in pending-edits-helpers.ts would
// otherwise each hit Neon cold.
let _agentUserIdsCache: { value: Set<number>; expiresAt: number } | null = null;
const AGENT_USER_IDS_TTL_MS = 60_000;

/**
 * Returns true when at least one active agent has opted into the hook
 * routine (`agents.hooks_enabled = TRUE`). The inner-join on `users`
 * with a contributor+ role filter mirrors api/agents.ts so the
 * documented kill switch (`agents/remote-routine-setup.md`) — which
 * demotes the backing user to `authenticated` without touching the
 * agents row — also pauses hook firing. Lookup failures are
 * swallowed and treated as "no subscriber" so a transient DB blip
 * never escalates into an unintended hook fire.
 */
export async function hasHookSubscriber(): Promise<boolean> {
  const now = Date.now();
  if (_hookSubscriberCache && _hookSubscriberCache.expiresAt > now) {
    return _hookSubscriberCache.value;
  }
  try {
    const [row] = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(
        and(
          eq(agents.hooksEnabled, true),
          eq(agents.status, 'active'),
          inArray(users.role, ACTIVE_AGENT_ROLES),
        ),
      )
      .limit(1);
    const value = Boolean(row);
    _hookSubscriberCache = { value, expiresAt: now + HOOK_SUBSCRIBER_TTL_MS };
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agentHook] hook-subscriber lookup threw: ${message}`);
    return false;
  }
}

/** Exported for test injection — clears the module-level subscriber cache. */
export function _resetHookSubscriberCache(): void {
  _hookSubscriberCache = null;
}

/** Exported for test injection — clears the module-level agent-user-ids cache. */
export function _resetAgentUserCache(): void {
  _agentUserIdsCache = null;
}

export async function isAgentUser(userId: number): Promise<boolean> {
  const now = Date.now();
  if (_agentUserIdsCache && _agentUserIdsCache.expiresAt > now) {
    return _agentUserIdsCache.value.has(userId);
  }
  const rows = await getDb().select({ userId: agents.userId }).from(agents);
  const value = new Set(rows.map((r) => r.userId));
  _agentUserIdsCache = { value, expiresAt: now + AGENT_USER_IDS_TTL_MS };
  return value.has(userId);
}

export async function fireAgentHookForActor(
  actorUserId: number,
  event: AgentHookEvent,
): Promise<void> {
  try {
    if (await isAgentUser(actorUserId)) {
      await recordRun({ event, outcome: 'skipped' });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[agentHook] actor lookup for ${actorUserId} threw: ${message}`,
    );
    await recordRun({
      event,
      outcome: 'failed',
      errorMessage: `actor lookup failed: ${message}`,
    });
    return;
  }

  await fireAgentHook(event);
}

/**
 * Fire-and-forget wrapper. Use when the caller doesn't want to await
 * the network round-trip — the hook completes in the background and
 * we never block the user-facing response on it. Errors are still
 * caught and logged inside `fireAgentHook`.
 */
export function fireAgentHookAsync(event: AgentHookEvent): void {
  // Fire-and-forget, but only once any enclosing transaction has committed: an
  // agent reacting to the hook must not observe revisions that are still
  // uncommitted or that later roll back. Outside a transaction this runs
  // immediately. It always runs on the base connection (the transaction
  // context has ended by the time afterCommit callbacks fire).
  afterTransactionCommit(() => {
    void fireAgentHook(event);
  });
}

export function fireAgentHookForActorAsync(
  actorUserId: number,
  event: AgentHookEvent,
): void {
  // Deferred until commit (see fireAgentHookAsync).
  afterTransactionCommit(() => {
    void fireAgentHookForActor(actorUserId, event);
  });
}

/**
 * Fire a hook to wake the SUBMITTING agent about the disposition of its own
 * edit (currently only `edit_returned`). This is the inverse gate of
 * {@link fireAgentHookForActor}: it dispatches *only when the submitter is an
 * agent*. A human contributor sees a returned edit in their own review UI and
 * needs no hook, and when the submitter is human there is no agent to wake.
 * Returns are always performed by a human reviewer (editor+), so there is no
 * agent→agent echo to guard against here. Fire-and-forget, deferred until the
 * enclosing transaction commits (see {@link fireAgentHookAsync}).
 */
export function fireAgentHookForSubmitterAsync(
  submitterUserId: number,
  event: AgentHookEvent,
): void {
  afterTransactionCommit(() => {
    void (async () => {
      try {
        if (!(await isAgentUser(submitterUserId))) {
          // Human-submitted edit: nothing to notify, and not an agent event —
          // don't record a run (it isn't a skipped hook, it's a non-event).
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agentHook] submitter lookup for ${submitterUserId} threw: ${message}`,
        );
        await recordRun({
          event,
          outcome: 'failed',
          errorMessage: `submitter lookup failed: ${message}`,
        });
        return;
      }
      await fireAgentHook(event);
    })();
  });
}
