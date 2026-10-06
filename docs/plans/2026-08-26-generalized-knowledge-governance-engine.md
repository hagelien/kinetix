# Generalized Knowledge Governance Engine

**Status:** proposal  
**Date:** 2026-08-26  
**Scope:** extract and generalize Kinetix's contribution, review, verification, dispute, and publication machinery into a reusable knowledge-governance subsystem without weakening current scientific or editorial safeguards.

## 0. Executive decision

Kinetix already contains the core of a reusable knowledge-governance system. The reusable unit is not the pharmacology database and it is not an agent framework. It is the control plane that governs how a proposed knowledge change becomes authoritative:

1. an authenticated actor proposes a change;
2. the proposal is validated against domain rules;
3. evidence is attached and, where required, itself reviewed;
4. independent reviewers assess an immutable version of the proposal;
5. disputes can hold the proposal;
6. a deterministic policy evaluates risk, reviewer independence, reviewer capability, and human-signoff requirements;
7. the proposal is either applied, held, returned, rejected, or escalated;
8. the whole chain remains auditable.

Kinetix has these concepts today, but they are distributed across pharmacology-specific tables, API routes, switch statements, helper modules, and agent protocols. The goal of this project is to make the governance mechanics reusable while leaving pharmacology semantics in Kinetix adapters.

The implementation must be a strangler migration, not a rewrite. Current behavior is the safety specification. We will first characterize it with contract tests, then introduce a generic core behind the existing endpoints, then dual-write/shadow-evaluate, then cut edit types over in increasing order of consequence. Calculation-driving parameters are deliberately late in the migration.

The target end state is:

```text
                          Host application
                                |
                    +-----------+-----------+
                    |     Domain adapters   |
                    |                       |
                    | validate   diff       |
                    | evidence   risk       |
                    | review packet         |
                    | apply                 |
                    +-----------+-----------+
                                |
                  Knowledge Governance Engine
                                |
          +---------------------+----------------------+
          |                     |                      |
       Actors              Proposals              Evidence
   + capabilities          + versions             + links
          |                     |                      |
          +--------------- Assessments ----------------+
                                |
                           Disputes
                                |
                             Policy
                                |
                 apply / hold / escalate / reject
                                |
                       immutable audit trail
```

The first implementation lives inside this repository. Only after Kinetix itself has been migrated and a second non-pharmacology domain has proved the abstraction do we extract packages into a separate repository.

---

## 1. Goals

### 1.1 Functional goals

The generic subsystem must support:

- human and AI-agent contributors;
- host-defined roles and capabilities;
- queued proposals for creating, updating, removing, and reordering knowledge;
- immutable proposal versions;
- evidence attached to proposals and assessments;
- independent `approve | dispute | abstain` assessments;
- blinded agent review, where a reviewer cannot see peer verdicts before judging;
- explicit disputes with a human-resolvable lifecycle;
- deterministic, server-owned risk classification inputs;
- risk-sensitive publication rules;
- capability-sensitive review requirements;
- mandatory human review for host-defined classes of content;
- self-review only when explicitly granted by the host;
- stale-version rejection and optimistic concurrency controls;
- automatic application when policy is satisfied;
- human moderation when policy is not satisfied;
- append-only decision and assessment history;
- a durable mapping from every authoritative revision to the proposal version, evidence, assessments, policy version, and decision that produced it;
- reusable agent-facing review APIs;
- host-specific UI projections such as Kinetix's verification levels.

### 1.2 Architectural goals

The system must:

- contain no pharmacology concepts in the generic core;
- depend on host-provided authentication rather than owning login/session logic;
- use adapters for domain validation, risk classification, evidence rules, review payload construction, and application;
- keep policy evaluation pure and testable wherever possible;
- make every policy decision reproducible from stored inputs;
- fail closed when an adapter, policy, capability snapshot, or version cannot be resolved;
- preserve Kinetix behavior throughout migration;
- avoid a large workspace/package restructuring until the abstraction has been proven in production.

### 1.3 Product goal

A future application should be able to adopt the system by implementing a small set of adapters and policies rather than copying Kinetix routes and tables. Examples could include a clinical guideline knowledge base, legal or regulatory knowledge, technical standards, research synthesis, or an internally governed project knowledge base.

---

## 2. Non-goals

The first extraction will **not** attempt to:

- build a general autonomous-agent runtime or scheduler;
- replace Claude Code Routines, Codex, or other agent execution environments;
- make the persistence layer database-agnostic on day one;
- make the policy system an end-user programmable rules language on day one;
- generalize Kinetix's pharmacology schema;
- move Kinetix citations, drug parameters, wiki structures, or monographs into the generic package;
- replace Kinetix authentication;
- rebuild the React application around a new UI framework;
- reconstruct historical verdict states that the current mutable/upsert model no longer contains;
- change scientific acceptance criteria merely because the implementation moves.

Postgres + Drizzle is the correct first persistence target because that is what Kinetix already uses. The pure policy/core package should avoid depending on Drizzle, but the first storage implementation does not need an abstraction for every database.

---

## 3. Existing Kinetix substrate

This section identifies the current components that form the source system. The extraction should preserve their important invariants while separating generic mechanics from domain semantics.

### 3.1 Identity and authority

Relevant files:

- `db/schema.ts`
  - `users`
  - `agents`
  - agent lifecycle and server-owned `model_tier`
- `src/lib/roles.ts`
- `src/lib/permissions.ts`
- `api/_lib/permissions-store.ts`
- `api/_lib/auth.ts`

Important existing invariant:

> Authority to perform an action and epistemic confidence in a claim are separate dimensions.

A contributor can propose without being able to decide. An agent can provide an assessment without resolving another actor's dispute. Some decisions have structural floors that an administrator cannot lower below a safe minimum.

The generic engine should receive a resolved `ActorContext` from the host instead of owning users or sessions.

### 3.2 Proposal workflow

Relevant files:

- `db/schema.ts` -> `pending_edits`
- `api/pending-edits.ts`
- `api/_lib/pending-edits-helpers.ts`
- `api/_lib/pending-edit-review-token.ts`
- `src/lib/pendingEditsApi.ts`
- `src/pages/ReviewPage.tsx`

Current states include:

- `draft`
- `pending`
- `approved`
- `rejected`
- `returned`

`pending_edits` is already a generic-shaped table, but its `editType`, payload fields, validation, conflict handling, hydration, and apply behavior are Kinetix-specific.

### 3.3 Assessments and assurance

Relevant files:

- `db/schema.ts` -> `agent_verifications`
- `api/_lib/agent-verifications.ts`
- `api/agent-verifications.ts`
- `api/agent-verifications-queue.ts`
- `src/lib/verificationLevel.ts`
- `api/_lib/verification-levels.ts`
- `agents/peer-verification-protocol.md`

Important invariants to preserve:

- `approve | dispute | abstain` verdicts;
- rationale required for negative/indeterminate judgments;
- evidence references can accompany a verdict;
- one current verdict per actor and target in the current implementation;
- reviewer independence;
- no self-verification unless an administrator explicitly enables it;
- stale target versions are rejected;
- agents use a blind review queue that omits peer verdicts and approval counts;
- server-owned verifier capability, not self-reported model strings, drives high-risk gates;
- the submitter's implicit stake is different from an independent review act.

### 3.4 Disputes

Relevant files:

- `api/_lib/disputes.ts`
- dispute tables in `db/schema.ts`
- dispute handling in `api/agent-verifications.ts`
- dispute handling in `api/pending-edits.ts`

Important invariant:

> Positive assurance and contestation are orthogonal.

A claim can have substantial corroboration and still be disputed. The generic engine must not collapse these into one scalar trust score.

### 3.5 Risk-sensitive consensus

Relevant files:

- `api/_lib/agent-verifications.ts`
  - `effectiveConsensusQuorum`
  - `isHighRiskPendingEdit`
  - `consensusApprovalHoldReason`
- `api/agent-verifications.ts`
- `docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md`
- `tests/api/agent-verifications-helpers.test.ts`

Current important behavior:

- ordinary agent-authored pending edits may auto-apply after sufficient independent approvals and no open dispute;
- degraded quorum can be permitted when the active pool is too small for ordinary edits;
- calculation-driving edits require the full design quorum and a flagship-tier verifier;
- an unclassified verifier does not satisfy the flagship requirement;
- ~~human-authored proposals are peer-reviewed but never agent-consensus auto-published~~ (retired by `kinetix-consensus@v2` / `kinetix-consensus-apply@v3`: a person's proposal now publishes on agent consensus under the same bar as an agent's; only an unattributed proposal still needs a person);
- clinical cases always require a human expert.

These are excellent examples of host policy, but the pharmacology-specific predicates do not belong in the generic core.

### 3.6 Evidence gates

Relevant files:

- `api/_lib/pending-edits-helpers.ts`
  - `assertReferencesJudged`
  - `assertReferencesJudgedForActor`
  - `ReferenceGateError`
- citation, paper-review, PDF-request, and PDF tables/routes
- paper-review agent protocols

The reusable concept is not "a paper must be read in full". The reusable concept is:

> A policy or domain adapter may require evidence artifacts to satisfy host-defined assurance conditions before a proposal can be submitted, approved, or applied.

Kinetix will continue to implement its scientific full-text requirement in its adapter layer.

### 3.7 Learning from rejection

Relevant files:

- `src/lib/rejectionReasons.ts`
- `agents/cross-agent-learning-protocol.md`
- `verification_log` in `db/schema.ts`

This is valuable but is not part of the first extraction boundary. It should become an extension after the core proposal/review/decision pipeline is stable.

---

## 4. Design principles and hard invariants

These should be treated as architectural constraints, not suggestions.

### 4.1 Immutable reviewed content

Every assessment must point to an immutable `proposal_version_id` or other immutable review subject version.

If a proposal changes after review, it gets a new version. Prior assessments remain attached to the old version and are not deleted or silently repointed.

### 4.2 Append-only evidence of decisions

Do not reproduce the current historical limitation where an agent changing a verdict overwrites the earlier verdict through an upsert.

If an actor changes a verdict, write a new assessment event that supersedes the old one. Current state is a projection of immutable events.

Likewise, policy decisions should be append-only records. Re-evaluating a proposal creates another decision record.

### 4.3 Host owns identity; engine owns governance semantics

The host authenticates the request and supplies:

```ts
interface ActorContext {
  subject: string;             // stable host-scoped identity, e.g. "user:123"
  kind: 'human' | 'agent' | 'service';
  capabilities: readonly string[];
  attributes: Record<string, string | number | boolean | null>;
  assurance: {
    capabilityTier?: string | null;
    selfReviewEnabled?: boolean;
  };
}
```

The engine must never trust an actor to supply its own privileged attributes. `ActorContext` is created server-side by the host integration.

### 4.4 Server-owned snapshots

When an assessment is cast, relevant reviewer attributes are snapshotted into the assessment event. For Kinetix this includes the server-owned verifier tier.

A later role/model/tier change must not retroactively alter what capability actually supported an old decision.

### 4.5 Blinded independent review

The agent review queue must not expose:

- other agents' verdicts;
- aggregate approval/dispute counts;
- another reviewer's rationale;
- dispute rationale when the reviewer is expected to cast an independent peer verdict.

A separate moderator/adjudicator surface can expose those signals after the independent judgment is recorded.

### 4.6 Risk is host-classified, never self-declared

The proposal author may provide content and metadata but may not provide a trusted `risk=low` value that weakens its own gate.

Risk comes from adapter logic and server-owned context.

### 4.7 Policy is deterministic

Given:

- proposal version;
- current authoritative state;
- risk profile;
- evidence state;
- actor snapshot;
- current assessments;
- current disputes;
- active reviewer-pool state where relevant;
- policy version;

the engine must return the same decision.

Persist enough of these inputs, or immutable references to them, to explain why the decision occurred.

### 4.8 Unknown states fail closed

Examples:

- unknown adapter -> no apply;
- unknown policy -> no apply;
- missing verifier tier when a high-assurance tier is required -> no apply;
- stale proposal version -> refuse assessment/apply;
- unresolved target version -> no apply;
- failed dual-write during migration -> preserve legacy authoritative behavior and alert;
- policy-evaluation exception -> hold for human review, never infer approval.

### 4.9 Generic core does not know Kinetix types

The generic core may understand `resourceType: string` and `mutationKind`, but it must not branch on:

- `halfLife`;
- `drug_parameter_revision`;
- `wiki_fact`;
- `clinical_case`;
- `paper_review`;
- `metabolism`;
- Kinetix citation types.

Any such branch belongs in a Kinetix adapter or Kinetix policy definition.

---

## 5. Terminology

Use these terms consistently in code and docs.

### Actor

A human, AI agent, or service identity performing a governance action.

### Resource

The host-domain knowledge object being governed. Examples in Kinetix: a drug parameter, a wiki fact, a parameter entry, or a learning unit.

### Proposal

A request to mutate authoritative knowledge.

### Proposal version

An immutable snapshot of a proposal's payload, evidence links, base revision, and author-visible metadata at one point in time.

### Assessment

An independent judgment on an immutable review subject. Initial verdict vocabulary:

- `approve`
- `dispute`
- `abstain`

### Dispute

A contestation that requires explicit resolution. A dispute is not simply a negative score.

### Risk profile

Server-computed tags/attributes describing how consequential a proposal is for policy purposes.

### Policy

The host's deterministic rules for whether the current evidence/assessment state permits automatic application, requires human review, or blocks progression.

### Decision

A recorded result of evaluating policy against a particular proposal version and governance state.

### Applied revision

The authoritative host-domain revision produced from an accepted proposal version.

### Assurance profile

A structured summary of the evidence and review state. Host applications may project this into simplified labels such as Kinetix's levels 0-3.

---

## 6. Target code architecture

Do not create a separate repository first. Introduce the abstraction inside Kinetix using a dependency direction that can later be lifted out cleanly.

### 6.1 Initial in-repo structure

```text
src/lib/knowledge-governance/
  core/
    types.ts
    actor.ts
    policy.ts
    requirements.ts
    assurance.ts
    state-machine.ts
    hashing.ts
    errors.ts
    index.ts

api/_lib/knowledge-governance/
  store/
    proposals.ts
    assessments.ts
    disputes.ts
    decisions.ts
    revisions.ts
    evidence-links.ts
    audit.ts
  adapter-registry.ts
  policy-registry.ts
  review-queue.ts
  decision-service.ts
  proposal-service.ts
  assessment-service.ts
  apply-service.ts
  actor-bridge.ts
  index.ts

api/_lib/kinetix-governance/
  policy.ts
  evidence.ts
  risk.ts
  adapters/
    drug-parameter.ts
    parameter-entry.ts
    wiki-fact.ts
    wiki-section.ts
    wiki-page.ts
    paper-review.ts
    learning-unit.ts
    clinical-case.ts
    metabolism.ts
    receptor-targets.ts
    enzyme-interaction.ts
    bio-entity.ts
  index.ts
```

Pure files under `src/lib/knowledge-governance/core` must not import:

- Drizzle;
- Kinetix schemas;
- React;
- HTTP request types;
- environment variables.

This makes the core portable before the repository becomes a workspace.

### 6.2 Later package structure

After Kinetix cutover and second-domain validation:

```text
packages/
  knowledge-governance-core/
  knowledge-governance-postgres-drizzle/
  knowledge-governance-server/
  knowledge-governance-agent-sdk/
  knowledge-governance-react-review/   # optional
```

The eventual separate repository can preserve these package boundaries.

---

## 7. Core TypeScript contracts

The exact names can evolve, but the following capability boundary should be implemented early and kept small.

### 7.1 Resource reference

```ts
export interface KnowledgeResourceRef {
  namespace: string;       // e.g. "kinetix"
  resourceType: string;    // e.g. "drug_parameter"
  resourceKey: string;     // stable host key
}
```

`resourceKey` must be stable across revisions. For example a Kinetix drug parameter could use `drug:<id>:parameter:<parameterId>` rather than a mutable revision id.

### 7.2 Mutation

```ts
export type MutationKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'reorder'
  | 'replace';

export interface ProposalMutation<TPayload = unknown> {
  kind: MutationKind;
  payload: TPayload;
}
```

Adapters may further constrain which mutation kinds they support.

### 7.3 Risk profile

Do not define one universal numeric risk score.

```ts
export interface RiskProfile {
  tags: readonly string[];
  attributes: Readonly<Record<string, string | number | boolean | null>>;
}
```

Kinetix examples:

```ts
{
  tags: ['calculation_driving'],
  attributes: { highRisk: true }
}

{
  tags: ['human_expert_signoff_required'],
  attributes: { highRisk: true }
}
```

### 7.4 Assessment

```ts
export type AssessmentVerdict = 'approve' | 'dispute' | 'abstain';

export interface AssessmentInput {
  proposalVersionId: string;
  expectedContentHash: string;
  verdict: AssessmentVerdict;
  rationaleMd: string;
  evidence: readonly EvidencePointer[];
  clientModelLabel?: string | null; // audit only, never authorization
}
```

### 7.5 Evidence pointer

The core should not own scientific citation metadata.

```ts
export interface EvidencePointer {
  provider: string;     // e.g. "kinetix.citation"
  externalId: string;   // e.g. citation row id
  locator?: string | null;
  quote?: string | null;
  metadata?: Record<string, unknown>;
}
```

Kinetix resolves the pointer through its citation system.

### 7.6 Domain adapter

```ts
export interface KnowledgeDomainAdapter<
  TProposal = unknown,
  TCurrent = unknown,
> {
  readonly resourceType: string;

  loadCurrent(ref: KnowledgeResourceRef): Promise<TCurrent | null>;

  validateProposal(args: {
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
    actor: ActorContext;
  }): Promise<ValidationResult>;

  computeDiff(args: {
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
  }): Promise<unknown>;

  classifyRisk(args: {
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
    actor: ActorContext;
  }): Promise<RiskProfile>;

  evaluateEvidence(args: {
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
    actor: ActorContext;
  }): Promise<EvidenceState>;

  buildReviewPacket(args: {
    proposalVersionId: string;
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
  }): Promise<ReviewPacket>;

  apply(args: {
    proposalVersionId: string;
    mutation: ProposalMutation<TProposal>;
    current: TCurrent | null;
    decision: ApplyDecision;
    transaction: HostTransaction;
  }): Promise<AppliedRevisionRef>;
}
```

The core orchestrates. The adapter knows the domain.

### 7.7 Adapter requirements

Every adapter must be:

- deterministic for the same authoritative host state;
- server-owned;
- versioned when its risk/evidence semantics materially change;
- testable without invoking an AI model;
- explicit about unsupported operations;
- able to produce a review packet that contains everything necessary for an independent judgment but no peer-verdict leakage.

---

## 8. Persistence model

Add a new set of tables rather than mutating the legacy tables in place. Use a prefix such as `kg_` during migration so ownership is obvious.

Exact column naming should follow repository Drizzle conventions.

### 8.1 `kg_proposals`

Purpose: stable proposal identity and current workflow projection.

Suggested columns:

```text
id uuid/serial PK
namespace varchar
resource_type varchar
resource_key text
mutation_kind varchar
status varchar
created_by_subject text
created_by_kind varchar
current_version_id FK -> kg_proposal_versions
created_at timestamp
updated_at timestamp
closed_at timestamp nullable
legacy_pending_edit_id integer nullable
```

Suggested statuses:

```text
draft
pending
held
approved
applied
returned
rejected
withdrawn
```

The status is a current projection. Transitions must also be written to `kg_audit_events` / decision records.

### 8.2 `kg_proposal_versions`

Purpose: immutable reviewed payload.

```text
id uuid/serial PK
proposal_id FK
version_no integer
base_revision_ref text/jsonb nullable
payload jsonb
metadata jsonb nullable
content_hash varchar
created_by_subject text
created_by_kind varchar
created_at timestamp
supersedes_version_id nullable
adapter_version varchar
```

Constraints:

- unique `(proposal_id, version_no)`;
- unique `(proposal_id, content_hash)` is optional, but no-op duplicate versions should normally be rejected at service level;
- rows are never updated after creation.

### 8.3 `kg_evidence_links`

Purpose: generic references from proposal versions or assessments to host evidence.

```text
id PK
owner_type varchar          # proposal_version | assessment
owner_id
provider varchar
external_id text
locator text nullable
quote text nullable
metadata jsonb nullable
created_at
```

Evidence assets themselves remain host-owned initially.

### 8.4 `kg_assessment_events`

Purpose: immutable verdict history.

```text
id PK
proposal_version_id FK
actor_subject text
actor_kind varchar
verdict varchar
rationale_md text
capability_snapshot jsonb
client_model_label text nullable
created_at
supersedes_assessment_id nullable
```

A changed verdict inserts a new row and points to the previous row. Never overwrite the old row.

Current assessment per `(proposal_version_id, actor_subject)` is the latest non-superseded head. Implement this through a query/helper first; add a materialized/current-head projection only if profiling shows it is needed.

### 8.5 `kg_disputes`

Purpose: stable identity for a dispute.

```text
id PK
proposal_version_id FK
opened_by_subject text
opened_by_kind varchar
source varchar             # agent | human | system
opened_at
```

### 8.6 `kg_dispute_events`

Purpose: immutable dispute lifecycle.

```text
id PK
dispute_id FK
event_type varchar         # opened | amended | withdrawn | upheld | overruled | resolved
reason_md text nullable
evidence jsonb nullable
actor_subject text
actor_kind varchar
created_at
```

Current dispute state is derived from the latest event.

### 8.7 `kg_policy_decisions`

Purpose: reproducible decisions.

```text
id PK
proposal_version_id FK
policy_id varchar
policy_version varchar
policy_hash varchar
outcome varchar
reason_codes jsonb
requirements_snapshot jsonb
risk_snapshot jsonb
evidence_snapshot jsonb
assessment_snapshot jsonb
reviewer_pool_snapshot jsonb nullable
actor_context_snapshot jsonb nullable
created_at
triggered_by_subject text nullable
```

Suggested outcomes:

```text
allow_auto_apply
hold_for_review
return_to_author
reject
escalate
```

A decision record explains *why*. It must not merely store `approved=true`.

### 8.8 `kg_applied_revisions`

Purpose: bridge governance state to authoritative host state.

```text
id PK
proposal_version_id FK
resource_type varchar
resource_key text
host_revision_ref text/jsonb
applied_by_subject text
applied_at
content_hash varchar
```

The adapter returns `host_revision_ref` after applying the proposal.

### 8.9 `kg_audit_events`

Purpose: durable operational timeline for events that are not fully represented by the specialized immutable tables.

Examples:

- proposal created;
- submitted;
- version revised;
- assessment cast;
- assessment superseded;
- dispute opened;
- policy evaluated;
- auto-apply attempted;
- auto-apply held;
- apply succeeded;
- apply conflicted;
- proposal returned/rejected/withdrawn;
- dual-write divergence detected.

Columns should include actor, event type, proposal/version ids, structured metadata, timestamp, and an optional idempotency key.

### 8.10 Indexes

At minimum:

- `kg_proposals(status, updated_at)` for moderation queues;
- `kg_proposals(resource_type, resource_key, status)`;
- `kg_proposal_versions(proposal_id, version_no desc)`;
- `kg_assessment_events(proposal_version_id, actor_subject, created_at desc)`;
- `kg_assessment_events(proposal_version_id, verdict)`;
- `kg_disputes(proposal_version_id)`;
- `kg_dispute_events(dispute_id, created_at desc)`;
- `kg_policy_decisions(proposal_version_id, created_at desc)`;
- `kg_applied_revisions(resource_type, resource_key, applied_at desc)`;
- `kg_audit_events(proposal_id, created_at)`.

Add indexes based on actual queue query plans before cutover, not pre-emptively for hypothetical consumers.

---

## 9. Policy engine

### 9.1 Do not start with a free-form DSL

Version 1 should use typed TypeScript policy definitions and pure requirement combinators. A user-editable rules language adds parsing, privilege, validation, and migration problems before there is evidence it is needed.

### 9.2 Generic requirement vocabulary

Initial requirements should cover:

```ts
independentApprovals(count)
noOpenDisputes()
humanDecisionRequired()
approvalFromActorKind(kind, count)
approvalWithCapability(capability, count)
fullDesignQuorum(count)
selfReviewForbidden()
evidenceRequirement(id)
adapterRequirement(id)
```

Requirements return structured pass/fail results and reason codes.

### 9.3 Example Kinetix policy

Conceptually:

```ts
policy.when(ctx => ctx.author.kind === 'human')
  .require(humanDecisionRequired());

policy.when(ctx => ctx.risk.tags.includes('human_expert_signoff_required'))
  .require(humanDecisionRequired());

policy.when(ctx => ctx.risk.tags.includes('calculation_driving'))
  .require(
    independentApprovals(2),
    fullDesignQuorum(2),
    approvalWithCapability('kinetix.verifier.flagship', 1),
    noOpenDisputes(),
  );

policy.otherwise().require(
  effectiveIndependentApprovalQuorum(),
  noOpenDisputes(),
);
```

The actual Kinetix implementation must preserve current details around self-review, author exclusion, pool size, and human moderation.

### 9.4 Policy outputs

A policy evaluation should return:

```ts
interface PolicyEvaluation {
  outcome:
    | 'allow_auto_apply'
    | 'hold_for_review'
    | 'return_to_author'
    | 'reject'
    | 'escalate';
  satisfied: RequirementResult[];
  unsatisfied: RequirementResult[];
  reasonCodes: string[];
}
```

No UI or route should infer policy from counts independently. One service evaluates and persists the decision.

### 9.5 Policy versioning

Every policy set has:

- stable `policyId`;
- explicit semantic version or monotonically increasing version;
- deterministic hash of the normalized definition/configuration.

Persist the version/hash on every decision.

Changing policy does not silently rewrite historical decisions. Open proposals may be re-evaluated under the new policy through an explicit re-evaluation event.

---

## 10. Assurance profile

Do not make the generic core expose Kinetix's `0 | 1 | 2 | 3` verification level as the canonical state.

Provide a structured summary:

```ts
interface AssuranceProfile {
  currentApprovals: number;
  currentDisputes: number;
  currentAbstentions: number;
  distinctReviewers: number;
  humanApprovals: number;
  agentApprovals: number;
  capabilityCounts: Record<string, number>;
  hasOpenDispute: boolean;
  evidence: EvidenceState;
}
```

Kinetix can continue projecting this to its existing UI level through `src/lib/verificationLevel.ts` or a successor mapper.

This avoids baking one domain's trust labels into every future application.

---

## 11. Review queue architecture

### 11.1 Proposal queue first

The first generic review queue should operate on `kg_proposal_versions`. That is the core path required for governed knowledge mutation.

Reviewing arbitrary live objects such as discussion comments can remain on existing Kinetix machinery until the proposal path is stable.

### 11.2 Queue response

A generic agent queue item should contain:

```ts
interface ReviewQueueItem {
  proposalId: string;
  proposalVersionId: string;
  resource: KnowledgeResourceRef;
  mutationKind: MutationKind;
  contentHash: string;
  createdAt: string;
  author: {
    kind: ActorContext['kind'];
    subject?: string; // may be omitted where blinding warrants it
  };
  reviewPacket: ReviewPacket;
}
```

The `reviewPacket` comes from the adapter.

### 11.3 Queue must exclude

For independent agent review, never include:

- peer assessments;
- approval counts;
- dispute rationales;
- policy outcome inferred from peer approvals;
- "other agents think this is wrong/right" metadata.

A safe priority signal may include server-owned risk tags if those are derived from the content itself and do not reveal another reviewer's conclusion.

### 11.4 Queue fairness

Kinetix already learned that pure oldest-first ordering can starve consequential low-volume target types. Preserve the principle, but make queue priority host-configurable.

Generic queue candidates should expose a host-computed priority class. Kinetix can reserve capacity for:

- high-risk proposals;
- pending proposals eligible for consensus;
- paper-review work if it remains in the generic queue later.

The generic core should not hardcode the current `50% pending_edit / 25% paper_review` fractions.

---

## 12. API surface

During migration, keep existing Kinetix endpoints stable. Add internal services first, then expose generic endpoints when useful.

Potential generic endpoints:

```text
POST   /api/governance/proposals
GET    /api/governance/proposals/:id
POST   /api/governance/proposals/:id/versions
POST   /api/governance/proposals/:id/submit
POST   /api/governance/proposals/:id/withdraw

GET    /api/governance/review-queue
POST   /api/governance/assessments
GET    /api/governance/proposals/:id/assessments

POST   /api/governance/disputes
POST   /api/governance/disputes/:id/events

GET    /api/governance/proposals/:id/history
GET    /api/governance/proposals/:id/assurance
POST   /api/governance/proposals/:id/evaluate
```

### 12.1 Idempotency

All agent write endpoints should accept an idempotency key. This matters because scheduled agents retry after timeouts and network failures.

Store the key and response identity for mutation endpoints so a retry cannot create duplicate proposal versions or duplicate assessment events.

### 12.2 Optimistic concurrency

Assessment submission must require both:

- `proposalVersionId`;
- expected `contentHash`.

Application must re-check that:

- the proposal version is still current;
- the base authoritative revision has not changed incompatibly;
- the latest policy decision still refers to the current version;
- adapter-level conflict checks pass inside the transaction.

Return `409` on stale state.

---

## 13. Kinetix adapter design

Kinetix-specific behavior should be moved behind adapters incrementally.

### 13.1 `drug_parameter`

Responsibilities:

- validate parameter id and value using existing registry/Zod rules;
- load current parameter value;
- resolve references;
- enforce actor-aware reference requirements;
- classify entry-backed/calculation-driving risk;
- produce old/new review packet;
- apply through existing drug parameter revision machinery;
- return the created `drug_parameter_revision` id as the host revision ref.

### 13.2 `parameter_entry`

Responsibilities:

- validate create/update/delete shapes;
- check applicability;
- detect duplicates;
- classify all entry-backed calculation-driving entries as high risk where current policy does;
- preserve model-structure editor/human boundaries;
- lock affected drug/entry and recompute dependent summaries during apply;
- preserve direct-write conflict semantics until direct writes are fully governed.

### 13.3 `wiki_fact`

This should be the first production cutover candidate because it exercises:

- structured content;
- add/replace/remove/reorder operations;
- evidence;
- stale anchors;
- revision creation;
- peer review;

without being calculation-driving.

Responsibilities:

- validate section/field/fact anchors;
- resolve current fact text;
- create review diff;
- enforce reference policy;
- apply fact operation through existing monograph/topic helpers;
- create `wiki_revision` and return its id.

### 13.4 `wiki_section` / `wiki_page`

Move after `wiki_fact`. Whole-page edits have broader conflict surfaces and should not be the first adapter proof.

### 13.5 `paper_review`

Keep Kinetix-specific semantics around `readInFull`, PDF requests, and unverified full-text attestation in the adapter/evidence layer.

### 13.6 `learning_unit`

Preserve the unconditional requirement that its source review satisfies the learning-unit evidence contract.

### 13.7 `clinical_case`

Risk tags must include a host policy marker that makes human expert signoff mandatory. There must be no generic auto-apply escape hatch.

### 13.8 Remaining structured edit types

Migrate after the core paths:

- metabolism;
- receptor targets;
- enzyme interactions;
- bio entities;
- wiki new/page;
- other pending-edit variants still active at cutover time.

---

## 14. Legacy-to-new mapping

| Current component | New responsibility | Migration result |
| --- | --- | --- |
| `pending_edits` | proposal current projection | compatibility projection, then retired for new writes |
| pending `proposedValue` / metadata | proposal version payload | immutable `kg_proposal_versions` |
| review token | stale-version guard | version id + content hash + base revision |
| `agent_verifications` | current verifier state | append-only `kg_assessment_events` |
| `approvals` | soft/human endorsements | assurance input or migrated assessment kind where semantically equivalent |
| `disputes` | contestation | `kg_disputes` + immutable events |
| `verification_log` | operational audit / lessons | `kg_audit_events`; learning extension later |
| `drug_parameter_revisions` | authoritative host revision | remains Kinetix host revision, linked by `kg_applied_revisions` |
| `wiki_revisions` | authoritative host revision | remains Kinetix host revision, linked by `kg_applied_revisions` |
| `src/lib/verificationLevel.ts` | UI projection | remains Kinetix projection over generic assurance |
| `api/agent-verifications-queue.ts` | blind review queue | thin Kinetix facade over generic queue/adapters |
| `api/agent-verifications.ts` | assessment + consensus orchestration | thin facade over generic assessment/decision services |
| `api/pending-edits.ts` | proposal CRUD + moderation | thin facade, then optional deprecation |
| `api/_lib/pending-edits-helpers.ts` | mixed generic + domain apply logic | split between generic services and Kinetix adapters |

---

## 15. Migration strategy

Use four modes per edit type:

```text
legacy   -> only existing system decides/applies
shadow   -> legacy authoritative; new engine mirrors + evaluates; never applies
compare  -> both compute; legacy applies; divergence blocks cutover and alerts
native   -> new engine authoritative; legacy API/table receives compatibility projection if needed
```

A site/admin setting can control mode by resource/edit type during migration. The setting itself must be admin-owned and fail to `legacy` or `shadow` on unknown values, never silently to `native`.

### 15.1 Why per-edit-type rollout

Different Kinetix edit classes have very different consequences. A single global cutover would force the riskiest path to migrate at the speed of the simplest path.

Recommended order:

1. `wiki_fact`;
2. `wiki_section`;
3. low-risk authored metadata / non-calculation parameters;
4. `paper_review` and learning content;
5. drug parameter paths;
6. parameter entries and model-structure axes;
7. whole-page/new-drug and remaining complex edit types;
8. optional non-proposal peer-review targets.

High-risk calculation-driving edits only become `native` after shadow/compare telemetry shows exact parity on the current policy matrix.

---

## 16. Historical migration and backfill

Do **not** manufacture precision the current database does not contain.

The current `agent_verifications` model upserts an actor's verdict and some proposal/revision flows clear old verification state after content changes. Therefore we cannot reconstruct a faithful event-by-event history before the new append-only tables exist.

### 16.1 Migration epoch

Record a clear governance migration epoch timestamp.

Historical content before the epoch remains valid Kinetix history but is marked as `legacy` provenance when surfaced through the generic layer.

### 16.2 Open proposals

At shadow-mode activation:

- import every open `pending_edit` as a `kg_proposal`;
- create one `kg_proposal_version` representing its current payload;
- store `legacy_pending_edit_id`;
- import currently visible verifier state as synthetic `legacy_snapshot` assessments, clearly marked as snapshots rather than original event history;
- import open disputes as current legacy dispute snapshots;
- do not invent timestamps for overwritten verdicts or prior versions.

### 16.3 Existing authoritative revisions

Do not bulk-create fake governance decisions for every historical parameter/wiki revision.

When a generic history endpoint needs lineage for a pre-epoch revision, return a legacy provenance marker such as:

```json
{
  "provenance": "legacy_pre_governance_epoch",
  "hostRevisionRef": "..."
}
```

A later optional backfill can link known legacy revisions without asserting reviews that cannot be proven.

---

## 17. Implementation phases

Each phase below should normally be one or several focused PRs. Do not combine schema, policy semantics, adapter cutover, and cleanup into one change.

### Phase 0 - Freeze current behavior as a contract

**Goal:** make today's governance behavior executable as a specification before moving code.

#### Work

1. Create a behavior matrix covering:
   - human vs agent author;
   - self-review enabled/disabled;
   - 0/1/2 independent agent approvals;
   - mid/flagship/unknown verifier tiers;
   - normal vs degraded active-agent pool;
   - open dispute;
   - dispute upheld/overruled;
   - stale target version;
   - revised pending edit;
   - human-authored edit;
   - clinical case;
   - calculation-driving parameter;
   - model-structure parameter;
   - reference-gate on/off;
   - unread reference;
   - direct-write conflict marker;
   - reviewer concurrency/review token mismatch;
   - agent suspension/tier change after prior assessment.
2. Extend tests around:
   - `consensusApprovalHoldReason`;
   - `effectiveConsensusQuorum`;
   - `isHighRiskPendingEdit`;
   - self-review;
   - dispute blocking;
   - ~~human edit non-auto-apply~~ → human edit held to an agent's bar; unattributed edit non-auto-apply (v2);
   - `applyApprovedEdit` invariants;
   - reference gates;
   - stale review/apply races.
3. Add integration tests that execute representative proposals end-to-end against PGlite/Neon-compatible test infrastructure.
4. Capture expected error codes as contract assertions.

#### Exit criteria

- every safety-significant branch above has at least one test;
- tests fail if high-risk degraded quorum is accidentally allowed;
- tests fail if human proposals can auto-publish through agent consensus;
- tests fail if peer-review responses expose peer verdicts;
- tests fail if stale content can be approved.

#### Rollback

No production behavior changes.

---

### Phase 1 - Pure core and policy primitives

**Goal:** create a domain-neutral, database-free library with no production routing changes.

#### New files

Create `src/lib/knowledge-governance/core/*` with:

- types;
- hashing;
- policy requirement combinators;
- policy evaluator;
- assurance summarizer;
- state transition validation;
- typed errors.

#### Tests

Use table tests and property-based tests (`fast-check` is already available) for:

- policy determinism;
- no open dispute -> possible approval, open dispute -> never auto-apply unless an explicit policy says disputes do not block, which Kinetix policy must never do;
- adding an independent valid approval cannot reduce assurance;
- changing client-reported model label cannot satisfy a server capability requirement;
- unknown capability cannot satisfy a required capability;
- high-risk policy never accepts degraded quorum;
- same inputs always hash/evaluate identically.

#### Exit criteria

- pure core imports no Kinetix/domain modules;
- Kinetix's current consensus examples can be represented and pass in pure tests;
- no route uses the core yet.

---

### Phase 2 - Generic persistence schema

**Goal:** add append-only governance tables with zero authoritative behavior change.

#### Work

1. Add Drizzle schema definitions for all `kg_*` tables.
2. Generate migration.
3. Add migration-statement tests following repo conventions.
4. Implement stores under `api/_lib/knowledge-governance/store/`.
5. Add idempotency support for version/assessment creation.
6. Add content-hash canonicalization tests.

#### Important rule

Migrations only expand. Do not drop or rename legacy governance columns/tables in this phase.

#### Exit criteria

- migration applies cleanly to empty and representative existing schemas;
- stores can round-trip proposals, versions, assessments, disputes, decisions, and applied revision links;
- immutable tables have no ordinary update path.

---

### Phase 3 - Adapter registry and Kinetix actor bridge

**Goal:** establish the dependency inversion.

#### Work

1. Implement `adapter-registry.ts`.
2. Implement `policy-registry.ts`.
3. Implement `actor-bridge.ts` that maps existing auth/user/agent state into `ActorContext`.
4. Snapshot server-owned attributes, including agent model tier and self-review grant.
5. Introduce first adapter: `wiki_fact`.
6. Add adapter contract tests.

#### Exit criteria

- generic core imports no Kinetix adapter;
- registry rejects duplicate/unregistered resource types;
- unknown adapters fail closed;
- `wiki_fact` review packets reproduce information needed by current reviewers without verdict leakage.

---

### Phase 4 - Shadow-write proposal/version pipeline

**Goal:** mirror existing `pending_edits` into generic tables while legacy remains authoritative.

#### Work

1. Add migration mode configuration by edit/resource type.
2. On legacy proposal create/update/submit:
   - write legacy row as today;
   - create/update corresponding `kg_proposal` projection;
   - create a new immutable `kg_proposal_version` when payload fingerprint changes;
   - attach evidence pointers;
   - write audit event.
3. Never let generic failure prevent an otherwise-valid legacy write during early shadow mode unless data corruption would result. Instead log divergence loudly.
4. Add a reconciliation job/script that compares open legacy edits with generic mirrors.

#### Required telemetry

- missing generic mirror;
- content-hash mismatch;
- status mismatch;
- evidence-link mismatch;
- version-count anomalies;
- dual-write exceptions.

#### Exit criteria

- at least one production-like run shows zero unexplained mirror divergence;
- a payload revision creates a new version rather than mutating the old one;
- status-only resubmission does not create a fake content version;
- legacy remains the sole apply authority.

---

### Phase 5 - Shadow assessments and policy decisions

**Goal:** run the new governance decision machinery beside the current verifier/consensus path.

#### Work

1. Mirror new agent verdicts into append-only assessment events.
2. Preserve current `agent_verifications` writes for legacy behavior.
3. Map current server-owned verifier tier into capability snapshots.
4. Mirror agent disputes into `kg_disputes`/events.
5. Evaluate Kinetix policy after every governance-relevant event.
6. Persist `kg_policy_decisions` but do not apply from them.
7. Compare generic policy result to current legacy consensus/hold behavior.

#### Divergence classes

At minimum:

```text
legacy_apply / generic_hold        critical
legacy_hold  / generic_apply       critical
different hold reason              warning -> investigate
assessment count mismatch          critical
capability snapshot mismatch       critical
open-dispute mismatch              critical
```

#### Exit criteria

- no unexplained critical divergence over a representative sample;
- Kinetix high-risk cases reproduce current flagship and full-quorum rules;
- ~~human-authored edits always generic-hold for human decision~~ → unattributed edits always generic-hold for human decision; a person's proposal is held to an agent's bar (v2);
- clinical cases always generic-hold for human expert decision.

---

### Phase 6 - `wiki_fact` compare mode and native cutover

**Goal:** make the first edit class native through the generic engine.

#### Work

1. Route `wiki_fact` proposal lifecycle through `proposal-service` while maintaining legacy `pending_edits` projection.
2. Serve agent review queue item from generic proposal/version records.
3. Accept assessment through generic service, then maintain legacy projection if old UI/API needs it.
4. Run compare mode where:
   - generic evaluator decides;
   - legacy evaluator is run as a shadow oracle;
   - any disagreement prevents automatic application and holds for human review.
5. Once parity is demonstrated, switch `wiki_fact` to native generic application through the adapter.
6. Link resulting `wiki_revision` through `kg_applied_revisions`.

#### Exit criteria

- create/replace/remove/reorder all pass end-to-end;
- stale fact anchors produce the same or safer outcome as today;
- no peer-verdict leakage;
- review UI continues to function;
- rollback to legacy mode is one configuration change and requires no data rewrite.

---

### Phase 7 - Low-risk Kinetix edit types

Move structurally simpler/non-calculation-driving types next.

Candidates:

- `wiki_section`;
- selected authored metadata parameters;
- paper review if adapter behavior is stable;
- learning units.

For each type, repeat:

```text
shadow -> compare -> native
```

No batch cutover merely because adapters share code.

---

### Phase 8 - Calculation-driving parameters

**Goal:** migrate the safety-critical scientific data path only after the generic engine has production evidence.

#### Preconditions

- append-only assessments have been operating reliably;
- capability snapshotting is tested under tier revocation/change races;
- high-risk policy parity is exact;
- open disputes are correctly reflected;
- reviewer-pool size/degraded quorum parity is exact;
- reference gate parity is exact;
- high-risk hold-reason telemetry is stable;
- rollback path has been exercised.

#### Work

1. Implement `drug_parameter` adapter.
2. Shadow current parameter proposals.
3. Compare all policy outcomes.
4. Native cutover first for non-entry-backed parameter writes if they share the route.
5. Only then enable native generic decisions for calculation-driving values.
6. Preserve mandatory flagship capability requirement.
7. Preserve no-degraded-quorum rule.
8. Link created `drug_parameter_revision` rows to generic applied revisions.

#### Extra test requirement

Run randomized policy matrices across combinations of:

- active pool size;
- author identity;
- self-review grant;
- reviewer capabilities;
- verdict sequence;
- dispute state;
- risk state.

Compare legacy and generic result for every generated case.

---

### Phase 9 - Parameter entries and model structure

This comes after ordinary parameter cutover because it combines:

- create/update/delete;
- row-level identity;
- parameter applicability;
- duplicate detection;
- recalculation dependencies;
- direct-write conflicts;
- model-family selection.

Preserve the editor floor around model-structure decisions. Do not let a generic self-review capability accidentally bypass a rule whose purpose is a second party.

Exit requires explicit tests for every current model-structure carve-out.

---

### Phase 10 - Remaining edit types and moderator UI

Migrate remaining active edit types individually.

Update `ReviewPage` and supporting client code to consume a generic review representation while adapters provide domain-specific diff render hints.

Do not require a generic UI component to understand every domain. The reusable UI package should own common elements only:

- actor;
- status;
- evidence list;
- assessment list;
- dispute state;
- policy hold reasons;
- version history;
- approve/return/reject controls.

Kinetix remains responsible for pharmacology-specific value/diff renderers.

---

### Phase 11 - Agent protocol migration

**Goal:** make scheduled agents speak the generic review contract.

#### Work

1. Add a generic agent SDK/helper around:
   - fetch queue;
   - submit assessment;
   - open/withdraw dispute;
   - fetch own history;
   - idempotency/retry handling.
2. Rewrite `agents/peer-verification-protocol.md` into:
   - generic governance protocol;
   - Kinetix-specific evidence/judgment addendum.
3. Keep the independence rule prominent.
4. Ensure agent prompts no longer need to know legacy pending-edit/verifier table semantics.

#### Exit criteria

A new agent identity can participate in Kinetix review using only the generic API contract plus Kinetix domain instructions.

---

### Phase 12 - Learning/feedback extension

After the core is stable, replace the free-text single-ledger implementation with explicit durable lessons.

Potential schema:

```text
kg_lessons
kg_lesson_versions
kg_lesson_triggers
kg_lesson_outcomes
```

Requirements:

- versioned lessons;
- provenance back to rejection/dispute/assessment events;
- explicit scope;
- activation/deactivation;
- measurable effect where possible;
- no automatic promotion of an AI-derived lesson into hard policy without host-defined review.

This phase is intentionally separate from the initial extraction.

---

### Phase 13 - Second-domain validation

Before extracting to a separate repository, implement one genuinely non-pharmacology adapter set.

The pilot must use the same core for at least:

- create/update proposals;
- versioning;
- evidence links;
- independent assessment;
- dispute;
- risk-sensitive policy;
- application;
- history.

The second domain should have at least one rule that Kinetix does **not** have, for example:

- require a reviewer with a legal/expert credential;
- require cross-organization independence;
- require one deterministic machine check plus one human approval;
- use a different evidence provider entirely.

Any core concept that only Kinetix needs should be pushed back into the Kinetix adapter at this stage.

Exit criterion:

> The second application can be implemented without importing or branching on Kinetix modules and without modifying the generic core for domain vocabulary.

---

### Phase 14 - Extract packages to a separate repository

Only after the second-domain test passes:

1. move `src/lib/knowledge-governance/core` to `knowledge-governance-core`;
2. move Drizzle stores/schema helpers to `knowledge-governance-postgres-drizzle`;
3. move orchestration/API-neutral services to `knowledge-governance-server`;
4. move agent client/helper to `knowledge-governance-agent-sdk`;
5. optionally extract generic React review components;
6. publish/version privately or consume through git/package registry according to deployment needs;
7. replace Kinetix internal imports with package imports;
8. keep `api/_lib/kinetix-governance/*` in Kinetix.

Do not move host authentication, Kinetix policy, or Kinetix adapters.

---

## 18. Concrete PR sequence

A practical sequence, subject to splitting when a PR becomes too broad:

### PR 1 - Governance behavior contract

- expand current verifier/consensus/dispute/reference tests;
- add behavior matrix doc/test helper;
- no production changes.

### PR 2 - Pure governance core

- core types;
- policy evaluator;
- assurance summary;
- property tests.

### PR 3 - Governance schema

- additive `kg_*` tables;
- migration;
- store tests.

### PR 4 - Actor bridge + adapter registry

- host actor mapping;
- registry;
- no route cutover.

### PR 5 - `wiki_fact` adapter

- validation/diff/risk/evidence/review packet/apply adapter;
- adapter contract tests.

### PR 6 - Shadow proposal dual-write

- pending edit -> generic proposal/version mirror;
- reconciliation script;
- divergence telemetry.

### PR 7 - Shadow assessment + policy dual-write

- immutable assessment events;
- dispute events;
- policy decision comparison.

### PR 8 - Generic review queue

- proposal-version queue;
- Kinetix facade;
- blinded response tests.

### PR 9 - `wiki_fact` compare/native cutover

- feature mode;
- generic apply;
- compatibility projection.

### PR 10 - Remaining low-risk adapters

- one or more focused PRs, not one mega-PR.

### PR 11 - Drug parameter adapter + shadow parity

- no native high-risk application yet.

### PR 12 - Drug parameter native cutover

- only after parity gate.

### PR 13 - Parameter-entry/model-structure migration

- separate due to risk and complexity.

### PR 14 - Moderator UI genericization

- shared governance components + Kinetix renderers.

### PR 15 - Agent SDK/protocol

- generic agent review contract.

### PR 16+ - Remaining adapters, cleanup, learning extension

### Final extraction PRs

- separate repo/packages only after second-domain proof.

---

## 19. Test strategy

### 19.1 Pure unit tests

For:

- state transitions;
- hashing;
- current-head assessment selection;
- assurance summaries;
- policy requirements;
- policy composition;
- risk-policy matching;
- reason-code output.

### 19.2 Property-based tests

Use `fast-check` for invariants such as:

- a dispute cannot accidentally improve auto-apply eligibility;
- adding a valid independent approval cannot lower approval assurance;
- a client model-label change cannot affect capability-gated policy;
- unknown/NULL capability never satisfies a required capability;
- policy evaluation is deterministic;
- content hash changes when policy-relevant payload changes;
- status-only operations do not create content versions;
- a new proposal version never inherits assessments as current assessments.

### 19.3 Persistence tests

Verify:

- append-only tables are never updated by stores;
- supersession queries select the correct current assessment;
- duplicate idempotency keys are safe;
- concurrent version creation cannot reuse version numbers;
- decision/audit records are transactionally linked where required.

### 19.4 Adapter contract suite

Create a reusable adapter test harness asserting every adapter:

- validates supported operations;
- rejects unsupported operations;
- generates stable risk classifications;
- produces a review packet;
- does not expose peer-verdict state;
- fails safely on stale/missing current state;
- applies atomically;
- returns an authoritative host revision reference.

### 19.5 Legacy parity tests

During migration, every legacy policy scenario should be run through both evaluators.

High-risk cutover requires zero unexplained mismatches.

### 19.6 Race tests

Explicitly test:

1. submitter revises while reviewer is assessing;
2. reviewer posts verdict against old hash;
3. another proposal applies to same resource before apply;
4. admin revokes verifier tier while verdict request is in flight;
5. self-review is revoked while a self-verdict is in flight;
6. dispute opens between final approval and apply;
7. policy changes while proposal remains pending;
8. adapter version changes while proposal remains pending.

Expected safe default: stale/changed state produces a hold or `409`, never an apply based on obsolete assumptions.

### 19.7 End-to-end tests

At least:

```text
agent proposal -> two peer approvals -> auto apply
agent high-risk proposal -> two mid approvals -> hold
agent high-risk proposal -> mid + flagship -> apply
high-risk degraded pool -> flagship single approval -> hold
human proposal -> many agent approvals -> hold for human
proposal -> dispute -> approvals -> hold
proposal -> dispute overruled -> policy re-evaluate
clinical case -> agent quorum -> hold for human expert
proposal v1 approved -> author creates v2 -> v1 approvals do not count for v2
```

---

## 20. Security and scientific-integrity controls

### 20.1 Never trust client-supplied capability

Model name, effort, role, expert status, organization, and self-review grant are audit metadata at most unless resolved server-side.

### 20.2 Snapshot capability at decision time

Preserve the current Kinetix insight: a live mutable agent row is not sufficient for historical assurance. Store the capability that actually cast the assessment.

### 20.3 Separation of duties

Policies must be able to express:

- author cannot be sole reviewer;
- self-review does not satisfy independent-review counts unless explicitly designed to do so;
- some content always needs another party even when self-review is enabled;
- some content always needs a human;
- some human decisions require a specific capability.

### 20.4 Evidence is untrusted input

URLs, PDFs, citation text, discussion content, and external pages may contain prompt injection or malicious text. Generic agent protocols must state that evidence is data, not operational instruction.

### 20.5 Apply is transactional

Policy passing is necessary but not sufficient. The adapter must revalidate current host state in the same transaction or locking boundary used to apply the mutation.

### 20.6 Audit cannot be optional

A production apply without:

- proposal version;
- content hash;
- decision record;
- actor;
- policy version;
- host revision ref

is an integrity error and should fail closed.

---

## 21. Observability

Add structured logs and metrics before native cutover.

### 21.1 Core counters

```text
kg_proposals_created_total{resource_type,actor_kind}
kg_proposal_versions_total{resource_type}
kg_assessments_total{verdict,actor_kind,capability_tier}
kg_disputes_opened_total{resource_type}
kg_policy_decisions_total{outcome,reason_code,resource_type}
kg_auto_apply_total{resource_type}
kg_apply_hold_total{reason_code,resource_type}
kg_apply_conflict_total{resource_type}
kg_stale_assessment_total{resource_type}
kg_dual_write_divergence_total{class,resource_type}
```

### 21.2 Gauges

```text
kg_pending_queue_depth{resource_type,risk_class}
kg_open_disputes{resource_type}
kg_shadow_divergences{resource_type}
```

### 21.3 Durations

```text
proposal_created -> first_review
proposal_submitted -> decision
proposal_submitted -> applied
open_dispute -> resolution
```

### 21.4 Operator-facing hold reasons

Every non-apply result should have a stable reason code, for example:

```text
quorum_unmet
open_dispute
high_risk_full_quorum_required
required_capability_missing
human_decision_required
expert_human_required
stale_version
base_revision_conflict
evidence_requirement_unmet
adapter_validation_failed
policy_error
```

Do not bury these only in prose logs.

---

## 22. Performance considerations

The first objective is correctness, but the architecture should avoid obvious scaling traps.

### 22.1 Batch queue hydration

Adapters should provide batched hydration where queue volume warrants it. Do not replace the current optimized Kinetix queue with an N+1 generic abstraction.

The adapter contract may therefore gain optional methods such as:

```ts
buildReviewPacketsBatch(ids: string[]): Promise<Map<string, ReviewPacket>>
```

### 22.2 Policy inputs should be summarized once

For a proposal version, load current assessments/disputes/evidence in batched queries and pass a normalized state to the pure policy evaluator.

### 22.3 Avoid synchronous historical replay on hot writes

A new assessment should evaluate the current version using current-head projections. Full event history is for audit, not required for every policy calculation.

### 22.4 Projection tables only when demonstrated necessary

Start with append-only events plus indexed latest-event queries. If profiling shows current-head resolution is expensive, add explicit projection tables maintained transactionally. Do not sacrifice history to optimize prematurely.

---

## 23. Compatibility and rollback

### 23.1 Compatibility facade

Existing Kinetix API clients should not need simultaneous rewrites.

During migration:

- `src/lib/pendingEditsApi.ts` keeps its public shape;
- `/api/pending-edits` can call generic services internally;
- legacy table rows may remain as projections;
- `/api/agent-verifications*` can proxy generic assessments/queue while preserving response compatibility.

### 23.2 Rollback rule

For every edit type until legacy retirement:

> `native -> legacy` must be a configuration change, not a data migration.

Generic records remain append-only and can be retained after rollback. Legacy projection must contain enough state to resume moderation.

### 23.3 No destructive cleanup during rollout

Do not drop:

- `pending_edits`;
- `agent_verifications`;
- current dispute columns/tables;
- current revision links

until all relevant edit types have run native for an agreed stabilization window and no rollback has been required.

---

## 24. Data-retirement plan

Cleanup is a separate project phase after native adoption.

For each legacy table/column:

1. prove no production reader;
2. prove no production writer;
3. keep compatibility view if older clients still exist;
4. export/archive if audit value remains;
5. only then migrate/drop.

Because historical verification data is scientifically and operationally useful, prefer archival over deletion where storage cost is negligible.

---

## 25. Documentation changes required during implementation

Create/update:

```text
docs/knowledge-governance/architecture.md
docs/knowledge-governance/policy-model.md
docs/knowledge-governance/adapter-contract.md
docs/knowledge-governance/persistence.md
docs/knowledge-governance/migration-runbook.md
docs/knowledge-governance/agent-review-protocol.md
```

Existing docs to revise as phases land:

- `agents/peer-verification-protocol.md`
- `agents/adding-a-new-agent.md`
- `agents/cross-agent-learning-protocol.md`
- `docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md`
- relevant sections of `AGENTS.md`

Documentation should clearly mark whether a described rule is:

- generic engine invariant;
- Kinetix policy;
- adapter-specific behavior;
- agent operational guidance.

That distinction is one of the main purposes of the extraction.

---

## 26. Recommended decisions on likely design questions

### 26.1 UUID vs integer IDs

**Recommendation:** use UUIDs for externally exposed generic governance identities if convenient with the current stack; integer PKs are also acceptable inside Kinetix. Do not let ID format block the extraction. Stability and opaque cross-project identity matter more than the specific representation.

### 26.2 Store payloads as JSONB?

**Recommendation:** yes for generic proposal versions, with adapters owning schema validation. The alternative is a generic engine schema that changes for every host domain, which defeats the purpose.

### 26.3 Store authoritative resource contents in the engine?

**Recommendation:** no initially. The host remains system of record for domain state. Governance stores the proposal and lineage, then links to host revisions.

### 26.4 Make risk a scalar score?

**Recommendation:** no. Use typed tags/attributes. Consequence classes are not reliably reducible to one universal number.

### 26.5 Make verification a scalar score?

**Recommendation:** no. Store structured assurance and let hosts project labels.

### 26.6 Allow runtime-editable policies immediately?

**Recommendation:** no. Start with versioned code/config definitions. Runtime editing can be added once privilege boundaries and real use cases are understood.

### 26.7 Generic evidence repository?

**Recommendation:** not in v1. Use evidence pointers/providers. Kinetix citations remain Kinetix-owned.

### 26.8 Generic auth?

**Recommendation:** no. Accept a trusted host-created `ActorContext`.

### 26.9 Generic UI?

**Recommendation:** extract common review primitives only after at least two domains show which components are truly common.

### 26.10 Separate repository now?

**Recommendation:** no. First make the boundary real inside Kinetix, then prove it with another domain, then extract.

---

## 27. Major risks and mitigations

### Risk 1: accidental semantic weakening during abstraction

A generic API can look cleaner while quietly losing a Kinetix carve-out.

**Mitigation:** Phase 0 contract matrix, shadow evaluator, compare mode, high-risk migration last.

### Risk 2: hidden coupling in `pending-edits-helpers`

The current apply helper combines generic workflow and many Kinetix invariants.

**Mitigation:** split one adapter at a time. Never replace the whole helper in one PR.

### Risk 3: generic core becomes "Kinetix with renamed nouns"

**Mitigation:** no Kinetix identifiers in core, plus mandatory second-domain validation before external extraction.

### Risk 4: append-only model complicates current-state queries

**Mitigation:** indexed latest-event queries first; add current-head projections if measured necessary.

### Risk 5: dual-write divergence

**Mitigation:** reconciliation script, structured divergence classes, compare mode, rollback switch.

### Risk 6: reviewers influence one another

**Mitigation:** preserve blind queue structurally; separate peer-review and moderator/adjudication endpoints.

### Risk 7: capability spoofing

**Mitigation:** host-resolved server-owned `ActorContext`; snapshot capability on assessment; never trust model strings from request body.

### Risk 8: policy changes invalidate pending work

**Mitigation:** explicit policy versions and re-evaluation events. Never silently reinterpret a historical decision.

### Risk 9: second domain forces large redesign

This is expected to some degree and is precisely why extraction waits.

**Mitigation:** keep core small; treat second-domain friction as abstraction feedback rather than adding host-specific exceptions.

---

## 28. Milestones

### Milestone A - Behavior locked

- contract matrix complete;
- safety-critical legacy tests comprehensive.

### Milestone B - Generic core exists

- pure policy/types/assurance package in repo;
- no production behavior change.

### Milestone C - Append-only governance ledger exists

- new schema/stores deployed;
- shadow mirrors functioning.

### Milestone D - New evaluator proven

- assessments/disputes/policy decisions mirrored;
- zero unexplained critical parity divergence.

### Milestone E - First native adapter

- `wiki_fact` uses generic governance end-to-end;
- rollback tested.

### Milestone F - Scientific high-risk path native

- calculation-driving parameters pass through generic engine;
- flagship/full-quorum safeguards preserved.

### Milestone G - Kinetix governance fully adapterized

- active edit types use generic engine;
- legacy API is a compatibility facade only.

### Milestone H - Second-domain proof

- non-pharmacology application successfully uses same core.

### Milestone I - External extraction

- reusable packages moved to separate repository/package distribution;
- Kinetix imports them as a consumer.

---

## 29. Definition of done

The project is complete when all of the following are true:

1. No generic governance module contains pharmacology-specific branching.
2. Every new Kinetix knowledge proposal creates an immutable generic proposal version.
3. Every new peer assessment is append-only and version-bound.
4. Changed verdicts remain historically visible rather than overwritten.
5. Every dispute has durable event history.
6. Every automatic application has a persisted policy decision explaining why it was allowed.
7. Every authoritative revision created through governance links back to its proposal version and decision.
8. Human-authored content cannot be auto-published by agent consensus unless Kinetix deliberately changes that policy in a separately reviewed change. **Kinetix made that change in `kinetix-consensus@v2` / `kinetix-consensus-apply@v3`:** a person's proposal publishes on agent consensus under the same bar as an agent's, and only an unattributed proposal still needs a person.
9. Clinical cases cannot auto-publish without required human expert review.
10. Calculation-driving parameter edits cannot auto-publish under degraded quorum and require the configured flagship/high-assurance verifier capability.
11. Client-reported model names cannot influence authorization or high-risk capability gates.
12. Peer reviewers remain blinded to other peer verdicts before assessment.
13. Stale proposal versions cannot be assessed/applied as current.
14. Kinetix can roll an edit type back to legacy governance during the migration window without database repair.
15. A second non-pharmacology domain uses the core without changes that introduce its domain vocabulary into the core.
16. The reusable core/server/storage/agent components are extractable into a separate repository without moving Kinetix authentication, pharmacology schema, or domain policies.

---

## 30. Immediate next actions

The next implementation work should be deliberately narrow:

1. **Land Phase 0 tests first.** Do not start by moving production code.
2. Add a machine-readable/table-driven legacy behavior matrix for consensus and moderation outcomes.
3. Expand integration coverage around human edits, clinical cases, high-risk parameters, disputes, self-review, stale versions, and reference gates.
4. Create `src/lib/knowledge-governance/core/` with only pure types and policy evaluation.
5. Express the existing Kinetix consensus policy against that pure API and prove parity in tests.
6. Only then add the `kg_*` schema and begin shadow persistence.

The first code change should therefore make the current safety boundary harder to accidentally change, not begin the abstraction itself. Once that boundary is executable, the rest of the extraction can proceed incrementally without asking reviewers to remember every exception by hand.
