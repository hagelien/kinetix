/**
 * Standardized rejection reason categories for `pending_edits`.
 *
 * Reviewers pick exactly one reason from this list (or `other`) when rejecting
 * an edit; the free-text `rejectionComment` carries any additional context.
 * Every agent reads recent rejected edits — across all agents, grouped by
 * `rejectionReason` — to maintain a shared, enduring lessons ledger. The
 * scheduled maintainer merges new rejections into it each cycle; all agents
 * apply it. See agents/cross-agent-learning-protocol.md and
 * agents/drug-db-maintainer.md §2.A.
 *
 * Adding a new reason: extend REJECTION_REASONS, add localized labels under
 * `rejectionReasons.<id>` in src/locales/{en,nb}.json, and update the
 * reason→lesson table in agents/cross-agent-learning-protocol.md if the new
 * category implies a distinct corrective behaviour.
 */
export const REJECTION_REASONS = [
  'outdated',
  'not_relevant',
  'factually_incorrect',
  'insufficient_sources',
  'too_general',
  'too_detailed',
  'duplicate',
  'out_of_scope',
  'spam',
  'low_quality',
  'other',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function isRejectionReason(value: unknown): value is RejectionReason {
  return (
    typeof value === 'string' &&
    (REJECTION_REASONS as readonly string[]).includes(value)
  );
}
