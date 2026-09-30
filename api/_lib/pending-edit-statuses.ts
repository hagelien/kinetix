/**
 * The pending-edit statuses in which a proposal can still be approved or
 * resubmitted: `pending`, and `draft` / `returned`, which are one resubmission
 * away from it. "Active" for every scan, rewrite, conflict marking and refusal
 * that must reach a proposal before it can publish — a stale reference left
 * on a draft is exactly as live as one on a pending row. Defined once (Cmax
 * RFC owner review, amendment 7) rather than restated as SQL literals.
 */
export const ACTIVE_PENDING_EDIT_STATUSES = ['pending', 'draft', 'returned'] as const;
