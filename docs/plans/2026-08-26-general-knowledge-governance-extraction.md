# General Knowledge Governance Extraction Plan

**Status:** implementation plan  
**Date:** 2026-08-26  
**Scope:** extract Kinetix's human/AI contribution, verification, dispute, policy, publication, and audit mechanics into a reusable domain-independent knowledge-governance system without interrupting Kinetix  
**Primary constraint:** Kinetix must remain fully functional and scientifically safe throughout the migration

## 0. Executive summary

Kinetix already contains the core of a reusable knowledge-governance system. The existing implementation supports human and agent contributors, tiered capabilities, queued edits, evidence-linked proposals, independent peer verification, disputes, human moderation, risk-sensitive consensus rules, agent capability tiers, stale-target protection, revisions, audit logging, and feedback from rejected work.

The goal is to extract those mechanisms into a domain-independent system that can govern knowledge in other projects while preserving Kinetix as the first production implementation.

This must **not** be implemented as a rewrite and must **not** begin by moving code into a separate repository. The safe path is a strangler migration:

1. freeze current Kinetix behaviour in contract tests;
2. introduce a generic governance core inside the existing Kinetix repository;
3. adapt the existing Kinetix target types to that core while leaving the existing database and endpoints authoritative;
4. add a new append-only generic persistence model in shadow mode;
5. compare old and new behaviour continuously in production;
6. cut over one low-risk knowledge-object type at a time;
7. leave calculation-driving parameters and other high-risk content on the legacy path until the generic implementation has extensive parity evidence;
8. only after Kinetix is running safely on the generic core, validate the abstractions with a second unrelated domain;
9. only then extract the stable core to a separate reusable repository/package;
10. keep Kinetix-specific adapters, scientific policies, UI, and domain apply logic in Kinetix.

The system should be thought of as a **knowledge governance engine**, not an agent framework. Agents are one class of actor. Humans, services, deterministic validators, and future automated reviewers must all fit the same model.

The target architecture separates six concerns that are currently partially entangled:

- **identity and authority:** who may perform an action;
- **proposal lifecycle:** what change is being suggested and which immutable version is under review;
- **evidence:** what sources or artifacts support the proposal or assessment;
- **assessment:** who independently approves, disputes, or abstains and why;
- **policy:** what combination of risk, actor type, capability, evidence, and assessments is sufficient to publish;
- **domain application:** how an approved change is actually written into the host application's knowledge model.

Kinetix must continue to work at every intermediate commit and deploy. The existing Kinetix paths remain authoritative until each replacement has demonstrated behavioural parity. All schema changes are additive first. All cutovers are per target type, reversible, and protected by a hard force-legacy kill switch.

---

## 1. Non-negotiable invariants

These rules govern the entire implementation. A phase that cannot satisfy them does not ship.

### 1.1 Kinetix continuity invariant

At every production deploy:

- existing Kinetix public pages continue to load;
- existing Kinetix APIs continue to accept the same request shapes and return compatible responses;
- human contribution continues to work;
- agent contribution continues to work;
- the moderator review queue continues to work;
- peer verification continues to work;
- existing pending edits remain reviewable and appliable;
- existing verification levels and dispute indicators remain available to the UI;
- no migration requires downtime;
- no deployment requires all old and new application instances to switch atomically;
- a generic-governance failure cannot silently publish content that the legacy path would have held;
- high-risk content never receives a weaker publication gate during migration.

### 1.2 Expand-before-contract database rule

No table, column, index, enum-like value, endpoint, or behaviour used by the currently deployed Kinetix build is removed or made incompatible until a later release has been running without using it.

The sequence is always:

1. add;
2. deploy readers/writers that understand both representations;
3. shadow and compare;
4. switch reads/writes gradually;
5. observe;
6. stop writing the legacy representation;
7. observe again;
8. only then remove legacy code/schema in a separate cleanup release.

Because Kinetix applies migrations before the rest of the build completes, destructive migrations are especially dangerous. The extraction phases therefore use additive migrations only until the final legacy-retirement stage.

### 1.3 Legacy-authoritative-until-proven rule

During the first half of the migration, the existing Kinetix implementation remains the source of truth.

The generic system may:

- compute shadow decisions;
- mirror immutable records;
- build a shadow queue;
- calculate assurance state;
- emit parity metrics;

but it does not determine what becomes live until a target type explicitly passes its cutover gate.

### 1.4 Per-target-type cutover

There is no global switch from "old governance" to "new governance".

Migration state is tracked separately for each knowledge-object type. Example:

```text
paper_review         -> generic_authoritative
wiki_fact            -> generic_read
wiki_section         -> shadow
bio_entity           -> legacy_only
parameter            -> legacy_only
param_entry          -> legacy_only
clinical_case        -> legacy_only
```

A failure in one class therefore does not require rolling back the entire migration.

### 1.5 Hard force-legacy kill switch

The application must have an environment-level override such as:

```text
KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1
```

When enabled, all eligible Kinetix request paths use the existing legacy behaviour regardless of the database migration-state configuration.

This must work without a schema change and should require only an application redeploy or environment toggle.

For faster operational rollback, also maintain per-target runtime migration state in the database, editable only by administrators.

### 1.6 Fail-safe direction

Whenever the generic engine cannot establish that publication requirements are met, the result is **hold for human review**, never auto-publish.

Unknown capability, unknown policy version, missing evidence state, incomplete migration linkage, inconsistent mirror state, or internal comparison failure all fail in the conservative direction.

### 1.7 No weaker Kinetix policy during migration

The generic engine may reproduce or tighten Kinetix's current requirements. It must not silently relax them.

In particular preserve these current semantics:

- ~~human-authored pending edits may be peer-reviewed by agents but are never auto-applied solely by agent consensus~~ (retired by `kinetix-consensus@v2` / `kinetix-consensus-apply@v3`: a person's proposal now publishes on agent consensus under the same bar as an agent's; only an unattributed proposal still needs a person);
- clinical cases require human expert review;
- open disputes prevent consensus auto-application;
- self-review remains an explicit administrator grant, not an agent assertion;
- verifier capability tier is server-owned and snapshotted when the assessment is made;
- high-risk calculation-driving edits require the full design-target quorum and at least one flagship-tier verifier;
- stale review targets cannot be approved using an assessment made against an older payload;
- verification independence is protected by withholding other reviewers' judgments from an actor before that actor submits its own assessment.

### 1.8 No new runtime network dependency for Kinetix

The reusable core must initially be an **embedded library**, not a separate network service.

Kinetix must not become dependent on another service being reachable in order to publish, review, or read its knowledge base. A future hosted governance service can be explored separately, but the extraction described here keeps policy evaluation and persistence local to the Kinetix process/database.

---

## 2. Current Kinetix architecture to preserve

The extraction should be grounded in the existing implementation rather than designing a new abstract system in isolation.

### 2.1 Existing proposal workflow

Primary anchors:

- `db/schema.ts` - `pending_edits`, revisions, approvals, agents, verifications, disputes, verification log;
- `api/pending-edits.ts` - submission, moderation, self-review restrictions, concurrency protection;
- `api/_lib/pending-edits-helpers.ts` - validation and application of accepted edits;
- `src/lib/pendingEditsApi.ts` - UI/API contract consumed by the review surface;
- `src/pages/ReviewPage.tsx` - moderator workflow.

`pending_edits` currently acts as a polymorphic proposal table whose `edit_type`, `target_id`, `parameter`, `proposed_value`, `proposed_meta`, reference fields, fact anchors, status, submitter, reviewer, and timestamps describe the proposed mutation.

This model is useful, but the future core should distinguish the stable proposal identity from immutable proposal versions.

### 2.2 Existing verification and assurance model

Primary anchors:

- `api/agent-verifications.ts`;
- `api/agent-verifications-queue.ts`;
- `api/_lib/agent-verifications.ts`;
- `api/_lib/verification-levels.ts`;
- `src/lib/verificationLevel.ts`;
- `agents/peer-verification-protocol.md`.

Important existing concepts:

- explicit `approve | dispute | abstain` verdicts;
- rationale and evidence references;
- independent review queue;
- self-verification prohibition by default;
- optional trusted self-review;
- target version checking;
- implicit submitter approval;
- server-owned model tier snapshot;
- quorum calculation;
- dispute-aware consensus;
- high-risk flagship requirement;
- verification-level projection for the UI.

These concepts should be generalized, not discarded.

### 2.3 Existing capability model

Primary anchors:

- `src/lib/roles.ts`;
- `src/lib/permissions.ts`;
- `api/_lib/permissions-store.ts`;
- permission override/admin UI.

The key design principle to retain is that **authority and assurance are separate**.

A user or agent's capability answers whether they are allowed to perform an action. Verification state answers how much independent support a knowledge claim has accumulated. Neither should be collapsed into a single trust score.

### 2.4 Existing evidence gate

Primary anchors:

- `citations` and paper review tables in `db/schema.ts`;
- `assertReferencesJudged` and `assertReferencesJudgedForActor` in `api/_lib/pending-edits-helpers.ts`;
- paper review and PDF request APIs;
- full-text review workflow.

The generic system needs an extensible evidence model, but Kinetix's rule that certain agent-authored scientific claims require judged references is a **Kinetix policy adapter**, not a universal core rule.

### 2.5 Existing dispute model

Primary anchors:

- unified `disputes` table and helpers;
- `POST /api/disputes` / resolution route;
- agent-verdict-to-dispute bridge;
- upheld/overruled semantics;
- stale-payload handling.

Disputes should remain orthogonal to positive verification. A claim can be highly corroborated and still contested.

### 2.6 Existing cross-agent learning

Primary anchors:

- `agents/cross-agent-learning-protocol.md`;
- rejection reason taxonomy;
- `verification_log`;
- rejection scan helpers.

This is useful but should **not** be part of the first extraction boundary. Proposal/version/assessment/policy/audit are foundational. Learning from historical outcomes should become a later optional extension.

---

## 3. The extraction seam

The current implementation contains generic governance ideas inside Kinetix-specific switch statements and persistence logic.

The main seam is the distinction between:

### Generic governance concerns

- actor identity reference and actor kind;
- capability claims;
- proposal lifecycle;
- immutable proposal versions;
- review eligibility;
- independent assessment;
- evidence attachment;
- risk labels;
- policy requirements;
- consensus evaluation;
- dispute lifecycle;
- assurance summaries;
- audit history;
- queue prioritization primitives;
- stale-version protection;
- migration/compatibility controls.

### Kinetix domain concerns

- what a `halfLife` value looks like;
- how a drug parameter is validated;
- what counts as entry-backed/calculation-driving;
- how a wiki fact is located in TipTap content;
- how a parameter entry is applied and summaries recomputed;
- how metabolism, receptor, enzyme, and bio-entity writes work;
- what constitutes an acceptable scientific citation;
- whether a reference has been read in full;
- pharmacology-specific risk rules;
- clinical-case expert-signoff requirements;
- Kinetix-specific role/capability names;
- how current React review cards render each edit.

The generic layer must depend on interfaces implemented by Kinetix, not import Kinetix domain modules directly.

---

## 4. Target architecture

### 4.1 Logical architecture

```text
Kinetix HTTP/UI/agents
        |
        v
Kinetix compatibility facade
        |
        +------------------------------+
        |                              |
        v                              v
Generic governance core          Kinetix target adapters
        |                              |
        |                              +-- drug_parameter
        |                              +-- parameter_entry
        |                              +-- wiki_fact
        |                              +-- wiki_section
        |                              +-- paper_review
        |                              +-- bio_entity
        |                              +-- clinical_case
        |                              +-- ...
        |
        v
Governance persistence interface
        |
        v
Kinetix Postgres/Drizzle adapter
        |
        +-- append-only governance tables
        +-- compatibility links to legacy tables
        |
        v
Kinetix existing domain apply functions
        |
        v
Existing Kinetix live tables + revisions
```

### 4.2 Core does not own authentication

The host application authenticates the caller and supplies an actor context.

Example:

```ts
export interface ActorContext {
  actorRef: string;
  kind: 'human' | 'agent' | 'service' | 'system';
  capabilities: readonly string[];
  assuranceCapabilities?: readonly string[];
  metadata?: Record<string, unknown>;
}
```

For Kinetix:

- `actorRef` can be `user:<users.id>`;
- `kind` is derived server-side from whether the user is an active registered agent;
- capabilities come from the existing permission matrix;
- assurance capabilities include server-owned properties such as `model_tier=flagship`;
- self-reported model strings remain audit metadata only.

### 4.3 Knowledge-space concept

Add a lightweight `space` abstraction so the same persistence implementation can host different governed knowledge collections.

Kinetix gets one space, for example:

```text
slug = kinetix
```

A future project can create another space with different adapters and policies.

Do not build full SaaS multi-tenancy now. The space exists to prevent domain assumptions from leaking into primary keys and policy configuration.

### 4.4 Target adapters

The key abstraction is a host-owned adapter per knowledge-object type.

Suggested interface:

```ts
export interface KnowledgeTargetAdapter<TProposal = unknown, TCurrent = unknown> {
  readonly type: string;

  loadCurrent(target: TargetRef): Promise<TCurrent>;

  validateProposal(args: {
    proposal: TProposal;
    current: TCurrent;
    actor: ActorContext;
  }): Promise<ValidationResult>;

  fingerprint(args: {
    proposal: TProposal;
    current: TCurrent;
  }): Promise<string> | string;

  buildReviewPacket(args: {
    version: ProposalVersion;
    actor: ActorContext;
  }): Promise<ReviewPacket>;

  classifyRisk(args: {
    version: ProposalVersion;
    current: TCurrent;
  }): Promise<RiskProfile>;

  evidenceRequirements(args: {
    version: ProposalVersion;
    actor: ActorContext;
    risk: RiskProfile;
  }): Promise<readonly EvidenceRequirement[]>;

  apply(args: {
    version: ProposalVersion;
    decision: PublicationDecision;
    actor: ActorContext;
    tx: GovernanceTransaction;
  }): Promise<AppliedRevisionRef>;
}
```

Important rule: `apply()` stays in the host adapter. The generic core never learns how to update a drug parameter or mutate TipTap content.

### 4.5 Adapter registry

Create a registry:

```ts
registerKnowledgeTargetAdapter(adapter)
getKnowledgeTargetAdapter(type)
```

The review queue, proposal service, and policy engine deal with registered target types instead of `switch (targetType)` blocks.

During migration, adapters may internally delegate to existing Kinetix functions. That is desirable. Reuse the proven implementation before replacing it.

---

## 5. Generic persistence model

The new persistence model should be append-oriented and version-aware. Do not attempt a pure event-sourced rewrite of Kinetix. Keep normal relational projections for efficient reads, but make factual review history immutable.

Use a distinctive prefix during migration, such as `kg_`, so the new tables are easy to identify and impossible to confuse with existing Kinetix tables.

### 5.1 `kg_spaces`

Purpose: identifies a governed knowledge space and active policy set.

Suggested fields:

- `id`;
- `slug` unique;
- `name`;
- `active_policy_version`;
- `created_at`;
- `updated_at`.

### 5.2 `kg_targets`

Purpose: stable generic reference to a host-domain object.

Suggested fields:

- `id` UUID/serial;
- `space_id`;
- `target_type`;
- `target_key` string;
- `created_at`;
- optional `metadata` JSONB.

Unique key:

```text
(space_id, target_type, target_key)
```

`target_key` is opaque to the core. Examples:

```text
drug:123:param:halfLife
wiki-page:991:fact:019...
paper-review:citation:8821
```

Do not require integer domain IDs in the core.

### 5.3 `kg_proposals`

Purpose: stable identity of a proposed mutation across revisions.

Suggested fields:

- `id`;
- `space_id`;
- `target_id`;
- `author_actor_ref`;
- `author_kind`;
- `state` as a materialized current-state projection;
- `current_version_id`;
- `created_at`;
- `closed_at` nullable;
- `legacy_pending_edit_id` nullable during migration.

Possible projection states:

```text
draft
pending
held
applied
returned
rejected
withdrawn
superseded
```

The row is a convenient projection. The immutable history lives in version and decision tables.

### 5.4 `kg_proposal_versions`

Purpose: immutable content snapshot that reviewers actually judge.

Suggested fields:

- `id`;
- `proposal_id`;
- `version_no`;
- `base_revision_ref` nullable;
- `payload` JSONB;
- `payload_fingerprint`;
- `author_actor_ref`;
- `actor_kind`;
- `risk_profile` JSONB snapshot;
- `created_at`;
- `submitted_at` nullable;
- optional `legacy_review_token` during migration.

Unique:

```text
(proposal_id, version_no)
```

A payload edit creates a new row. Never overwrite a version that was visible to a reviewer.

### 5.5 `kg_evidence_items`

Purpose: reusable evidence object independent of Kinetix's citation schema.

Suggested fields:

- `id`;
- `space_id`;
- `kind`;
- `external_ref` nullable;
- `locator` JSONB;
- `metadata` JSONB;
- `content_hash` nullable;
- `created_at`.

Examples of `kind`:

```text
scientific_paper
web_page
document
dataset
code_test
expert_statement
regulatory_document
internal_record
```

Kinetix initially maps `citations.id` into evidence through a compatibility link rather than copying every citation field.

### 5.6 `kg_evidence_links`

Purpose: attaches evidence to a proposal version, assessment, dispute, or decision.

Suggested fields:

- `id`;
- `evidence_item_id`;
- `subject_type`;
- `subject_id`;
- `relation`;
- `quote` nullable;
- `locator` nullable;
- `created_at`.

Relations can include:

```text
supports
contradicts
source
method
context
```

### 5.7 `kg_assessments`

Purpose: immutable reviewer judgments against one proposal version or applied revision.

Suggested fields:

- `id`;
- `space_id`;
- `subject_type`;
- `subject_id`;
- `actor_ref`;
- `actor_kind`;
- `verdict`;
- `rationale_md`;
- `capability_snapshot` JSONB;
- `model_metadata` JSONB nullable;
- `independence_group` nullable;
- `supersedes_assessment_id` nullable;
- `created_at`.

Verdicts initially:

```text
approve
dispute
abstain
```

Do not upsert an assessment when a reviewer changes its mind. Insert a new immutable assessment with `supersedes_assessment_id` pointing to the earlier one. The current effective judgment for an actor is the newest unsuperseded assessment.

This fixes a known limitation of the current `agent_verifications` model, where upserts destroy historical judgment state.

### 5.8 `kg_disputes`

Purpose: stable dispute identity.

Suggested fields:

- `id`;
- `space_id`;
- `subject_type`;
- `subject_id`;
- `opened_by_actor_ref`;
- `opened_by_kind`;
- `reason_md`;
- `state` projection;
- `created_at`;
- `closed_at` nullable.

### 5.9 `kg_dispute_rulings`

Purpose: append-only moderator ruling history.

Suggested fields:

- `id`;
- `dispute_id`;
- `ruling` (`upheld | overruled | withdrawn | superseded` as appropriate);
- `actor_ref`;
- `rationale_md`;
- `created_at`.

### 5.10 `kg_policy_decisions`

Purpose: records exactly why the policy engine considered a proposal publishable or held.

Suggested fields:

- `id`;
- `space_id`;
- `proposal_version_id`;
- `policy_id`;
- `policy_version`;
- `decision`;
- `requirements` JSONB;
- `satisfied_requirements` JSONB;
- `unsatisfied_requirements` JSONB;
- `input_fingerprint`;
- `evaluated_at`;
- `evaluation_mode` (`shadow | advisory | authoritative`).

Possible decisions:

```text
apply
hold
human_review
return
reject
```

The decision record is audit evidence, not merely a transient return value.

### 5.11 `kg_publication_events`

Purpose: immutable record of what ultimately happened to the proposal.

Suggested fields:

- `id`;
- `proposal_version_id`;
- `action`;
- `actor_ref`;
- `policy_decision_id` nullable;
- `applied_revision_ref` nullable;
- `created_at`.

Actions:

```text
submitted
applied
returned
rejected
withdrawn
```

### 5.12 `kg_audit_events`

Purpose: append-only operational audit for actions that do not naturally fit the domain tables.

Suggested fields:

- `id`;
- `space_id`;
- `event_type`;
- `actor_ref` nullable;
- `subject_type`;
- `subject_id`;
- `payload` JSONB;
- `created_at`.

### 5.13 `kg_legacy_links`

Purpose: explicit mapping between generic records and current Kinetix records during migration.

Suggested fields:

- `id`;
- `generic_type`;
- `generic_id`;
- `legacy_type`;
- `legacy_id`;
- `created_at`.

Unique both ways where appropriate.

This table should make parity debugging straightforward rather than relying on payload heuristics.

---

## 6. Do not fabricate historical fidelity during backfill

The current Kinetix data model does not retain every version of every agent verdict. `agent_verifications` uses upsert semantics, and some target revisions clear or replace verification state.

Therefore the migration must not pretend to reconstruct an append-only historical sequence that no longer exists.

Backfill rules:

1. Preserve existing immutable Kinetix revisions wherever they exist.
2. Import the **current effective** legacy verification state as a migration snapshot.
3. Mark imported records with explicit provenance such as:

```json
{
  "origin": "legacy_snapshot",
  "capturedAt": "...",
  "historicalCompleteness": "current_state_only"
}
```

4. Do not infer when a current approval replaced an earlier dispute unless that history actually exists in source tables.
5. All governance activity after the new append-only write path is enabled is recorded completely.
6. Benchmark/reporting code must distinguish pre-migration reconstructed state from post-migration native history.

---

## 7. Policy engine design

### 7.1 Policy is code-first initially

Do not begin with a fully dynamic JSON rules language.

The first version should be a small deterministic TypeScript policy-composition API. This keeps rules type-checked, testable, reviewable, and difficult to accidentally weaken through malformed runtime configuration.

Example conceptual API:

```ts
policy('kinetix-default-v1')
  .when({ authorKind: 'human' })
  .require(humanModeratorDecision())

policy('kinetix-default-v1')
  .when({ tags: ['clinical_case'] })
  .require(humanCapability('clinical_expert'))

policy('kinetix-default-v1')
  .when({ risk: 'high' })
  .require(
    independentApprovals(2),
    approvalWithCapability('model_tier:flagship'),
    noOpenDisputes(),
  )

policy('kinetix-default-v1')
  .otherwise(
    independentApprovals(effectiveQuorum),
    noOpenDisputes(),
  );
```

The actual API can differ. The important requirements are:

- deterministic evaluation;
- stable rule IDs;
- versioned policy sets;
- explainable unmet requirements;
- pure evaluation where possible;
- no hidden model judgment inside the gate;
- no self-reported actor capability affecting a publication requirement.

### 7.2 Policy inputs

The engine should evaluate a normalized `PolicyContext` containing only facts needed for governance:

```ts
interface PolicyContext {
  space: string;
  targetType: string;
  author: ActorSnapshot;
  risk: RiskProfile;
  proposalVersionId: string;
  evidenceState: EvidenceState;
  assessments: EffectiveAssessment[];
  disputes: DisputeState[];
  pool: ReviewerPoolState;
  flags: readonly string[];
}
```

The core does not know what `halfLife` means. The Kinetix adapter produces risk tags such as:

```json
{
  "level": "high",
  "tags": ["calculation_driving", "entry_backed"]
}
```

### 7.3 Assurance state rather than one universal score

Do not make a generic equivalent of Kinetix's 0-3 verification level the canonical state.

The core should expose an assurance profile such as:

```ts
interface AssuranceProfile {
  explicitApprovals: number;
  independentApprovers: number;
  humanApprovals: number;
  agentApprovals: number;
  approvalCapabilities: string[];
  disputesOpen: number;
  abstentions: number;
  evidenceRequirementState: EvidenceRequirementState[];
}
```

Kinetix can continue to project this into its existing 0-3 `VerificationLevel` plus orthogonal disputed flag.

Create a compatibility function such as:

```ts
projectKinetixVerificationLevel(profile): VerificationLevelInfo
```

The UI should not have to change during early backend migration.

### 7.4 Policy versioning

Every authoritative decision records the exact policy version used.

A later policy change must not retroactively imply that older content was published under the new rule.

At minimum retain:

- policy ID;
- semantic/config version;
- code/build revision if useful;
- input fingerprint;
- result and unmet requirements.

---

## 8. Independent review and anti-echo-chamber invariants

The current blind peer-review design is one of the most valuable reusable mechanisms and must become a core contract.

### 8.1 Review packet

A reviewer receives a sealed snapshot containing:

- proposal version ID;
- target identity;
- existing/current value needed for comparison;
- proposed payload;
- cited evidence needed to judge it;
- target version/base revision;
- risk/context fields needed for the review task;
- no other reviewers' verdicts or approval counts.

### 8.2 Reviewer-visible vs moderator-visible views

Provide two separate read models:

**Independent reviewer view**

- proposal and evidence;
- no peer verdicts;
- no approval tally;
- no dispute rationale from another reviewer before own verdict if that would contaminate blind review.

**Moderator/auditor view**

- all assessments;
- dispute rationales;
- assurance summary;
- policy requirement state;
- complete history.

### 8.3 Version-bound assessment

Every assessment references the immutable proposal version it judged.

If the author changes the payload:

- create a new proposal version;
- old assessments stay attached to the old version;
- they do not count toward publication of the new version;
- reviewers receive the new version in the queue.

This replaces complex "clear old verdict" semantics with structural correctness.

### 8.4 Self-review

Generic core rule:

- self-review eligibility is a host-supplied capability/policy fact;
- default is prohibited;
- it never comes from the actor's request body;
- policy decides whether a self-review can count as one or more assurance acts;
- Kinetix retains its current trusted-self-review semantics as an adapter/policy rule.

---

## 9. Evidence architecture

### 9.1 Generic evidence contract

The core needs to know:

- what evidence objects are linked;
- whether a host-defined evidence requirement is satisfied;
- what evidence backs a reviewer assessment.

It does not need to understand PubMed, DOI, PDF acquisition, or pharmacology.

### 9.2 Kinetix evidence adapter

Create a Kinetix evidence adapter mapping:

- `citations.id` -> generic evidence reference;
- paper review state -> `judged/read_in_full` evidence capability;
- stored PDF/request state -> evidence acquisition metadata;
- citation identifier consistency -> Kinetix validation signal.

The existing `assertReferencesJudgedForActor` behaviour stays authoritative until the generic evidence-policy projection matches it exactly.

### 9.3 No evidence duplication requirement in phase 1

Do not copy all citation metadata into `kg_evidence_items` initially.

A generic evidence item can point to the canonical Kinetix citation row through an external/local locator. This avoids introducing competing citation sources of truth during extraction.

---

## 10. API strategy

### 10.1 Preserve all current Kinetix endpoints

Do not ask Kinetix UI or agents to switch endpoints during early extraction.

Existing routes continue to exist, including:

- pending edit routes;
- agent verification queue;
- agent verification submission;
- disputes;
- approvals;
- paper review/reference routes.

They gradually delegate to the generic services internally.

### 10.2 Add generic internal service APIs first

Create TypeScript services before public HTTP routes:

```text
GovernanceProposalService
GovernanceReviewService
GovernanceAssessmentService
GovernancePolicyService
GovernanceDisputeService
GovernanceAssuranceService
GovernanceAuditService
```

This makes Kinetix migration possible without immediately committing to a public cross-project API.

### 10.3 Generic HTTP API later

Once the internal contract is stable, expose a host-neutral API surface, for example:

```text
POST /api/governance/proposals
POST /api/governance/proposals/:id/versions
POST /api/governance/proposals/:id/submit
GET  /api/governance/review-queue
POST /api/governance/assessments
GET  /api/governance/subjects/:type/:id/assurance
POST /api/governance/disputes
POST /api/governance/disputes/:id/rulings
GET  /api/governance/proposals/:id/history
```

Kinetix agents do not need to use these until the adapter is proven.

---

## 11. Migration control plane

### 11.1 Per-target migration state

Add a table such as `kg_migration_state`:

```text
space_id
target_type
mode
updated_by
updated_at
notes
```

Modes:

```text
legacy_only
shadow
compare
generic_read
legacy_write_generic_mirror
generic_authoritative
```

Exact names can be simplified, but the state machine must be explicit.

### 11.2 Meaning of modes

#### `legacy_only`

No behaviour change. Generic code may not participate in the request.

#### `shadow`

Legacy path is authoritative. Generic computation may run after/beside it and record diagnostics. A generic failure cannot fail the Kinetix request.

#### `compare`

Legacy path remains authoritative. Generic output is computed and compared synchronously or asynchronously, with divergence metrics and structured logs.

#### `generic_read`

The request can read generic-derived state, but legacy write/apply remains authoritative. If generic read fails or is inconsistent, fall back to legacy.

#### `legacy_write_generic_mirror`

Legacy mutation is authoritative, and equivalent append-only generic records are mirrored. Mirror failure is surfaced operationally and repairable without undoing the accepted Kinetix mutation.

#### `generic_authoritative`

Generic governance decides eligibility/state, but Kinetix's domain adapter still applies the actual domain mutation using existing proven apply functions. Legacy compatibility projections continue to be written so old UI/API code remains functional.

### 11.3 Global override

`KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` overrides every target to legacy behaviour.

### 11.4 Migration-state safety rules

- only admin can change state;
- every change is audited;
- high-risk target types cannot be moved directly from `legacy_only` to `generic_authoritative`;
- automated deployment does not advance migration state;
- state transitions require explicit parity gate evidence;
- a target can always move backward to a safer state while legacy compatibility remains installed.

---

## 12. Shadow-write and dual-write strategy without breaking Kinetix

This is the most important operational part of the migration.

### 12.1 Stage A: non-blocking shadow records

Initially, generic persistence is observational.

For a successful legacy action:

1. complete the existing Kinetix transaction exactly as today;
2. after success, attempt to create the corresponding generic mirror record;
3. if mirror creation fails, log a structured repair item;
4. do **not** roll back or fail the already-valid Kinetix action;
5. a reconciliation job/scanner can reconstruct missing mirrors from legacy state.

This means early generic-schema bugs cannot take down contribution/moderation.

### 12.2 Stage B: reconciliation scanner

Implement a deterministic reconciliation command/test that finds:

- legacy pending edits without generic proposal links;
- current legacy agent verifications without mirrored assessment snapshot;
- generic proposals whose linked legacy row is missing;
- mismatched payload fingerprints;
- mismatched status projections;
- missing publication/apply links.

Run it in CI against fixtures and periodically against production read-only data.

### 12.3 Stage C: hard dual persistence after mirror stability

Only after shadow mirroring is stable should selected target types write generic records as part of the canonical operation.

At this point:

- generic proposal/version persistence and legacy compatibility updates occur through one orchestrated service;
- generic persistence and the host-domain side effects run inside **one ambient transaction on one connection** — not "a transaction where practical" (see 12.3.1);
- no external notifications/hooks fire until the transaction is committed;
- failures before commit can safely fall back or retry without duplicated domain mutations.

### 12.3.1 One ambient transaction, joined via `inTransaction()`

"Both sides happen in a transaction" is not sufficient, and this is not a
stylistic preference — in this codebase the two obvious ways to arrange it are
both broken:

- **Nesting.** Today `applyApprovedEdit` in `api/_lib/pending-edits-helpers.ts`
  calls `runInPoolTransaction` unconditionally. Invoking it from inside the
  governance transaction opens a **second Neon Pool on a different
  connection**. The approval path takes transaction-scoped drug advisory locks
  (`pg_advisory_xact_lock`) and a `FOR NO KEY UPDATE` row lock on
  `pending_edits`; the parameter and parameter-entry apply paths do the same.
  The inner connection would block on locks the outer connection holds while
  the outer awaits the inner — a hang until timeout, not an error. This is the
  failure `inTransaction()` was introduced for (`api/_lib/db.ts`), after it
  took down the monograph-creation path.
- **Sequencing.** Calling the legacy helper outside the governance transaction
  removes the deadlock but opens a crash window: the domain mutation commits on
  its own connection and the process dies before the generic publication state
  commits. The result is an applied edit with no `kg_publication_events` row —
  exactly the divergence class Stage C exists to eliminate, and one
  reconciliation cannot repair without guessing.

So the requirement is hard, and it lands **before** any target type reaches
`generic_authoritative`:

1. the orchestrating service opens exactly one `runInPoolTransaction` at the
   top of the unit of work;
2. every legacy helper reachable from an adapter `apply()` — starting with
   `applyApprovedEdit`, the `api/drug-parameter.ts` and
   `api/parameter-entries.ts` apply paths, and anything they call — is
   converted from `runInPoolTransaction` to `inTransaction()` so it joins an
   ambient transaction instead of opening a second Pool;
3. converted helpers keep working standalone: outside a transaction
   `inTransaction()` opens one, so the existing endpoints are unaffected;
4. lock ordering is preserved across the join — advisory locks before row
   locks, in the same order the merge fold takes them, since the governance
   wrapper does not change the ABBA hazard, only who opens the transaction;
5. adapters never call `runInPoolTransaction` directly; a lint rule or a
   grep-based unit test keeps that true as new adapters land.

Because the integration harness routes `runInPoolTransaction` through a single
PGlite connection — where a nested call degrades to a savepoint and advisory
locks are re-entrant — a nesting bug of this shape **passes the suite and only
appears in production**. Assertions that "the side effects happened in a
transaction" therefore prove nothing. Tests must assert connection identity;
see 16.6.

### 12.4 Never make an early shadow mirror a hard dependency

Do not make `INSERT kg_*` failure reject a valid Kinetix edit while the generic schema is still experimental.

The moment generic persistence becomes required is itself a formal cutover stage with tests and rollback support.

---

## 13. Target-type migration order

Migrate by consequence and complexity, not convenience.

Suggested order:

### Tier A: governance-only / lowest publication consequence

1. peer-assessment history mirroring;
2. dispute history mirroring;
3. paper-review verification state;
4. discussion verification targets if retained as governance targets.

These exercise assessment, queue, disputes, and assurance without controlling calculation-driving values.

### Tier B: low-to-medium-risk content proposals

5. `wiki_fact`;
6. `wiki_section`;
7. selected metadata-oriented edits;
8. `bio_entity` edits where the apply path is straightforward.

### Tier C: complex domain writes

9. metabolism;
10. receptor target edits;
11. enzyme interaction edits;
12. whole wiki page/new page flows;
13. learning units.

### Tier D: safety/high-integrity last

14. non-calculation-driving authored parameters;
15. calculation-driving `parameter` edits;
16. `param_entry` changes, including model-structure axes;
17. clinical cases.

High-risk calculation-driving parameters and clinical cases must remain on the established Kinetix approval path until the generic system has proven the exact current gate semantics in production shadow mode.

---

## 14. Detailed implementation phases

## Phase 0 - Freeze behaviour and establish a baseline

**Goal:** create a testable specification of what must not regress.

### Work

1. Inventory every current edit type and target type.
2. Add/expand contract tests for:
   - role/capability admission;
   - human vs agent submitter behaviour;
   - self-review disabled/enabled;
   - implicit approval semantics;
   - no self-verification by default;
   - independent queue contents;
   - target version stale rejection;
   - dispute open/withdraw/ruling;
   - ~~human-authored edit never agent-auto-applied~~ → human-authored edit held to the same bar as an agent's; unattributed edit never agent-auto-applied (v2);
   - clinical-case human requirement;
   - normal quorum;
   - degraded quorum;
   - high-risk no-degraded-quorum rule;
   - flagship approval requirement;
   - server-owned tier snapshot;
   - reference gate;
   - review token race protection;
   - returned/revised edit behaviour;
   - upheld-dispute behaviour;
   - conflict markers;
   - Kinetix 0-3 verification projection.
3. Create deterministic fixtures covering every `pending_edits.edit_type`.
4. Capture baseline performance for review queue and moderation endpoints.
5. Document current behaviour that is intentionally odd but relied upon.

### Likely files

- `tests/api/agent-verifications-helpers.test.ts`;
- new `tests/governance/legacy-contract/*.test.ts`;
- `tests/api/pending-edits*.test.ts`;
- review queue integration tests;
- `docs/plans/...` follow-up notes if undocumented behaviour is found.

### Exit gate

- every current publication invariant has an automated regression test;
- no generic code is authoritative;
- production behaviour unchanged.

### Rollback

None needed. Test-only phase.

---

## Phase 1 - Introduce pure generic governance types and policy primitives

**Goal:** separate policy concepts from Kinetix persistence without changing behaviour.

### New code

Suggested internal location while still in Kinetix:

```text
src/lib/knowledge-governance/
  types.ts
  actors.ts
  risk.ts
  assurance.ts
  policy.ts
  requirements.ts
  decisions.ts
  index.ts
```

Keep this layer free of:

- Drizzle;
- Kinetix drug modules;
- React;
- HTTP request objects;
- Neon;
- PubMed/citation logic.

Move or wrap pure logic such as:

- effective quorum calculation;
- high-level consensus requirement representation;
- assurance tallying;
- capability requirement checks.

Initially keep legacy exported functions intact and make them call the generic equivalent or compare results in tests.

### Example compatibility approach

```ts
export function consensusApprovalHoldReason(...) {
  return projectLegacyInputsIntoGovernancePolicy(...);
}
```

Do not change endpoint behaviour.

### Exit gate

- existing unit tests pass unchanged;
- generic pure functions have direct tests;
- legacy and generic policy outcomes match on an exhaustive fixture matrix.

### Rollback

Revert imports. No schema impact.

---

## Phase 2 - Add target adapter interfaces and Kinetix registry

**Goal:** remove domain-specific switch logic from the conceptual core before changing storage.

### New code

```text
api/_lib/knowledge-governance/
  registry.ts
  target-adapter.ts
  review-packet.ts
  actor-context.ts
  adapters/
    kinetix/
      drug-parameter.ts
      parameter-entry.ts
      wiki-fact.ts
      wiki-section.ts
      paper-review.ts
      discussion.ts
      bio-entity.ts
```

### Work

1. Define `KnowledgeTargetAdapter`.
2. Register adapters at application startup/module initialization.
3. Implement adapters by delegating to existing Kinetix reads/validators/apply helpers.
4. Build generic `ReviewPacket` shape.
5. Add adapter-level tests showing that generic hydration is equivalent to current queue payloads.

Do **not** replace `api/agent-verifications-queue.ts` yet. Let a shadow adapter-based queue run in tests/diagnostics.

### Exit gate

- every currently supported verification target can be represented by an adapter;
- adapter review packets preserve all information an agent currently receives;
- no extra verdict/approval information leaks into reviewer packets;
- Kinetix production paths still use legacy route logic.

---

## Phase 3 - Add append-only generic schema

**Goal:** create durable generic records without making them authoritative.

### Database migration

Add the `kg_*` tables described above.

Rules:

- additive only;
- nullable compatibility foreign keys where necessary;
- no triggers altering existing Kinetix behaviour;
- no changes to existing column meaning;
- indexes created for expected queue and history queries;
- migrations safe when old application code is still serving.

### New store layer

```text
api/_lib/knowledge-governance/store/
  interface.ts
  postgres.ts
  proposals.ts
  versions.ts
  assessments.ts
  disputes.ts
  decisions.ts
  audit.ts
  legacy-links.ts
```

### Backfill

Only create:

- Kinetix space;
- target identities as needed;
- current-state legacy snapshots with explicit incomplete-history provenance.

Do not run a giant speculative backfill of every historical entity unless required for a query.

### Exit gate

- migration applies on production-like database copy;
- old Kinetix build works against expanded schema;
- new tables can be empty without affecting Kinetix;
- backfill is idempotent;
- migration tests verify no destructive statements.

### Rollback

Old code ignores the tables. Leave them in place if rollback is needed.

---

## Phase 4 - Shadow mirror proposals and assessments

**Goal:** begin accumulating correct append-only generic history while Kinetix remains fully legacy-authoritative.

### Work

1. After successful legacy pending edit creation, create/link `kg_proposal` + version.
2. After legacy payload revision, create a new generic version.
3. After agent verification write, append generic assessment.
4. Mirror human approvals as assessments/decision inputs where appropriate.
5. Mirror disputes and rulings.
6. Mirror publication/apply/return/reject outcomes.
7. Add structured error logging when mirror writes fail.
8. Add reconciliation scanner.

### Critical safety rule

Mirror failures do not reject successful Kinetix actions during this phase.

### Observability

Metrics per target type:

```text
kg_mirror_attempt_total
kg_mirror_success_total
kg_mirror_failure_total
kg_reconciliation_missing_total
kg_payload_fingerprint_mismatch_total
kg_state_projection_mismatch_total
```

### Exit gate

For a minimum observation period:

- unexplained mirror loss = 0 after reconciliation;
- payload fingerprint parity effectively 100%;
- no Kinetix endpoint error-rate increase attributable to shadow code;
- no measurable publication behaviour change.

Suggested initial bar for low-risk types: at least 7 days and at least 500 relevant events if volume permits. For high-risk targets, use a substantially longer and stricter gate later.

---

## Phase 5 - Shadow generic review queue

**Goal:** prove the adapter-based generic queue selects and hydrates the same work without agents depending on it.

### Work

1. Implement generic queue candidate interface.
2. Preserve:
   - author exclusion;
   - already-reviewed exclusion;
   - self-review exceptions;
   - minimum age;
   - per-type reserve behaviour;
   - visibility rules;
   - no prior verdict disclosure.
3. Run legacy and generic queue selection for the same synthetic/current actor context.
4. Compare candidate identity sets and packet fingerprints.

### Important

Queue ordering need not be byte-for-byte identical if a new prioritization model is intentionally introduced later. During extraction, however, target inclusion/exclusion semantics should match before any scheduling improvement is attempted.

### Metrics

```text
kg_queue_candidate_legacy_only
kg_queue_candidate_generic_only
kg_queue_packet_mismatch
kg_queue_order_difference
kg_queue_latency_ms
```

### Exit gate

- no unexplained candidate eligibility divergences;
- no reviewer-data leakage;
- latency within acceptable budget;
- existing agent queue remains the served endpoint.

---

## Phase 6 - Shadow generic policy decisions

**Goal:** prove the new policy engine reaches the same publication decision as the current code.

### Work

For every pending edit touched by an approval/verdict/moderation action:

1. collect normalized policy context;
2. evaluate generic Kinetix policy in `shadow` mode;
3. evaluate/observe legacy result;
4. persist `kg_policy_decisions`;
5. compare reason and outcome.

### Required parity matrix

At minimum include:

- human author with many agent approvals;
- agent author with no approvals;
- agent author with one peer approval in small pool;
- ordinary agent edit with full quorum;
- open dispute;
- upheld dispute;
- self-review cases;
- high-risk with two mid-tier approvals;
- high-risk with flagship + mid approval;
- high-risk degraded pool;
- clinical case;
- stale version;
- unknown/null verifier tier.

### Divergence handling

Any generic decision that is **more permissive** than legacy is severity 1 and blocks cutover.

A generic decision that is more conservative may be acceptable temporarily but must be explained before cutover because it can create review backlog.

### Exit gate

- 100% explained parity on deterministic fixture corpus;
- no unexplained production shadow divergence for the target type during its observation window;
- zero cases where generic would publish something legacy would hold.

---

## Phase 7 - First read cutover: assurance/history for low-risk targets

**Goal:** let Kinetix consume generic-derived read state before generic controls publication.

First candidates:

- paper review assurance;
- selected wiki fact assurance.

### Work

1. Add `GovernanceAssuranceService`.
2. Implement Kinetix projection to existing `VerificationLevelInfo`.
3. In `generic_read` mode, serve the generic projection.
4. If generic read fails or linked records are incomplete, fall back to current legacy calculation.
5. Compare returned level/dispute state in logs during rollout.

### UI

No UI change required initially. Existing Kinetix review/monograph UI continues to receive the same shape.

### Exit gate

- verification-level parity;
- no increase in page/API errors;
- rollback tested by migration-state toggle and force-legacy flag.

---

## Phase 8 - First authoritative cutover: low-risk proposal type

**Goal:** let generic policy/orchestration become authoritative for one reversible low-risk target while existing Kinetix apply code remains the mutation mechanism.

Suggested first target: `wiki_fact` or another well-tested low-risk content type, chosen after Phase 6 parity data.

### Prerequisite: legacy helpers join the ambient transaction

Authoritative cutover cannot start until every legacy helper on the chosen
target's apply path uses `inTransaction()` rather than `runInPoolTransaction`,
with the connection-identity tests from 16.6 green for that path. This is a
separate, shippable, behaviour-preserving PR (see PR 12b) that lands while
legacy is still authoritative — not a change made under a live cutover.

### Request path

```text
existing Kinetix endpoint
  -> authenticate using Kinetix auth
  -> resolve Kinetix ActorContext
  -> generic proposal/version service
  -> Kinetix adapter validation
  -> generic assessment/policy engine
  -> Kinetix adapter apply()
  -> existing applyFactOp/applyTopicFactOp logic
  -> legacy revision + compatibility projection
  -> generic publication event
```

### Compatibility requirement

The legacy `pending_edits` row remains updated so:

- current moderator UI still works;
- current admin tooling still works;
- old deployment instances can still interpret the state during rolling deploys;
- force-legacy rollback remains possible.

### Failure fallback

Before any domain mutation is committed, a generic orchestration failure may fall back to the legacy path if it is safe and the request has not produced side effects.

Once a generic transaction has committed an authoritative publication event, do not rerun the same mutation blindly through legacy. Idempotency and linked revision IDs must prevent duplicate application.

### Exit gate

- production target runs generic-authoritative for a defined observation window;
- no rollback-triggering incidents;
- reconciliation remains clean;
- moderator queue parity remains acceptable;
- force-legacy rollback exercise succeeds.

---

## Phase 9 - Expand low/medium-risk target cutovers

Repeat Phase 8 one target at a time.

For each target type create a migration dossier containing:

- current legacy contract tests;
- adapter tests;
- queue parity report;
- policy parity report;
- mirror/reconciliation report;
- known edge cases;
- rollback procedure;
- approval to advance migration state.

Do not bundle multiple unrelated target cutovers into one PR.

---

## Phase 10 - High-risk Kinetix cutover

**Goal:** migrate calculation-driving parameters only after the generic architecture has already proven itself on lower-risk targets.

### Additional prerequisites

Before any calculation-driving target reaches `generic_authoritative`:

1. append-only assessment history has been running reliably in production;
2. high-risk policy shadow parity has zero unexplained permissive divergences;
3. flagship capability snapshot is tested against downgrade/revocation races;
4. full quorum vs degraded quorum behaviour matches current Kinetix;
5. open-dispute blocking matches current Kinetix;
6. reference/evidence gate parity is established;
7. param-entry conflict and applicability locks are adapter-covered;
8. recomputation side effects are transactionally safe;
9. parameter summary/revision writes remain identical;
10. a high-risk rollback drill has been performed.

### Suggested evidence gate

For high-risk target types, require the longer of:

- at least 30 days of production shadow policy comparison; or
- at least 1,000 shadow decision opportunities if volume is sufficient;

with zero unexplained cases where generic would have published while legacy would not.

If volume is low, supplement with replay/property testing across historical and synthetic edge cases. Do not weaken the correctness criterion merely to reach a date.

### Keep existing high-risk apply code

Even after generic governance becomes authoritative, continue using the current Kinetix parameter/entry apply helpers through the adapter initially. Extraction of domain mutation code is not a goal.

---

## Phase 11 - Clinical case and explicit expert-signoff targets

Clinical cases remain last because their invariant is not merely quorum mathematics. A human expert must sign off.

Generic policy should express this as a capability requirement rather than a hardcoded Kinetix edit type in the core:

```text
require human actor
require capability clinical_case_expert
```

The Kinetix adapter supplies the risk tag/required capability.

Only cut over after moderator identity/capability snapshots are reliable and auditable.

---

## Phase 12 - Generic agent SDK and public integration surface

Once Kinetix runs safely on the internal services, define a reusable SDK.

Suggested package-level API:

```ts
client.proposals.create(...)
client.proposals.revise(...)
client.proposals.submit(...)
client.review.getBatch(...)
client.assessments.submit(...)
client.disputes.open(...)
client.disputes.rule(...)
client.assurance.get(...)
client.history.get(...)
```

Agent-specific convenience functions may exist, but the base API should use actor-neutral terminology.

Preserve the rule that the review batch endpoint does not expose existing peer judgments.

---

## Phase 13 - Validate with a second non-pharmacology domain

This phase is mandatory before declaring the abstraction reusable.

Choose a genuinely different project with:

- different target schema;
- different evidence types;
- different risk rules;
- at least human + agent contributions;
- some content that can auto-publish and some that requires stronger review.

Examples might include:

- a project knowledge base;
- software architecture decisions;
- structured research findings outside pharmacology;
- policy/procedure knowledge;
- educational content.

The second domain should implement only adapters and policy definitions. If it must modify core code for domain vocabulary, that is evidence the abstraction is still Kinetix-shaped.

### Abstraction test

For every core concept ask:

- does both Kinetix and domain 2 need this?
- if not, can it move back into the Kinetix adapter?
- does the generic name still make sense without pharmacology?
- does the second domain require an extension point rather than a new switch case?

---

## Phase 14 - Extract to a separate reusable repository

**The core is extracted.** It lives at https://github.com/hagelien/assurance-core and publishes as
`@assurance/core`. The repository name settles the earlier open question - `assurance-core` rather
than a monorepo named `assurance`, because what was extracted is the one pure package and a repo
named for it is easier to reason about than a `packages/` tree with a single occupant.

What moved: the seven pure modules under `src/lib/knowledge-governance/` (not the `kinetix/`
subfolder, which is this host's projection and stays here), their five test suites, and the shared
`PolicyContext` fixture builder. 1,323 lines, zero dependencies, 131 tests that run in under a second
with no database.

What did **not** move, deliberately: nothing in Kinetix changed. This repository keeps its own copy
and its 69 importers, so the extraction could not regress anything. Swapping Kinetix onto the
published package is a separate, reviewable change once the package has a release, and the existing
governance suite is what will verify it.

The gate above said "only after the core has served Kinetix and a second domain". It was extracted
before a second *production* domain existed. Standing in for one is `examples/adr-log.ts` in the new
repository - an architecture-decision log, executed in its CI - which exercises the full path
(policy, risk tags, tally, decision) on a domain with no overlap with pharmacology. That is weaker
evidence than a real second host and is recorded here as such.

### What the extraction turned up

The code was already clean; a boundary guard had been enforcing that. The **documentation** was not.
Doc comments in the pure core named Kinetix more than twenty times and pointed at files - a
`projection.ts`, an `agent-verifications.ts`, "§7.2 of the extraction plan" - that do not exist in
the extracted repository. §28's guard stripped comments before scanning, on the reasoning that only
code can create a dependency: true of dependencies, false of documentation. All of it is rewritten
to describe the host generically, and the new repository's `tests/purity.test.ts` scans whole files,
comments included.

### Still open

Publishing. Confirm the npm **organisation** `assurance` is free before the first `npm publish` - an
unpublished package name is not proof of that, since orgs are reserved separately. If it is held,
`@kg-assurance` or a personal scope both work and leave the repository name untouched.

The `postgres`, `http` and `agent-sdk` layers are not extracted. They are the parts with real
dependencies (Drizzle, a `db` handle, HTTP contracts), and each is a separate decision.

Original package structure sketch, kept for when those layers move:

Suggested package structure:

```text
packages/
  core/
  postgres/
  http/
  agent-sdk/
  react-review/       # optional, later
examples/
  minimal-memory/
  postgres-host/
```

### Package responsibilities

#### `core`

- types;
- proposal/version state model;
- assurance computation;
- policy requirements;
- policy evaluation;
- review-packet contracts;
- adapter interfaces;
- zero database/runtime-framework dependency.

#### `postgres`

- schema/store implementation;
- migrations;
- reconciliation helpers;
- no Kinetix tables.

#### `http`

- optional generic handlers/router contracts;
- host injects auth/ActorContext resolver and adapter registry.

#### `agent-sdk`

- review queue and assessment client helpers;
- no model-vendor dependency.

#### `react-review`

Only after the backend abstraction is stable. Could provide generic review primitives, not Kinetix-specific drug cards.

### How Kinetix consumes it

Kinetix should pin an exact package version in `package-lock.json`.

Do not make Kinetix fetch an unversioned branch at runtime/build time.

Recommended extraction sequence:

1. copy the proven internal module to new repo;
2. run the same core test suite there;
3. publish `0.x` package;
4. change Kinetix imports to package imports behind compatibility tests;
5. keep Kinetix adapter code local;
6. deploy;
7. observe;
8. only then remove the duplicate internal core copy.

During the first external-package cutover, maintain a short-lived local fallback/compatibility branch so rollback does not depend on republishing a package.

---

## 15. Concrete Kinetix file-level plan

Names are proposals and may be adjusted, but responsibilities should remain separated.

### 15.1 New pure core

```text
src/lib/knowledge-governance/
  index.ts
  types.ts
  actors.ts
  targets.ts
  proposals.ts
  assessments.ts
  disputes.ts
  evidence.ts
  risk.ts
  assurance.ts
  requirements.ts
  policy.ts
  decisions.ts
  migration-mode.ts
```

### 15.2 New server orchestration

```text
api/_lib/knowledge-governance/
  actor-context.ts
  registry.ts
  target-adapter.ts
  proposal-service.ts
  review-service.ts
  assessment-service.ts
  dispute-service.ts
  policy-service.ts
  assurance-service.ts
  publication-service.ts
  compatibility.ts
  reconciliation.ts
  migration-state.ts
```

### 15.3 Kinetix adapters

```text
api/_lib/knowledge-governance/adapters/kinetix/
  parameter.ts
  parameter-entry.ts
  wiki-fact.ts
  wiki-section.ts
  wiki-page.ts
  paper-review.ts
  discussion.ts
  metabolism.ts
  receptor-targets.ts
  enzyme-interaction.ts
  bio-entity.ts
  learning-unit.ts
  clinical-case.ts
  evidence.ts
  risk.ts
  policy.ts
```

### 15.4 Store

```text
api/_lib/knowledge-governance/store/
  interface.ts
  postgres.ts
  proposal-store.ts
  assessment-store.ts
  dispute-store.ts
  policy-decision-store.ts
  audit-store.ts
  legacy-link-store.ts
```

### 15.5 Generic routes, later

```text
api/governance-proposals.ts
api/governance-review-queue.ts
api/governance-assessments.ts
api/governance-disputes.ts
api/governance-history.ts
api/governance-assurance.ts
```

These should not replace current Kinetix routes during initial migration.

### 15.6 Existing files gradually converted into facades

Likely affected:

```text
api/pending-edits.ts
api/agent-verifications.ts
api/agent-verifications-queue.ts
api/_lib/agent-verifications.ts
api/_lib/pending-edits-helpers.ts
api/_lib/verification-levels.ts
src/lib/verificationLevel.ts
src/lib/pendingEditsApi.ts
src/pages/ReviewPage.tsx
```

The migration should reduce these files gradually. Avoid a single PR that rewrites all of them.

### 15.7 Database

```text
db/schema.ts
new drizzle migrations
```

All `kg_*` additions first. Existing tables remain until final retirement.

### 15.8 Tests

```text
tests/governance/
  core/
  policy/
  adapters/
  legacy-contract/
  parity/
  migration/
  concurrency/
  e2e/
```

---

## 16. Test strategy

Testing is the migration mechanism, not merely validation after implementation.

### 16.1 Legacy contract tests

Freeze current externally visible semantics before refactoring.

### 16.2 Pure policy tests

Build table-driven tests for every combination of:

- actor kind;
- author/reviewer identity relation;
- approval count;
- capability tier;
- dispute state;
- risk class;
- pool size;
- evidence state.

### 16.3 Property tests

Useful invariants:

- adding an approval must never reduce assurance;
- adding an open dispute must never make an otherwise-held proposal publishable;
- lowering a verifier capability must never make a high-risk proposal easier to publish;
- moving from known capability to unknown must fail safe;
- changing proposal payload must invalidate all old-version publication eligibility;
- ~~human-authored edits cannot become auto-publishable solely by adding agent approvals under Kinetix policy~~ → authorship never changes the bar, and an unattributed proposal cannot become auto-publishable on agent approvals alone (v2);
- high-risk proposals cannot become auto-publishable through degraded quorum;
- policy evaluation is deterministic for identical context.

### 16.4 Adapter parity tests

For each target adapter compare:

- current value;
- proposed value;
- references;
- review packet;
- target version;
- risk classification;
- application result.

### 16.5 Persistence tests

Verify:

- versions immutable;
- assessment supersession preserves history;
- unique current-version projection;
- legacy links idempotent;
- duplicate retry does not double-apply;
- policy decision references correct version.

### 16.6 Concurrency tests

Cover:

- author revises while reviewer submits assessment;
- two reviewers approve concurrently;
- dispute arrives as quorum is reached;
- admin changes verifier tier while verdict is recorded;
- moderator acts while consensus apply attempts;
- two application instances process same tipping approval;
- force-legacy toggle during active requests;
- pending edit conflicts with direct admin/domain mutation.

Connection identity, not just "in a transaction" (see 12.3.1). For every
adapter `apply()` that reaches a legacy helper:

- **required, per adapter, under the PGlite harness:** record the resolved
  `getDb()` client (object identity) and the `isInPoolTransaction()` context
  at both the generic layer and inside the legacy helper, and assert they are
  **the same client object**. This is the assertion that discriminates: a
  nested `runInPoolTransaction` allocates a fresh transaction client and a
  fresh `txStorage` context even on PGlite, so the identity check fails there
  exactly as the production nesting would;
- **not a substitute:** `pg_backend_pid()`/`txid_current()` equality. Under
  PGlite a nested `runInPoolTransaction` degrades to a savepoint on the one
  connection, so both values match on either side of the nesting and the
  assertion passes on precisely the code that opens a second Pool in
  production. Reserve PID/XID equality for the real-Postgres test below, where
  it does discriminate;
- assert no adapter path calls `runInPoolTransaction` while already inside a
  transaction (a static grep test over `api/_lib/knowledge-governance/` plus a
  runtime guard is cheap and catches new code);
- assert a thrown error after the domain mutation rolls back **both** the
  domain rows and the `kg_*` rows. Note what this does and does not prove:
  under PGlite a nested savepoint rolls back with its parent, so a green
  rollback test is evidence of atomicity, **not** evidence that one connection
  was used. The client-identity assertion above is what proves that;
- exercise the real deadlock shape at least once against a real Postgres (not
  PGlite): governance transaction holds the drug advisory lock, legacy helper
  requests it, and the test must complete rather than time out. Assert
  `pg_backend_pid()` equality here.

PGlite cannot reproduce the production failure (nested transactions become
savepoints, advisory locks are re-entrant), so the harness never fails on
nesting by itself — only the client-identity assertion makes it fail, and the
real-Postgres test is what covers the lock behaviour.

### 16.7 Migration tests

For every additive migration:

- old-schema fixture -> migrate -> old code-compatible queries;
- migration idempotency where scripts are used;
- no destructive SQL;
- rolling-deployment compatibility assumptions documented.

### 16.8 E2E tests

At minimum:

1. human wiki fact proposal -> independent agent quorum -> auto-apply (since kinetix-consensus@v2; it was "human approves" before);
2. agent wiki fact -> independent quorum -> auto-apply;
3. agent wiki fact -> dispute -> held -> human ruling;
4. high-risk parameter -> two mid approvals -> held;
5. high-risk parameter -> flagship + peer -> applies only at full quorum;
6. clinical case -> agent approvals -> still held for human expert;
7. payload revision after approvals -> requires new-version reviews;
8. generic service disabled -> legacy path still completes.

---

## 17. Observability and parity reporting

A strangler migration is unsafe if divergences are visible only after a user complains.

### 17.1 Structured divergence record

Create a structured event/table or log payload:

```ts
interface GovernanceDivergence {
  targetType: string;
  legacySubjectId: string;
  genericSubjectId?: string;
  category:
    | 'queue_eligibility'
    | 'review_packet'
    | 'policy_decision'
    | 'assurance_projection'
    | 'state_projection'
    | 'payload_fingerprint'
    | 'apply_result';
  legacyValue: unknown;
  genericValue: unknown;
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
}
```

### 17.2 Critical divergence

Immediately block target-type cutover if:

- generic would apply and legacy would hold;
- generic loses an open dispute;
- generic counts a self/implicit approval incorrectly;
- generic treats a mid/unknown verifier as flagship;
- generic assessment applies to a stale version;
- generic omits required human expert review.

### 17.3 Operational dashboard/report

At minimum surface:

- migration mode by target type;
- mirror success rate;
- unresolved reconciliation items;
- queue parity;
- policy parity;
- generic-vs-legacy latency;
- fallback count;
- generic errors by service;
- force-legacy status;
- high-risk proposal holds by reason.

An admin-only page can come later. Initially a CLI/report and structured logging are sufficient.

---

## 18. Performance constraints

The generic architecture must not turn one simple Kinetix write into a chain of excessive database round trips.

Design rules:

- batch assessment summaries;
- use indexed `(proposal_version_id, actor_ref)` access;
- cache registered adapters/policy definitions in-process;
- keep policy evaluation pure/in-memory after required state is loaded;
- do not hydrate full evidence content unless the review packet needs it;
- avoid network service calls inside publication transactions;
- keep Kinetix current read projections for common UI paths until generic queries are at least as efficient.

Performance acceptance should compare p50/p95 endpoint latency to Phase 0 baseline. A modest overhead during shadow comparison is acceptable, but authoritative mode should target no material regression.

---

## 19. Security and integrity requirements

### 19.1 Server-owned actor facts

Never trust request body fields for:

- actor kind;
- user role;
- agent active status;
- self-review grant;
- verifier capability tier;
- human-expert designation.

Resolve these server-side and snapshot the values that influenced a decision.

### 19.2 Assessment capability snapshot

Keep the current Kinetix principle that the capability used by the gate is captured when the assessment is recorded.

This prevents later model reassignment from retroactively changing old approvals.

### 19.3 Prompt/content boundaries remain host responsibility

The governance core does not execute agent prompts. Kinetix agent instructions continue to define untrusted-content boundaries and tool restrictions.

The SDK must not encourage direct database access.

### 19.4 Audit cannot be silently rewritten

Generic assessments, policy decisions, dispute rulings, and publication events are append-only. Corrections supersede earlier records rather than mutating history.

---

## 20. Compatibility with current Kinetix UI

Do not require an early React rewrite.

### Stage 1

Current UI reads current endpoint shapes. Backend may derive them from legacy or generic state.

### Stage 2

Enhance existing review UI with richer generic assurance information if useful:

- policy hold reasons;
- independent reviewer count;
- capability coverage;
- evidence requirement status.

### Stage 3

Only after the backend is stable consider extracting generic React review components.

Kinetix-specific cards for parameter values, unit conversions, fact anchors, paper reviews, etc. remain in Kinetix.

---

## 21. Suggested PR sequence

Keep PRs narrow and independently deployable.

### PR 0 - this design plan

Docs only.

### PR 1 - legacy governance contract tests

No production behaviour change.

### PR 2 - pure core types + assurance/policy primitives

No routes switched.

### PR 3 - target adapter interface + registry

Adapters delegate to existing Kinetix code.

### PR 4 - additive `kg_*` schema

No reader/writer depends on it.

### PR 5 - generic store + Kinetix space

Still unused by live paths.

### PR 6 - proposal/version shadow mirroring

Best effort, non-blocking.

### PR 7 - assessment/dispute shadow mirroring

Best effort, non-blocking.

### PR 8 - reconciliation tooling and parity report

Read-only operational tooling.

### PR 9 - shadow adapter-based review queue

Legacy served queue remains authoritative.

### PR 10 - shadow Kinetix policy engine

Persist and compare decisions.

### PR 11 - generic assurance projection shadow

Compare to `verificationLevel`.

### PR 12 - low-risk generic read cutover

Per-target flag, fallback to legacy.

### PR 12b - legacy apply helpers join an ambient transaction

Convert `applyApprovedEdit` and the parameter/parameter-entry apply paths from
`runInPoolTransaction` to `inTransaction()`, add the connection-identity and
rollback tests from 16.6, and keep the standalone endpoints behaviourally
identical. No authority change; strictly a prerequisite for PR 13.

### PR 13 - first low-risk generic-authoritative proposal target

Existing domain apply helper retained.

### PR 14+ - one target type per cutover PR

Each with its own dossier/gate evidence.

### Later PR - high-risk parameter shadow hardening

No authority change yet.

### Later PR - calculation-driving parameter cutover

Only after dedicated high-risk gate.

### Later PR - clinical-case cutover

Human expert capability preserved.

### Later PR - generic HTTP API/SDK

After Kinetix internal stability.

### Later PR - second-domain integration

Proves generality.

### Later PR - external package extraction

No Kinetix behavioural change intended.

### Final cleanup PRs

Stop writing legacy tables only after prolonged stability, then remove dead compatibility code/schema in separate releases.

---

## 22. Rollback playbook

Every authoritative phase must have a documented rollback before it is enabled.

### Level 1: target-type runtime rollback

Set migration state to earlier mode:

```text
generic_authoritative -> generic_read -> compare -> legacy_only
```

No deploy required if migration state is runtime-configurable.

### Level 2: global rollback

Set:

```text
KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1
```

Redeploy/restart as required.

### Level 3: code rollback

Revert the latest application commit. Expanded schema remains compatible with older builds.

### Level 4: data repair

Use `kg_legacy_links` and reconciliation tooling to rebuild generic mirrors from legacy state.

Do not delete generic history as part of rollback. Mark erroneous generic records superseded/invalid where necessary.

### Rollback rehearsal

Before high-risk target cutover, explicitly test:

1. create pending edit;
2. run generic shadow path;
3. switch target to generic authoritative in staging;
4. submit/verdict/apply test edit;
5. switch back to legacy;
6. confirm old UI/API can still inspect and continue existing proposals.

---

## 23. Decisions deliberately deferred

Do not solve these during the extraction unless they become necessary.

### 23.1 Hosted governance service

Not required. Embedded library is safer for Kinetix.

### 23.2 Universal numeric trust score

Avoid. Preserve multi-dimensional assurance.

### 23.3 Dynamic admin-editable policy language

Code-first versioned policy is safer initially.

### 23.4 Reputation scoring for actors

Potential future feature, but easy to create feedback loops and not needed for extraction.

### 23.5 Cryptographic signing of assessments

Could be useful across organizations, unnecessary for single-host Kinetix first.

### 23.6 Generic UI framework

Backend first. Extract UI only after multiple domains demonstrate common needs.

### 23.7 Full event sourcing of host knowledge

Not necessary. Only governance history needs append-only semantics.

### 23.8 Automatic policy learning from outcomes

The current rejection-learning ledger can later become an extension. Do not let an agent automatically modify publication policy in the initial generic system.

---

## 24. What remains Kinetix-specific permanently

Even after successful extraction, Kinetix should still own:

- drug and biological entity schemas;
- parameter definitions and applicability;
- PK/PD calculation risk classification;
- citation/PDF acquisition integrations;
- scientific source-quality rules;
- read-in-full scientific evidence policy;
- pharmacology-specific adapters;
- monograph/TipTap mutation logic;
- parameter-entry recomputation;
- model-structure semantics;
- clinical-case expert capability mapping;
- Kinetix role and group mapping;
- Norwegian/English reader-facing rendering;
- Kinetix review-card UI;
- Kinetix agent mission prompts.

The reusable engine governs *how knowledge changes are admitted*. It should not become a generic pharmacology database package.

---

## 25. What should become reusable

The reusable artifact should ultimately provide:

- actor-neutral governance contracts;
- target adapter registry;
- immutable proposal versioning;
- evidence attachment model;
- independent review packets;
- immutable assessments and supersession;
- assurance profiles;
- dispute lifecycle;
- deterministic versioned policy evaluation;
- capability-aware publication requirements;
- audit history;
- migration/reconciliation primitives;
- optional Postgres persistence;
- optional HTTP API;
- optional agent SDK.

This is enough to support projects far outside pharmacology.

---

## 26. Definition of done

The extraction is complete only when all of the following are true.

### Kinetix functionality

- Kinetix public and authenticated functionality works as before;
- all existing knowledge-object types are governed through the generic core or intentionally documented as exceptions;
- current APIs remain compatible or have completed explicit versioned migrations;
- current UI works without depending on legacy-only governance tables;
- force-legacy rollback has been retired only after the generic path is proven and legacy retirement is deliberately accepted.

### Integrity

- no high-risk publication rule is weaker than before;
- human vs agent authority distinctions are preserved;
- blind independent peer review is preserved;
- assessments are immutable/version-bound;
- policy decisions are versioned and auditable;
- verifier capabilities used for gates are server-owned and snapshotted;
- disputes remain first-class and orthogonal to assurance;
- stale proposal versions cannot consume old approvals.

### Reusability

- a second non-pharmacology project can integrate by writing adapters and policies rather than changing core;
- core package contains no drug/pharmacology vocabulary;
- authentication is host-provided;
- database implementation is replaceable behind an interface;
- no Claude/OpenAI/vendor identity is required by core semantics.

### Operational safety

- per-target migration state and rollback procedures were exercised during migration;
- parity/reconciliation tooling reports clean state;
- generic records provide complete append-only history from the date native writing was enabled;
- legacy snapshot incompleteness is explicitly marked rather than fabricated;
- package extraction introduces no runtime network dependency for Kinetix.

---

## 27. Recommended immediate next actions

The next implementation work should be deliberately boring. Do not start with schema extraction or a new repository.

### Action 1

Create the legacy contract-test matrix described in Phase 0, using the current behaviour as the specification.

### Action 2

Create `src/lib/knowledge-governance/` containing only pure types, assurance calculation, requirement primitives, and a Kinetix policy adapter exercised against the existing `consensusApprovalHoldReason` fixtures.

### Action 3

Create the `KnowledgeTargetAdapter` interface and implement a single read-only adapter for one existing target type, preferably `wiki_fact` or `paper_review`, without serving it to production callers.

### Action 4

Add the additive generic schema only after the pure contracts and adapter boundary are stable enough that table names represent real concepts rather than guesses.

### Action 5

Begin shadow mirroring and parity telemetry. Let production teach us where the abstraction leaks before any authoritative cutover.

That order is intentionally conservative. The project succeeds if Kinetix users barely notice the extraction happening while the underlying governance mechanics become cleaner, more auditable, and reusable.

---

## 28. Architectural principle to keep visible during implementation

The core boundary can be summarized in one sentence:

> **The governance engine decides whether a particular immutable proposal version has satisfied the rules required to change knowledge; the host application decides what that knowledge means and how an accepted change is applied.**

If new core code starts importing pharmacology definitions, TipTap fact helpers, Kinetix citation tables, or Kinetix role names, the boundary has slipped in the wrong direction.

If Kinetix begins requiring a remote governance service to stay online, the extraction has become operationally riskier than the system it replaced.

If a migration phase requires turning off the old path before the new path has been measured against it, the migration is moving too quickly.

The desired result is not a heroic rewrite. It is a controlled transplant in which Kinetix remains alive, observable, and reversible at every step while its governance system gradually becomes a reusable piece of infrastructure.
