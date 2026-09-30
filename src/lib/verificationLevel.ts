/**
 * Verification-level model shared by the API (which computes the level from
 * agent_verifications + approvals on a revision) and the UI (which surfaces the
 * level in a parameter's discussion + revision history rather than as an inline
 * badge). A live fact or parameter earns one of four levels:
 *
 *  - 0  no one has verified it — the value was imported from an external source
 *       or inherited from a pre-verification-system revision.
 *  - 1  verified by a single entity — a freshly added/edited value whose only
 *       endorsement is its submitter (submitting is itself a self-verification).
 *  - 2  verified by two or more agents (the submitter counts) but no human.
 *  - 3  verified by at least two agents *and* a human moderator.
 *
 * A `dispute` is orthogonal: it is surfaced separately from the 0–3 scale, so a
 * contested value shows both how much it has been approved and that it is
 * contested.
 *
 * ## Trusted self-review
 *
 * The scale counts **distinct agents**, which strands a deployment running one
 * agent the operator runs personally: everything it files sits at level 1
 * ("its author only") forever, because level 2 needs a second identity that
 * does not exist. That reads as weak evidence when the real situation is a
 * trusted agent that went back to the sources and re-verified its own claim.
 *
 * So a trusted self-review verdict counts as a second qualified verification.
 * This is deliberately counting one identity twice, and it is defensible for
 * exactly one reason: the two things being counted are different **acts**, not
 * one act counted twice. Submitting stamps a stake (the implicit-approve row);
 * re-verifying is a separate reasoned judgment against the sources, posted
 * later with a rationale. Ordinarily those two acts live in two rows and the
 * count picks them both up; for a self-reviewing agent they collapse onto one
 * `(agent, target)` row, and the bonus restores what the collapse hid.
 *
 * Two limits keep that from inflating anything else. It applies only to the
 * revision's **own author** — a trusted agent verifying a peer's work earns no
 * bonus, because there the peer's stake is already a separate row. And it is
 * off unless an admin turned on `agents.self_review_enabled` for that agent,
 * so the vouching is an operator's explicit act, not something an agent can
 * claim for itself. An unvetted agent that joins later gets none of this.
 */

export type VerificationLevel = 0 | 1 | 2 | 3;

export const VERIFICATION_LEVELS: readonly VerificationLevel[] = [0, 1, 2, 3];

export interface VerificationLevelInputs {
  /**
   * Distinct agents that have approved the live revision — the submitter's
   * implicit self-approval plus any peer agents that posted an explicit
   * `approve` verdict on it.
   */
  agentApprovers: number;
  /** Whether a non-agent (human) user has approved/stamped the live revision. */
  hasHumanApprover: boolean;
  /**
   * True when the revision's own author is a trusted self-review agent
   * (`agents.self_review_enabled`) that has posted an explicit, reasoned
   * `approve` verdict on it — a review distinct from the submit-time stake,
   * which shares its row. See the trusted-self-review note above.
   */
  authorSelfVerified?: boolean;
}

/**
 * Map the verifier tally of a live revision onto the 0–3 scale. Disputes are
 * handled separately by the caller and never lower the level here.
 */
export function computeVerificationLevel(
  inputs: VerificationLevelInputs,
): VerificationLevel {
  const { agentApprovers, hasHumanApprover, authorSelfVerified } = inputs;
  // The author's re-verification is the second act its single row collapsed;
  // adding it here rather than in the caller's tally keeps "how many rows
  // exist" and "how many verifications happened" from being confused upstream.
  const verifications = agentApprovers + (authorSelfVerified ? 1 : 0);
  if (verifications === 0 && !hasHumanApprover) return 0;
  if (verifications >= 2 && hasHumanApprover) return 3;
  if (verifications >= 2) return 2;
  return 1;
}

/** Verification state of one live fact or parameter, as served to the UI. */
export interface VerificationLevelInfo {
  level: VerificationLevel;
  /** True when at least one agent currently disputes the live revision. */
  disputed: boolean;
}

/**
 * i18n key for each level's descriptive label. Surfaced as plain text in a
 * parameter's discussion panel and revision-history dialog — the review status
 * lives there now instead of as an inline badge on every parameter row.
 */
export const VERIFICATION_LEVEL_LABEL_KEYS: Record<VerificationLevel, string> = {
  0: 'verification.level.0',
  1: 'verification.level.1',
  2: 'verification.level.2',
  3: 'verification.level.3',
};

/** i18n key for the "an agent disputes this value" note. */
export const VERIFICATION_DISPUTE_LABEL_KEY = 'verification.disputed';
