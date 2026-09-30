-- Generic knowledge-governance schema (§5 of
-- docs/plans/2026-08-26-general-knowledge-governance-extraction.md, Phase 3).
--
-- Thirteen tables that can hold the governance history of any knowledge space,
-- Kinetix's included. They are **additive and inert**: nothing in Kinetix reads
-- or writes them yet, no existing column changes meaning, and no trigger fires
-- on an existing table. An old build served against this schema behaves
-- identically, which is the phase's whole safety property — and the rollback
-- is to leave the tables in place.
--
-- The `kg_` prefix is deliberate (§5): during the migration these must be
-- impossible to confuse with a Kinetix table at a glance.
--
-- Two design rules run through all of it:
--
--   * **Append-only where judgment lives.** A reviewer changing their mind
--     inserts a new assessment pointing at the old one; it never overwrites.
--     `agent_verifications` upserts today, which destroys exactly the history
--     an audit needs (§5.7).
--   * **Actors are references, not foreign keys.** `actor_ref` is a string like
--     `user:42`, not `INTEGER REFERENCES users(id)`. The core owns no
--     authentication (§4.2), a governed space may be reviewed by actors that
--     are not Kinetix users at all, and an immutable judgment must survive the
--     deletion of the account that made it.
--
-- Ids are `SERIAL`, matching every other table in this database rather than the
-- plan's "UUID/serial". The generic core addresses rows by string and
-- stringifies on the way in, so the choice stays a host decision.

-- §5.1 — one governed knowledge collection. Kinetix runs exactly one row here
-- (`kinetix`). Not multi-tenancy: the space exists so domain assumptions cannot
-- leak into primary keys and policy configuration (§4.3).
CREATE TABLE IF NOT EXISTS kg_spaces (
  id                    SERIAL PRIMARY KEY,
  slug                  VARCHAR(64) NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  -- The policy set version this space evaluates under, e.g.
  -- `kinetix-consensus@v1`. NULL while a space is being set up and has not
  -- adopted one; a decision record always names the version it used, so this
  -- is the current default, never retroactive.
  active_policy_version VARCHAR(120),
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- §5.2 — a stable generic handle on one host-domain object.
--
-- `target_key` is opaque to the core: `drug:123:param:halfLife`,
-- `wiki-page:991:fact:019...`, `paper-review:citation:8821`. Deliberately TEXT
-- rather than an integer domain id — requiring integer keys in the core is
-- exactly the assumption the space abstraction exists to prevent.
CREATE TABLE IF NOT EXISTS kg_targets (
  id          SERIAL PRIMARY KEY,
  space_id    INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  target_type VARCHAR(60) NOT NULL,
  target_key  TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Every column of the identity is NOT NULL above: Postgres treats NULLs as
-- distinct in a unique index, so one nullable member would silently disable the
-- constraint and let the same target in twice.
CREATE UNIQUE INDEX IF NOT EXISTS kg_targets_identity_idx
  ON kg_targets (space_id, target_type, target_key);
--> statement-breakpoint

-- §5.3 — stable identity of a proposed mutation across its revisions.
--
-- `state` and `current_version_id` are a materialized *projection* for cheap
-- reads. The authoritative history is in kg_proposal_versions,
-- kg_policy_decisions and kg_publication_events; if this row and those ever
-- disagree, those win.
CREATE TABLE IF NOT EXISTS kg_proposals (
  id                     SERIAL PRIMARY KEY,
  space_id               INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  target_id              INTEGER NOT NULL REFERENCES kg_targets(id) ON DELETE CASCADE,
  author_actor_ref       TEXT NOT NULL,
  author_kind            VARCHAR(16) NOT NULL,
  -- draft | pending | held | applied | returned | rejected | withdrawn |
  -- superseded. Varchar + a TS union at the edge, per this repo's convention
  -- (db/schema.ts): no native PG enums, so adding a state is a code change
  -- rather than a lock-taking DDL migration.
  state                  VARCHAR(20) NOT NULL DEFAULT 'draft',
  current_version_id     INTEGER,
  -- Nullable compatibility link, migration-only: the pending_edits row this
  -- proposal mirrors, where one exists. Not every proposal has one (a
  -- drug_parameter_revision is reviewed after the fact, with no pending edit),
  -- and none will once the generic path is authoritative.
  legacy_pending_edit_id INTEGER,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at              TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_proposals_target_idx
  ON kg_proposals (target_id, created_at);
--> statement-breakpoint

-- The review queue's shape: open proposals in a space, oldest first. Partial,
-- because a queue never asks about closed ones and the closed rows are the
-- ones that accumulate forever.
CREATE INDEX IF NOT EXISTS kg_proposals_open_idx
  ON kg_proposals (space_id, created_at)
  WHERE closed_at IS NULL;
--> statement-breakpoint

-- §5.4 — the immutable content snapshot reviewers actually judge.
--
-- A payload edit inserts a new row; a version that was ever visible to a
-- reviewer is never overwritten. That is what makes §8.3 structural rather
-- than procedural: an assessment names the version it judged, so a later
-- revision cannot inherit an earlier version's approvals.
CREATE TABLE IF NOT EXISTS kg_proposal_versions (
  id                  SERIAL PRIMARY KEY,
  proposal_id         INTEGER NOT NULL REFERENCES kg_proposals(id) ON DELETE CASCADE,
  version_no          INTEGER NOT NULL,
  -- The revision this change was written against, so a reviewer can tell
  -- whether the baseline moved underneath it.
  base_revision_ref   TEXT,
  payload             JSONB NOT NULL,
  payload_fingerprint VARCHAR(64) NOT NULL,
  author_actor_ref    TEXT NOT NULL,
  actor_kind          VARCHAR(16) NOT NULL,
  -- The risk classification in force when this version was created, snapshotted
  -- rather than re-derived: re-deriving would let a later change to the
  -- classifier silently restate what the reviewers were asked to judge.
  risk_profile        JSONB,
  -- Migration-only: the opaque version token the legacy queue handed out
  -- (`verificationTargetVersion`), so a legacy verdict can be matched to the
  -- generic version it was cast against.
  legacy_review_token TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  submitted_at        TIMESTAMP
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS kg_proposal_versions_identity_idx
  ON kg_proposal_versions (proposal_id, version_no);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_proposal_versions_fingerprint_idx
  ON kg_proposal_versions (payload_fingerprint);
--> statement-breakpoint

-- §5.5 — a reusable evidence object, independent of Kinetix's citation schema.
--
-- Kinetix maps `citations.id` in through `external_ref` plus a kg_legacy_links
-- row rather than copying every citation column: a second copy of citation
-- metadata is a second thing to keep correct.
CREATE TABLE IF NOT EXISTS kg_evidence_items (
  id           SERIAL PRIMARY KEY,
  space_id     INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  -- scientific_paper | web_page | document | dataset | code_test |
  -- expert_statement | regulatory_document | internal_record
  kind         VARCHAR(40) NOT NULL,
  external_ref TEXT,
  locator      JSONB,
  metadata     JSONB,
  content_hash VARCHAR(128),
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Partial: an evidence item with no external reference has nothing to look up
-- by, and NULLs would otherwise bloat the index.
CREATE INDEX IF NOT EXISTS kg_evidence_items_external_idx
  ON kg_evidence_items (space_id, kind, external_ref)
  WHERE external_ref IS NOT NULL;
--> statement-breakpoint

-- §5.6 — attaches evidence to a proposal version, assessment, dispute or
-- decision. Polymorphic by (subject_type, subject_id), the same pattern
-- `approvals` and `agent_verifications` already use in this database.
CREATE TABLE IF NOT EXISTS kg_evidence_links (
  id               SERIAL PRIMARY KEY,
  evidence_item_id INTEGER NOT NULL REFERENCES kg_evidence_items(id) ON DELETE CASCADE,
  subject_type     VARCHAR(40) NOT NULL,
  subject_id       INTEGER NOT NULL,
  -- supports | contradicts | source | method | context. `contradicts` is why
  -- this is a relation and not a flat list: evidence against a proposal is
  -- evidence, and a model that can only express support cannot hold a dispute's
  -- reasoning.
  relation         VARCHAR(24) NOT NULL,
  quote            TEXT,
  locator          JSONB,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_evidence_links_subject_idx
  ON kg_evidence_links (subject_type, subject_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_evidence_links_item_idx
  ON kg_evidence_links (evidence_item_id);
--> statement-breakpoint

-- §5.7 — immutable reviewer judgments.
--
-- The fix for the known limitation of `agent_verifications`: that table upserts
-- on (agent_id, target_type, target_id), so a reviewer changing its mind
-- destroys the judgment it previously published. Here a change is a new row
-- whose `supersedes_assessment_id` names the old one, and the current effective
-- judgment for an actor is its newest unsuperseded row.
--
-- `capability_snapshot` is captured at write time for the same reason
-- `agent_verifications.verifier_tier` is (migration 0113): reading a live
-- capability at tally time would let a later re-grant retroactively change what
-- past approvals were worth.
CREATE TABLE IF NOT EXISTS kg_assessments (
  id                        SERIAL PRIMARY KEY,
  space_id                  INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  subject_type              VARCHAR(40) NOT NULL,
  subject_id                INTEGER NOT NULL,
  actor_ref                 TEXT NOT NULL,
  actor_kind                VARCHAR(16) NOT NULL,
  -- approve | dispute | abstain
  verdict                   VARCHAR(16) NOT NULL,
  rationale_md              TEXT,
  capability_snapshot       JSONB,
  -- Self-reported model identity. Audit metadata only, never an input to
  -- policy (§2.3) — the server-owned capability snapshot above is what counts.
  model_metadata            JSONB,
  -- Reviewers sharing a group are not independent of each other (same
  -- operator, same base model, same prompt lineage). NULL means "no known
  -- shared lineage", which is the honest default rather than a claim.
  independence_group        VARCHAR(64),
  supersedes_assessment_id  INTEGER REFERENCES kg_assessments(id) ON DELETE SET NULL,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_assessments_subject_idx
  ON kg_assessments (subject_type, subject_id, created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_assessments_actor_idx
  ON kg_assessments (space_id, actor_ref, created_at);
--> statement-breakpoint

-- Finding the current effective judgment means finding rows nothing supersedes.
CREATE INDEX IF NOT EXISTS kg_assessments_supersedes_idx
  ON kg_assessments (supersedes_assessment_id)
  WHERE supersedes_assessment_id IS NOT NULL;
--> statement-breakpoint

-- §5.8 — stable dispute identity. `state` is a projection; the ruling history
-- below is authoritative.
CREATE TABLE IF NOT EXISTS kg_disputes (
  id                   SERIAL PRIMARY KEY,
  space_id             INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  subject_type         VARCHAR(40) NOT NULL,
  subject_id           INTEGER NOT NULL,
  opened_by_actor_ref  TEXT NOT NULL,
  opened_by_kind       VARCHAR(16) NOT NULL,
  reason_md            TEXT,
  -- open | resolved
  state                VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at            TIMESTAMP
);
--> statement-breakpoint

-- An open dispute blocks publication, so "are there open disputes on this
-- subject" is the hot question. Partial for the same reason as the proposal
-- queue index.
CREATE INDEX IF NOT EXISTS kg_disputes_open_idx
  ON kg_disputes (subject_type, subject_id)
  WHERE closed_at IS NULL;
--> statement-breakpoint

-- §5.9 — append-only ruling history. A dispute reopened and re-ruled gains a
-- row; it never edits the previous ruling.
CREATE TABLE IF NOT EXISTS kg_dispute_rulings (
  id           SERIAL PRIMARY KEY,
  dispute_id   INTEGER NOT NULL REFERENCES kg_disputes(id) ON DELETE CASCADE,
  -- upheld | overruled | withdrawn | superseded
  ruling       VARCHAR(20) NOT NULL,
  actor_ref    TEXT NOT NULL,
  rationale_md TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_dispute_rulings_dispute_idx
  ON kg_dispute_rulings (dispute_id, created_at);
--> statement-breakpoint

-- §5.10 — why the policy engine considered a version publishable or held.
--
-- Audit evidence, not a transient return value. `policy_version` is stored on
-- the row so a later policy change cannot retroactively imply that older
-- content was published under the new rule (§7.4), and `evaluation_mode`
-- records whether this decision actually governed anything: during migration
-- almost every row is `shadow`.
CREATE TABLE IF NOT EXISTS kg_policy_decisions (
  id                        SERIAL PRIMARY KEY,
  space_id                  INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  proposal_version_id       INTEGER NOT NULL REFERENCES kg_proposal_versions(id) ON DELETE CASCADE,
  policy_id                 VARCHAR(120) NOT NULL,
  policy_version            VARCHAR(40) NOT NULL,
  -- apply | hold | human_review | return | reject
  decision                  VARCHAR(20) NOT NULL,
  requirements              JSONB,
  satisfied_requirements    JSONB,
  unsatisfied_requirements  JSONB,
  input_fingerprint         VARCHAR(64) NOT NULL,
  -- shadow | advisory | authoritative
  evaluation_mode           VARCHAR(16) NOT NULL DEFAULT 'shadow',
  evaluated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_policy_decisions_version_idx
  ON kg_policy_decisions (proposal_version_id, evaluated_at);
--> statement-breakpoint

-- Reconciliation reads: "which shadow decisions disagreed with the legacy path
-- in this window".
CREATE INDEX IF NOT EXISTS kg_policy_decisions_mode_idx
  ON kg_policy_decisions (space_id, evaluation_mode, evaluated_at);
--> statement-breakpoint

-- §5.11 — what ultimately happened to a proposal version. Immutable.
CREATE TABLE IF NOT EXISTS kg_publication_events (
  id                   SERIAL PRIMARY KEY,
  proposal_version_id  INTEGER NOT NULL REFERENCES kg_proposal_versions(id) ON DELETE CASCADE,
  -- submitted | applied | returned | rejected | withdrawn
  action               VARCHAR(20) NOT NULL,
  actor_ref            TEXT NOT NULL,
  policy_decision_id   INTEGER REFERENCES kg_policy_decisions(id) ON DELETE SET NULL,
  -- The host's reference to what it wrote, e.g. `drug_parameter_revision:9912`.
  applied_revision_ref TEXT,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_publication_events_version_idx
  ON kg_publication_events (proposal_version_id, created_at);
--> statement-breakpoint

-- §5.12 — append-only operational audit for what does not fit the domain
-- tables. `actor_ref` is nullable here and only here: a system-generated event
-- has no actor, and inventing one would put a fabricated name in an audit log.
CREATE TABLE IF NOT EXISTS kg_audit_events (
  id           SERIAL PRIMARY KEY,
  space_id     INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  event_type   VARCHAR(60) NOT NULL,
  actor_ref    TEXT,
  subject_type VARCHAR(40) NOT NULL,
  subject_id   INTEGER NOT NULL,
  payload      JSONB,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_audit_events_subject_idx
  ON kg_audit_events (subject_type, subject_id, created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS kg_audit_events_space_idx
  ON kg_audit_events (space_id, event_type, created_at);
--> statement-breakpoint

-- §5.13 — the explicit mapping between a generic record and the Kinetix record
-- it mirrors. Migration-scoped, and the point of it is that parity debugging
-- is a join rather than a payload heuristic.
CREATE TABLE IF NOT EXISTS kg_legacy_links (
  id           SERIAL PRIMARY KEY,
  generic_type VARCHAR(40) NOT NULL,
  generic_id   INTEGER NOT NULL,
  legacy_type  VARCHAR(40) NOT NULL,
  legacy_id    INTEGER NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Unique in both directions: one generic record mirrors exactly one legacy
-- record and vice versa. Two links either way would make "which legacy row is
-- this?" ambiguous, which is the one question this table exists to answer.
CREATE UNIQUE INDEX IF NOT EXISTS kg_legacy_links_generic_idx
  ON kg_legacy_links (generic_type, generic_id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS kg_legacy_links_legacy_idx
  ON kg_legacy_links (legacy_type, legacy_id);
