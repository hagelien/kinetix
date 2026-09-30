/**
 * The host-owned target adapter contract (§4.4 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 2's whole purpose is to move the `switch (targetType)` blocks out of
 * the conceptual core and behind one interface, *before* any storage changes.
 * The division of labour is the plan's one-sentence principle (§28):
 *
 *   > The governance engine decides whether a particular immutable proposal
 *   > version has satisfied the rules required to change knowledge; the host
 *   > application decides what that knowledge means and how an accepted change
 *   > is applied.
 *
 * So `apply()` lives here, in the host, and never in the core. The core never
 * learns how to update a drug parameter or mutate TipTap content.
 *
 * Nothing in this file touches the database. It is the shape adapters fill in;
 * `adapters/kinetix/` holds the Kinetix implementations, which delegate to the
 * existing proven Kinetix reads rather than reimplementing them.
 */

import type {
  ActorContext,
  EvidenceRequirement,
  ProposalVersionRef,
  ReviewPacket,
  RiskProfile,
  SpaceId,
  TargetRef,
  TargetType,
} from 'assurance-core';

/**
 * An immutable proposed change, as the governance layer sees it.
 *
 * Kinetix has no `kg_proposal_versions` table yet (that is Phase 3), so during
 * Phase 2 a version is *projected* from whichever legacy row is the unit of
 * review — a `drug_parameter_revisions` row, a `pending_edits` row, and so on.
 * The projection is the adapter's job; everything above it sees only this.
 */
export interface ProposalVersion {
  readonly ref: ProposalVersionRef;
  readonly target: TargetRef;
  /**
   * The host's opaque payload for this version. The core never inspects it;
   * only the owning adapter knows its shape.
   */
  readonly payload: unknown;
  /**
   * The version token the legacy stale-verdict check compares against
   * (`verificationTargetVersion`). Carried verbatim so an adapter-built packet
   * and a legacy queue row hand a reviewer the same token.
   */
  readonly targetVersion: string;
  /** ISO-8601. The queue's cross-type ordering key. */
  readonly createdAt: string;
  /** `user:<users.id>` of the submitter, or `null` when the row has no author. */
  readonly authorRef: string | null;
}

/**
 * One row a target type could put in front of a reviewer, stripped to what the
 * generic eligibility rules need (Phase 5).
 *
 * Deliberately thin. The legacy queue answers "who may review this?" inside
 * each per-type branch, so the author-exclusion and already-reviewed rules are
 * written out five times and can drift five different ways. Here a target type
 * supplies only identity, age, authorship and its own visibility rule; every
 * rule that is the *same* for every type is applied once, generically, above.
 *
 * `visible` is the exception, and it has to be: whether a row may be shown at
 * all is domain knowledge (an unpublished wiki page, a topic-page comment with
 * no drug), and the generic layer has no way to derive it.
 */
export interface QueueCandidate {
  readonly targetType: TargetType;
  readonly targetId: number;
  /** ISO-8601. The age and cross-type ordering key. */
  readonly createdAt: string;
  /** `users.id` of the author, or `null` where the row records none. */
  readonly authorUserId: number | null;
  /** False for a row this target type must never show a reviewer. */
  readonly visible: boolean;
}

/** Why a proposal cannot be accepted in the form it was submitted. */
export interface ValidationIssue {
  /** Stable machine code, e.g. `parameter_not_applicable`. */
  readonly code: string;
  readonly message: string;
  /** Dotted path into the payload, when the issue is about one field. */
  readonly path?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export function validationOk(): ValidationResult {
  return { valid: true, issues: [] };
}

export function validationFailed(
  issues: readonly ValidationIssue[],
): ValidationResult {
  // An empty issue list with `valid: false` would be a decision nobody can
  // explain, which is exactly what this layer exists to prevent.
  if (issues.length === 0) {
    throw new Error(
      'knowledge-governance: validationFailed() requires at least one issue',
    );
  }
  return { valid: false, issues };
}

/**
 * One piece of evidence a proposal must carry before it may publish.
 *
 * Generic on purpose (§9.1): the core knows an evidence requirement is
 * satisfied or not, never that "satisfied" means a PubMed-indexed citation
 * whose PDF is on file. `kind` is the host's vocabulary.
 */
// `EvidenceRequirement` used to be declared here and is now the package's:
// the review packet that carries it lives there, so a second declaration would
// be two shapes that must agree by hand.
export type { EvidenceRequirement };

/** The publication verdict handed to `apply()`. */
export interface PublicationDecision {
  readonly allowed: boolean;
  readonly policyId: string;
  readonly policyVersion: string;
  /** Why it was withheld, when it was. */
  readonly holdReason: string | null;
}

/** What the host wrote when a decision was applied. */
export interface AppliedRevisionRef {
  readonly target: TargetRef;
  /** The host's id for the row it created/updated, stringified. */
  readonly revisionId: string;
  readonly appliedAt: string;
}

/**
 * The ambient transaction an `apply()` runs inside.
 *
 * Deliberately opaque: the core hands it through untouched, and only the host
 * adapter knows it is a Drizzle transaction. Typing it as the real Drizzle
 * transaction here would drag the ORM into a contract the core imports.
 * §12.3.1's `inTransaction()` fills this in properly in a later phase.
 */
export type GovernanceTransaction = unknown;

/**
 * A host-owned adapter for one kind of governed object.
 *
 * `TProposal` and `TCurrent` are the adapter's private payload types; the
 * registry stores adapters under their erased form, so callers that route by
 * `type` see `unknown` and only the adapter itself sees the real shapes.
 */
export interface KnowledgeTargetAdapter<TProposal = unknown, TCurrent = unknown> {
  readonly space: SpaceId;
  readonly type: TargetType;

  /** Read the object as it stands today, or `null` when it does not exist yet. */
  loadCurrent(target: TargetRef): Promise<TCurrent | null>;

  /**
   * Project the legacy row a `TargetRef` names into a `ProposalVersion`.
   *
   * Not in the plan's §4.4 sketch because that sketch assumes
   * `kg_proposal_versions` already exists and the version is handed in. It does
   * not yet — Phase 3 adds it — so during Phase 2 the adapter is the only thing
   * that knows which legacy table is the unit of review for its type and how to
   * read one. When the generic store lands, this becomes a read from it and
   * every caller above keeps the same shape.
   *
   * Returns `null` when the row does not exist, or when it is not visible to
   * reviewers at all (an unpublished wiki page, say) — the same rule the legacy
   * queue applies in SQL. That default is deliberate: this feeds
   * `buildReviewPacket`, and a reviewer-facing caller that forgot to filter
   * would disclose draft content to a contributor-level agent.
   *
   * `includeHidden` lifts the visibility filter, and only two kinds of caller
   * may pass it: the shadow mirror and the reconciliation scanner. Governance
   * *history* has to be complete regardless of who may read the content — a
   * `wiki_new` proposal that never appears in a queue still happened, and
   * excluding it would make every one of them a permanent
   * `missing_proposal` finding. Anything that builds a packet for a reviewer
   * must leave it unset.
   */
  loadVersion(
    target: TargetRef,
    opts?: { includeHidden?: boolean },
  ): Promise<ProposalVersion | null>;

  validateProposal(args: {
    proposal: TProposal;
    current: TCurrent | null;
    actor: ActorContext;
  }): Promise<ValidationResult>;

  /**
   * Stable content hash of "this proposal against this baseline". Equal
   * fingerprints mean an identical proposed change; the core only ever
   * compares them for equality.
   */
  fingerprint(args: {
    proposal: TProposal;
    current: TCurrent | null;
  }): Promise<string> | string;

  /**
   * The sealed snapshot an independent reviewer receives (§8.1). Adapters must
   * not put peer verdicts or approval counts in it — `sealReviewPacket()`
   * enforces that at runtime rather than trusting every adapter to remember.
   */
  buildReviewPacket(args: {
    version: ProposalVersion;
    actor: ActorContext;
  }): Promise<ReviewPacket>;

  classifyRisk(args: {
    version: ProposalVersion;
    current: TCurrent | null;
  }): Promise<RiskProfile>;

  evidenceRequirements(args: {
    version: ProposalVersion;
    actor: ActorContext;
    risk: RiskProfile;
  }): Promise<readonly EvidenceRequirement[]>;

  /**
   * List rows of this type that could be put in front of a reviewer.
   *
   * Optional: a target type that is defined but not served (
   * `learning_unit_revision`) has no queue to contribute to, and a stub
   * returning nothing would be indistinguishable from a broken query.
   *
   * Implementations apply only their own *visibility* rule and their own
   * ordering key. They must NOT filter on the caller, on age, or on what has
   * already been reviewed — those rules are generic, and an adapter that
   * applied one would be the fifth copy of it that this phase exists to remove.
   *
   * Because those rules run after this read, the selector may ask again with
   * a larger `limit` when a window held too few eligible rows. The listing
   * must therefore be a stable prefix: order on the ordering key *and then on
   * the row id*, so the first n rows of a larger window are the n rows of the
   * smaller one.
   */
  listQueueCandidates?(args: {
    /** Rows older than this are eligible; the caller has already applied the delay. */
    olderThan: Date;
    /** Upper bound on rows returned, before generic filtering. */
    limit: number;
  }): Promise<readonly QueueCandidate[]>;

  /**
   * Write the accepted change. Optional during the migration: a target type
   * whose publication still runs entirely through legacy route logic has
   * nothing to put here yet, and a stub that pretended to apply would be worse
   * than an honest absence.
   */
  apply?(args: {
    version: ProposalVersion;
    decision: PublicationDecision;
    actor: ActorContext;
    tx: GovernanceTransaction;
  }): Promise<AppliedRevisionRef>;
}

/** Adapter with its payload types erased, as the registry stores it. */
export type AnyKnowledgeTargetAdapter = KnowledgeTargetAdapter<unknown, unknown>;
