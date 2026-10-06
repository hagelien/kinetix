/**
 * Generic knowledge-governance schema (`kg_*`).
 *
 * Split out of `db/schema.ts` so the governance store can import its tables
 * without importing Kinetix's. §14 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md gives the
 * `postgres` package the rule "schema/store implementation, migrations,
 * reconciliation helpers, **no Kinetix tables**" — and while these definitions
 * shared a module with `drugs`, `wiki_pages` and every other Kinetix table,
 * extracting the store would have dragged the whole pharmacology schema with
 * it. `tests/governance/packaging/boundaries.test.ts` recorded that as the one
 * blocker; this is the split it named.
 *
 * **This module must never import from `./schema.js`.** The dependency runs one
 * way: `schema.ts` re-exports everything here so existing importers are
 * unaffected, and nothing here knows Kinetix exists. A back-reference would
 * quietly restore the coupling the split removed, and the boundary test asserts
 * against it.
 *
 * That the split was possible at all is a consequence of a Phase 3 decision
 * rather than luck: actors are referenced as strings (`user:42`), never by
 * foreign key, so no `kg_*` table points at `users` — or at any other Kinetix
 * table. The reasons given at the time were that the core owns no
 * authentication, that a governed space may be reviewed by actors who are not
 * Kinetix users, and that an immutable judgment must survive the deletion of
 * the account that made it. Clean extractability was not among them, and is
 * what that decision bought anyway.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';

// ─── Generic knowledge governance (kg_*) ─────────────────────────────────────
//
// §5 of docs/plans/2026-08-26-general-knowledge-governance-extraction.md,
// added by drizzle/0114_knowledge_governance_schema.sql (Phase 3).
//
// Thirteen tables that can hold the governance history of any knowledge space.
// Nothing in Kinetix reads or writes them yet — they are additive and inert,
// and an old build served against this schema behaves identically. That
// inertness is the phase's safety property, and the rollback is to leave them
// in place.
//
// Two rules run through all of it:
//
//   * **Append-only where judgment lives.** A reviewer changing their mind
//     inserts a new assessment naming the old one; it never overwrites.
//     `agent_verifications` upserts today, destroying exactly the history an
//     audit needs.
//   * **Actors are references, not foreign keys.** `actorRef` is a string like
//     `user:42`. The core owns no authentication, a governed space may be
//     reviewed by actors that are not Kinetix users, and an immutable judgment
//     must survive the deletion of the account that made it.

/** §5.1 — one governed knowledge collection. Kinetix runs exactly one: `kinetix`. */
export const kgSpaces = pgTable('kg_spaces', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: text('name').notNull(),
  /** e.g. `kinetix-consensus@v2`. The current default, never retroactive. */
  activePolicyVersion: varchar('active_policy_version', { length: 120 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * §5.2 — a stable generic handle on one host-domain object.
 *
 * `targetKey` is opaque to the core (`drug:123:param:halfLife`,
 * `paper-review:citation:8821`) and is TEXT rather than an integer domain id:
 * requiring integer keys in the core is the assumption the space abstraction
 * exists to prevent.
 */
export const kgTargets = pgTable(
  'kg_targets',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    targetType: varchar('target_type', { length: 60 }).notNull(),
    targetKey: text('target_key').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('kg_targets_identity_idx').on(
      t.spaceId,
      t.targetType,
      t.targetKey,
    ),
  ],
);

/**
 * §5.3 — stable identity of a proposed mutation across its revisions.
 *
 * `state` and `currentVersionId` are a materialized projection for cheap reads;
 * the authoritative history is in `kgProposalVersions`, `kgPolicyDecisions` and
 * `kgPublicationEvents`. If this row disagrees with those, those win.
 */
export const kgProposals = pgTable(
  'kg_proposals',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    targetId: integer('target_id')
      .references(() => kgTargets.id, { onDelete: 'cascade' })
      .notNull(),
    authorActorRef: text('author_actor_ref').notNull(),
    authorKind: varchar('author_kind', { length: 16 }).notNull(),
    state: varchar('state', { length: 20 }).notNull().default('draft'),
    currentVersionId: integer('current_version_id'),
    /** Migration-only compatibility link; not every proposal has one. */
    legacyPendingEditId: integer('legacy_pending_edit_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    closedAt: timestamp('closed_at'),
  },
  (t) => [
    index('kg_proposals_target_idx').on(t.targetId, t.createdAt),
    index('kg_proposals_open_idx')
      .on(t.spaceId, t.createdAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

/**
 * §5.4 — the immutable content snapshot reviewers actually judge.
 *
 * A payload edit inserts a new row; a version that was ever visible to a
 * reviewer is never overwritten. That makes version-bound assessment (§8.3)
 * structural: an assessment names the version it judged, so a later revision
 * cannot inherit an earlier version's approvals.
 */
export const kgProposalVersions = pgTable(
  'kg_proposal_versions',
  {
    id: serial('id').primaryKey(),
    proposalId: integer('proposal_id')
      .references(() => kgProposals.id, { onDelete: 'cascade' })
      .notNull(),
    versionNo: integer('version_no').notNull(),
    baseRevisionRef: text('base_revision_ref'),
    payload: jsonb('payload').notNull(),
    payloadFingerprint: varchar('payload_fingerprint', { length: 64 }).notNull(),
    authorActorRef: text('author_actor_ref').notNull(),
    actorKind: varchar('actor_kind', { length: 16 }).notNull(),
    /** Snapshotted, not re-derived: a later classifier change must not restate
     * what reviewers were asked to judge. */
    riskProfile: jsonb('risk_profile'),
    /** Migration-only: the legacy `verificationTargetVersion` token. */
    legacyReviewToken: text('legacy_review_token'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    submittedAt: timestamp('submitted_at'),
  },
  (t) => [
    uniqueIndex('kg_proposal_versions_identity_idx').on(
      t.proposalId,
      t.versionNo,
    ),
    index('kg_proposal_versions_fingerprint_idx').on(t.payloadFingerprint),
  ],
);

/**
 * §5.5 — a reusable evidence object, independent of Kinetix's citation schema.
 *
 * Kinetix maps `citations.id` in through `externalRef` plus a `kgLegacyLinks`
 * row rather than copying citation columns: a second copy of that metadata is a
 * second thing to keep correct.
 */
export const kgEvidenceItems = pgTable(
  'kg_evidence_items',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    kind: varchar('kind', { length: 40 }).notNull(),
    externalRef: text('external_ref'),
    locator: jsonb('locator'),
    metadata: jsonb('metadata'),
    contentHash: varchar('content_hash', { length: 128 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('kg_evidence_items_external_idx')
      .on(t.spaceId, t.kind, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
  ],
);

/**
 * §5.6 — attaches evidence to a proposal version, assessment, dispute or
 * decision. `contradicts` is why this is a relation and not a flat list:
 * evidence against a proposal is evidence, and a model that can only express
 * support cannot hold a dispute's reasoning.
 */
export const kgEvidenceLinks = pgTable(
  'kg_evidence_links',
  {
    id: serial('id').primaryKey(),
    evidenceItemId: integer('evidence_item_id')
      .references(() => kgEvidenceItems.id, { onDelete: 'cascade' })
      .notNull(),
    subjectType: varchar('subject_type', { length: 40 }).notNull(),
    subjectId: integer('subject_id').notNull(),
    relation: varchar('relation', { length: 24 }).notNull(),
    quote: text('quote'),
    locator: jsonb('locator'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('kg_evidence_links_subject_idx').on(t.subjectType, t.subjectId),
    index('kg_evidence_links_item_idx').on(t.evidenceItemId),
  ],
);

/**
 * §5.7 — immutable reviewer judgments.
 *
 * The fix for the known limitation of `agent_verifications`, which upserts on
 * (agent_id, target_type, target_id) and so destroys the judgment a reviewer
 * previously published. Here a change of mind is a new row whose
 * `supersedesAssessmentId` names the old one; the current effective judgment
 * for an actor is its newest unsuperseded row.
 *
 * `capabilitySnapshot` is captured at write time for the same reason
 * `agentVerifications.verifierTier` is: reading a live capability at tally time
 * would let a later re-grant retroactively change what past approvals were
 * worth.
 */
export const kgAssessments = pgTable(
  'kg_assessments',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    subjectType: varchar('subject_type', { length: 40 }).notNull(),
    subjectId: integer('subject_id').notNull(),
    actorRef: text('actor_ref').notNull(),
    actorKind: varchar('actor_kind', { length: 16 }).notNull(),
    verdict: varchar('verdict', { length: 16 }).notNull(),
    rationaleMd: text('rationale_md'),
    capabilitySnapshot: jsonb('capability_snapshot'),
    /** Self-reported model identity. Audit metadata only, never a policy input. */
    modelMetadata: jsonb('model_metadata'),
    /** NULL means "no known shared lineage" — the honest default, not a claim. */
    independenceGroup: varchar('independence_group', { length: 64 }),
    supersedesAssessmentId: integer('supersedes_assessment_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.supersedesAssessmentId],
      foreignColumns: [t.id],
      name: 'kg_assessments_supersedes_assessment_id_fkey',
    }).onDelete('set null'),
    index('kg_assessments_subject_idx').on(
      t.subjectType,
      t.subjectId,
      t.createdAt,
    ),
    index('kg_assessments_actor_idx').on(t.spaceId, t.actorRef, t.createdAt),
    index('kg_assessments_supersedes_idx')
      .on(t.supersedesAssessmentId)
      .where(sql`${t.supersedesAssessmentId} is not null`),
  ],
);

/** §5.8 — stable dispute identity. `state` is a projection; the rulings are authoritative. */
export const kgDisputes = pgTable(
  'kg_disputes',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    subjectType: varchar('subject_type', { length: 40 }).notNull(),
    subjectId: integer('subject_id').notNull(),
    openedByActorRef: text('opened_by_actor_ref').notNull(),
    openedByKind: varchar('opened_by_kind', { length: 16 }).notNull(),
    reasonMd: text('reason_md'),
    state: varchar('state', { length: 20 }).notNull().default('open'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    closedAt: timestamp('closed_at'),
  },
  (t) => [
    index('kg_disputes_open_idx')
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.closedAt} is null`),
  ],
);

/** §5.9 — append-only ruling history. A re-ruling gains a row; it never edits one. */
export const kgDisputeRulings = pgTable(
  'kg_dispute_rulings',
  {
    id: serial('id').primaryKey(),
    disputeId: integer('dispute_id')
      .references(() => kgDisputes.id, { onDelete: 'cascade' })
      .notNull(),
    ruling: varchar('ruling', { length: 20 }).notNull(),
    actorRef: text('actor_ref').notNull(),
    rationaleMd: text('rationale_md'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('kg_dispute_rulings_dispute_idx').on(t.disputeId, t.createdAt)],
);

/**
 * §5.10 — why the policy engine considered a version publishable or held.
 *
 * Audit evidence, not a transient return value. `policyVersion` is stored on
 * the row so a later policy change cannot retroactively imply older content was
 * published under the new rule; `evaluationMode` records whether the decision
 * actually governed anything — during migration almost every row is `shadow`.
 */
export const kgPolicyDecisions = pgTable(
  'kg_policy_decisions',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    proposalVersionId: integer('proposal_version_id')
      .references(() => kgProposalVersions.id, { onDelete: 'cascade' })
      .notNull(),
    policyId: varchar('policy_id', { length: 120 }).notNull(),
    policyVersion: varchar('policy_version', { length: 40 }).notNull(),
    decision: varchar('decision', { length: 20 }).notNull(),
    requirements: jsonb('requirements'),
    satisfiedRequirements: jsonb('satisfied_requirements'),
    unsatisfiedRequirements: jsonb('unsatisfied_requirements'),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    evaluationMode: varchar('evaluation_mode', { length: 16 })
      .notNull()
      .default('shadow'),
    evaluatedAt: timestamp('evaluated_at').defaultNow().notNull(),
  },
  (t) => [
    index('kg_policy_decisions_version_idx').on(
      t.proposalVersionId,
      t.evaluatedAt,
    ),
    index('kg_policy_decisions_mode_idx').on(
      t.spaceId,
      t.evaluationMode,
      t.evaluatedAt,
    ),
  ],
);

/** §5.11 — what ultimately happened to a proposal version. Immutable. */
export const kgPublicationEvents = pgTable(
  'kg_publication_events',
  {
    id: serial('id').primaryKey(),
    proposalVersionId: integer('proposal_version_id')
      .references(() => kgProposalVersions.id, { onDelete: 'cascade' })
      .notNull(),
    action: varchar('action', { length: 20 }).notNull(),
    actorRef: text('actor_ref').notNull(),
    policyDecisionId: integer('policy_decision_id').references(
      () => kgPolicyDecisions.id,
      { onDelete: 'set null' },
    ),
    /** The host's reference to what it wrote, e.g. `drug_parameter_revision:9912`. */
    appliedRevisionRef: text('applied_revision_ref'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('kg_publication_events_version_idx').on(
      t.proposalVersionId,
      t.createdAt,
    ),
  ],
);

/**
 * §5.12 — append-only operational audit for what does not fit the domain
 * tables. `actorRef` is nullable here and only here: a system-generated event
 * has no actor, and inventing one would put a fabricated name in an audit log.
 */
export const kgAuditEvents = pgTable(
  'kg_audit_events',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    eventType: varchar('event_type', { length: 60 }).notNull(),
    actorRef: text('actor_ref'),
    subjectType: varchar('subject_type', { length: 40 }).notNull(),
    subjectId: integer('subject_id').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('kg_audit_events_subject_idx').on(
      t.subjectType,
      t.subjectId,
      t.createdAt,
    ),
    index('kg_audit_events_space_idx').on(
      t.spaceId,
      t.eventType,
      t.createdAt,
    ),
  ],
);

/**
 * §5.13 — the explicit mapping between a generic record and the Kinetix record
 * it mirrors. Unique in both directions: two links either way would make "which
 * legacy row is this?" ambiguous, which is the one question this table answers.
 */
export const kgLegacyLinks = pgTable(
  'kg_legacy_links',
  {
    id: serial('id').primaryKey(),
    genericType: varchar('generic_type', { length: 40 }).notNull(),
    genericId: integer('generic_id').notNull(),
    legacyType: varchar('legacy_type', { length: 40 }).notNull(),
    legacyId: integer('legacy_id').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('kg_legacy_links_generic_idx').on(t.genericType, t.genericId),
    uniqueIndex('kg_legacy_links_legacy_idx').on(t.legacyType, t.legacyId),
  ],
);

export type KgSpace = typeof kgSpaces.$inferSelect;
export type NewKgSpace = typeof kgSpaces.$inferInsert;
export type KgTarget = typeof kgTargets.$inferSelect;
export type NewKgTarget = typeof kgTargets.$inferInsert;
export type KgProposal = typeof kgProposals.$inferSelect;
export type NewKgProposal = typeof kgProposals.$inferInsert;
export type KgProposalVersion = typeof kgProposalVersions.$inferSelect;
export type NewKgProposalVersion = typeof kgProposalVersions.$inferInsert;
export type KgEvidenceItem = typeof kgEvidenceItems.$inferSelect;
export type NewKgEvidenceItem = typeof kgEvidenceItems.$inferInsert;
export type KgEvidenceLink = typeof kgEvidenceLinks.$inferSelect;
export type NewKgEvidenceLink = typeof kgEvidenceLinks.$inferInsert;
export type KgAssessment = typeof kgAssessments.$inferSelect;
export type NewKgAssessment = typeof kgAssessments.$inferInsert;
export type KgDispute = typeof kgDisputes.$inferSelect;
export type NewKgDispute = typeof kgDisputes.$inferInsert;
export type KgDisputeRuling = typeof kgDisputeRulings.$inferSelect;
export type NewKgDisputeRuling = typeof kgDisputeRulings.$inferInsert;
export type KgPolicyDecision = typeof kgPolicyDecisions.$inferSelect;
export type NewKgPolicyDecision = typeof kgPolicyDecisions.$inferInsert;
export type KgPublicationEvent = typeof kgPublicationEvents.$inferSelect;
export type NewKgPublicationEvent = typeof kgPublicationEvents.$inferInsert;
export type KgAuditEvent = typeof kgAuditEvents.$inferSelect;
export type NewKgAuditEvent = typeof kgAuditEvents.$inferInsert;
export type KgLegacyLink = typeof kgLegacyLinks.$inferSelect;
export type NewKgLegacyLink = typeof kgLegacyLinks.$inferInsert;

/** Materialized current-state projection of a proposal (§5.3). */
export type KgProposalState =
  | 'draft'
  | 'pending'
  | 'held'
  | 'applied'
  | 'returned'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

/** §5.7. Same vocabulary as `AgentVerificationVerdict`, deliberately. */
export type KgVerdict = 'approve' | 'dispute' | 'abstain';

/** §5.10 — what the policy engine concluded. */
export type KgPolicyDecisionOutcome =
  | 'apply'
  | 'hold'
  | 'human_review'
  | 'return'
  | 'reject';

/**
 * §5.10 — whether a decision governed anything. `shadow` is recorded but never
 * acted on; `advisory` is surfaced to a human; only `authoritative` decides.
 * During the migration almost every row is `shadow` (§11.2).
 */
export type KgEvaluationMode = 'shadow' | 'advisory' | 'authoritative';

/** §5.9. */
export type KgDisputeRulingKind =
  | 'upheld'
  | 'overruled'
  | 'withdrawn'
  | 'superseded';

/** §5.11. */
export type KgPublicationAction =
  | 'submitted'
  | 'applied'
  | 'returned'
  | 'rejected'
  | 'withdrawn';

/** §5.6. */
export type KgEvidenceRelation =
  | 'supports'
  | 'contradicts'
  | 'source'
  | 'method'
  | 'context';

/**
 * §11.1 — the per-target migration control plane, added by
 * `drizzle/0115_knowledge_governance_migration_state.sql` (Phase 4).
 *
 * One row per `(space, target_type)`. **A missing row means `legacy_only`**: a
 * target nobody has explicitly advanced does not participate in the generic
 * path, so adding a new target type never silently opts it in. Absence of a
 * decision is the conservative decision.
 *
 * `updatedBy` carries a `users.id` with no foreign key, for the same reason the
 * other `kg_*` tables reference actors by string: an audit fact must not become
 * erasable by deleting an account.
 */
export const kgMigrationState = pgTable(
  'kg_migration_state',
  {
    id: serial('id').primaryKey(),
    spaceId: integer('space_id')
      .references(() => kgSpaces.id, { onDelete: 'cascade' })
      .notNull(),
    targetType: varchar('target_type', { length: 60 }).notNull(),
    mode: varchar('mode', { length: 40 }).notNull().default('legacy_only'),
    updatedBy: integer('updated_by'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('kg_migration_state_identity_idx').on(t.spaceId, t.targetType),
  ],
);

export type KgMigrationStateRow = typeof kgMigrationState.$inferSelect;
export type NewKgMigrationStateRow = typeof kgMigrationState.$inferInsert;

/**
 * §11.2, in order of how much authority the generic path holds. A target moves
 * forward only on explicit parity-gate evidence, and may always move back while
 * legacy compatibility is installed (§11.4).
 */
export type KgMigrationMode =
  | 'legacy_only'
  | 'shadow'
  | 'compare'
  | 'generic_read'
  | 'legacy_write_generic_mirror'
  | 'generic_authoritative';
