/**
 * Kinetix → generic `ActorContext` resolution (§4.2 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * The core owns no authentication. The host authenticates, and hands the core
 * a normalised statement of who is acting and what they are allowed to do. This
 * module is that statement for Kinetix.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. **`kind` is derived server-side.** An actor is an `agent` because an
 *    `agents` row with `status='active'` exists for their user id, never
 *    because a request said so.
 * 2. **Action capabilities and assurance capabilities are different lists.**
 *    `capabilities` gates what the actor may *do* (submit an edit, approve a
 *    parameter) and comes from the permission matrix. `assuranceCapabilities`
 *    gates what their approval is *worth* — today that is the server-owned
 *    `agents.model_tier` snapshot behind the flagship high-risk gate. A
 *    self-reported model string never reaches either list; it is audit metadata
 *    (§2.3), and folding it into assurance would let an agent talk its way past
 *    the gate the tier exists to hold.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db.js';
import { agents, users } from '../../../db/schema.js';
import { resolveActiveAgent } from '../agent-verifications.js';
import { ROLES } from '../../../src/lib/roles.js';
import { loadPermissionOverrides } from '../permissions-store.js';
import {
  capabilitiesForTier,
  tierForRole,
} from '../../../src/lib/permissions.js';
import {
  modelTierCapability,
  type ActorContext,
} from 'assurance-core';
import { KINETIX_SPACE } from '../../../src/lib/assurance/projection.js';
import { KINETIX_CLINICAL_EXPERT_CAPABILITY } from '../../../src/lib/assurance/policy.js';

// Kinetix's single knowledge space (§4.3), re-exported so the server layer has
// one import for it. The constant itself lives with the Phase 1 projection.
export { KINETIX_SPACE };

/**
 * The roles a backing user must hold for its agent to count as active.
 *
 * `agents.status` alone does not answer "is this agent still trusted": the kill
 * switch demotes the backing user's role and leaves the status where it is, so
 * a status-only test keeps clearing an agent an operator has already stopped.
 * Rebuilt from `ROLES` rather than imported from `agent-verifications.ts`, the
 * pattern `api/agents.ts` and `verification-levels.ts` already follow, so this
 * module does not depend on another's private const.
 */
const ACTIVE_AGENT_ROLES: readonly string[] = [
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];

/** The canonical actor reference for a Kinetix user. */
export function userActorRef(userId: number): string {
  return `user:${userId}`;
}

/** Parse a `user:<id>` reference back to its user id, or `null` if it is not one. */
export function userIdFromActorRef(actorRef: string | null | undefined): number | null {
  if (!actorRef?.startsWith('user:')) return null;
  const id = Number(actorRef.slice('user:'.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Whether a Kinetix user id belongs to an **active** registered agent.
 *
 * The one test that decides `authorKind`, and it has to be this test rather
 * than "is there an author reference at all". Every `pending_edits` row has a
 * `submitted_by`, so presence proves only that somebody submitted it — deriving
 * `agent` from that labels a person's proposal as an agent's, and the policy's
 * `human-authored` rule (`when: { authorKind: 'human' } → humanApproval()`)
 * then never fires. Agent consensus would stand in for the moderator on a
 * human's work, which §1.7 forbids in that direction specifically.
 *
 * An agent whose status was revoked is `human` for the same reason the legacy
 * gate treats it that way: the exemption belongs to an active agent, not to
 * whoever once was one. The backing user's role is the second half of that
 * test, not decoration: the kill switch demotes the user below contributor and
 * leaves `agents.status` alone, so a status-only predicate would answer `agent`
 * for an agent legacy has already stopped — the same disagreement in the same
 * forbidden direction, arrived at through the other gate.
 *
 * Deliberately the same clause set as `isActiveAgentUser` and
 * `resolveActiveAgent`. `collectConsensusFacts` reads this to model what
 * `applyOnAgentConsensus` will do, and two definitions of "active agent" that
 * disagree make that comparison describe a policy nobody runs.
 *
 * Takes the handle so a caller can pass a transaction.
 */
export async function isActiveAgentSubmitter(
  db: ReturnType<typeof getDb>,
  userId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The actor kind to record for an author reference.
 *
 * `system` when there is no author, `agent` for an active registered agent, and
 * `human` for everyone else — including an agent whose status was revoked or
 * whose backing user was demoted below contributor.
 */
export async function resolveAuthorKind(
  db: ReturnType<typeof getDb>,
  authorRef: string | null | undefined,
): Promise<'agent' | 'human' | 'system'> {
  const userId = userIdFromActorRef(authorRef);
  if (userId === null) return 'system';
  return (await isActiveAgentSubmitter(db, userId)) ? 'agent' : 'human';
}

/**
 * The agent facts the governance layer is allowed to see. Everything here is
 * server-owned: none of it can be set by the caller's request.
 */
export interface AgentActorFacts {
  readonly agentId: number;
  readonly slug: string;
  readonly selfReviewEnabled: boolean;
  readonly modelTier: string | null;
}

/**
 * Kinetix permission-matrix capabilities that also confer *assurance* standing.
 *
 * Phase 11 of docs/plans/2026-08-26-general-knowledge-governance-extraction.md:
 * a clinical case's invariant is that a human with clinical standing signed it
 * off, and the plan asks for that to be a capability requirement rather than a
 * hardcoded Kinetix edit type in the core. So the core asks for
 * `clinical_expert`, and this is where the host says which of *its* capability
 * ids mean that.
 *
 * The mapping is one-way and deliberately narrow. Almost everything in the
 * permission matrix gates what an actor may *do*; only these say something
 * about what their approval is *worth*, which is a much stronger claim and one
 * that gets snapshotted into an immutable assessment.
 */
const ASSURANCE_CONFERRING_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  ['review.clinicalCase.signoff', KINETIX_CLINICAL_EXPERT_CAPABILITY],
]);

/**
 * Build an `ActorContext` from facts already in hand, without touching the DB.
 *
 * Split out from `resolveActorContext` so the projection is unit-testable and
 * so callers that already loaded the agent row (the queue does) need not load
 * it twice.
 */
export function actorContextFrom(args: {
  userId: number;
  role: string | null | undefined;
  capabilities: readonly string[];
  agent: AgentActorFacts | null;
}): ActorContext {
  const { agent } = args;
  return {
    actorRef: userActorRef(args.userId),
    kind: agent ? 'agent' : 'human',
    capabilities: [...args.capabilities].sort(),
    // Two sources, and they are different kinds of claim. The model tier is a
    // server-owned property of an agent; the clinical sign-off is a grant an
    // admin made to a person. Both belong here because both say what an
    // approval is worth rather than what the actor may do — and a tier the
    // admin has not set is absent, not `model_tier:unknown`, because an
    // explicit "unknown" would be one more string to accidentally accept.
    assuranceCapabilities: [
      ...(agent?.modelTier ? [modelTierCapability(agent.modelTier)] : []),
      ...args.capabilities
        .map((cap) => ASSURANCE_CONFERRING_CAPABILITIES.get(cap))
        .filter((cap): cap is string => cap !== undefined),
    ].sort(),
    metadata: {
      role: args.role ?? null,
      ...(agent
        ? {
            agentId: agent.agentId,
            agentSlug: agent.slug,
            // Audit-only. Self-review does not lower any bar — it enlarges the
            // reviewer pool, which raises the quorum (Phase 0 doc §5.1) — so it
            // is recorded rather than turned into a capability.
            selfReviewEnabled: agent.selfReviewEnabled,
          }
        : {}),
    },
  };
}

/**
 * Load the server-owned agent facts for a user, or `null` if they are not an
 * active agent.
 *
 * "Active agent" is decided by `resolveActiveAgent()` rather than by a query
 * written here: that helper is the rule the verification routes already run on
 * (active `agents` row AND a backing user still at contributor or above), and a
 * second copy of it would be free to drift into disagreeing with the routes
 * about who is an agent. Only `model_tier` — which it does not return — is read
 * separately, keyed by the agent id it did.
 */
export async function loadAgentActorFacts(
  userId: number,
): Promise<AgentActorFacts | null> {
  const agent = await resolveActiveAgent(userId);
  if (!agent) return null;
  const db = getDb();
  const [tierRow] = await db
    .select({ modelTier: agents.modelTier })
    .from(agents)
    .where(eq(agents.id, agent.id))
    .limit(1);
  return {
    agentId: agent.id,
    slug: agent.slug,
    selfReviewEnabled: agent.selfReviewEnabled,
    modelTier: tierRow?.modelTier ?? null,
  };
}

/**
 * Resolve the full actor context for an authenticated Kinetix caller.
 *
 * `capabilities` is the permission matrix's answer for the caller's tier, with
 * the admin overrides applied — the same source `callerCan()` consults, so the
 * governance layer can never believe an actor may do something the routes would
 * refuse.
 */
export async function resolveActorContext(auth: {
  userId: number;
  role: string;
}): Promise<ActorContext> {
  const [overrides, agent] = await Promise.all([
    loadPermissionOverrides(),
    loadAgentActorFacts(auth.userId),
  ]);
  return actorContextFrom({
    userId: auth.userId,
    role: auth.role,
    capabilities: capabilitiesForTier(tierForRole(auth.role), overrides),
    agent,
  });
}

/**
 * The context for work Kinetix does on its own behalf — sweeps, hooks, the
 * consensus auto-apply path. Not a user, and deliberately not an agent: a
 * system actor's approval must never count as peer review.
 */
export function systemActorContext(label: string): ActorContext {
  return {
    actorRef: `system:${label}`,
    kind: 'system',
    capabilities: [],
    assuranceCapabilities: [],
    metadata: { label },
  };
}

/**
 * The assurance standing one actor holds, resolved from the database (§19.1).
 *
 * The narrow, server-owned half of `resolveActorContext`, exposed separately
 * because the SDK needs exactly this and nothing else. §19.1 forbids trusting a
 * request for "verifier capability tier" or "human-expert designation", and the
 * SDK's `assessments.submit` takes a whole `ActorContext` from its caller — so
 * without this the caller's own claim about what its approval is worth would be
 * snapshotted verbatim into an immutable assessment.
 *
 * Deliberately keyed on the actor ref rather than on an auth object: the SDK
 * holds a reference, not a session. Everything that is not a `user:<id>` ref —
 * a `system:` actor, a `service:` actor, anything a second domain invents —
 * resolves to no standing at all, which is the safe direction: a system actor's
 * approval must never count as peer review (see `systemActorContext`).
 *
 * Delegates to `resolveActorContext` rather than re-deriving the rules, so the
 * tier snapshot and the clinical grant cannot drift between the two paths.
 */
export async function resolveAssuranceCapabilities(
  actorRef: string,
): Promise<readonly string[]> {
  const userId = userIdFromActorRef(actorRef);
  if (userId === null) return [];
  const db = getDb();
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // No such user: no standing. An actor ref naming a deleted account must not
  // inherit whatever the caller claimed for it.
  if (!row) return [];
  const context = await resolveActorContext({ userId, role: row.role });
  return context.assuranceCapabilities ?? [];
}
