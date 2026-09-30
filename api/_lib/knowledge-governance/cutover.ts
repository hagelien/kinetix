/**
 * Which edit types the generic engine is actually allowed to decide (Phase 8 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phases 4-7 keyed migration state on the *verification target type*
 * (`pending_edit`, `wiki_revision`, …). That is the right granularity for
 * mirroring and reads, and the wrong one for an authoritative cutover: one
 * `pending_edit` row can be a wiki fact, a drug parameter, a metabolism
 * profile or a clinical case, and §1.4's own example is explicit that
 * migration state is tracked per knowledge-object type —
 * `wiki_fact -> generic_read` sitting beside `parameter -> legacy_only`.
 *
 * So authority is keyed one level finer, on `pending_edit:<editType>`, and is
 * governed by two independent locks. Both must be open.
 *
 * ## Lock 1 — authority is never inherited
 *
 * `resolveApplyAuthority` reads the edit-type key and *only* that key. It does
 * not fall back to `pending_edit`, and this is the whole point: a fallback
 * would mean advancing the coarse key to `generic_authoritative` silently
 * carried every one of the thirteen edit types with it, including
 * `clinical_case`, which Kinetix refuses to auto-publish at all. A missing row
 * resolves to `legacy_only`, so the default for anything nobody has considered
 * is the legacy path.
 *
 * Mirroring and reads keep reading the coarse key exactly as they do today.
 * Nothing about Phases 4-7 changes here.
 *
 * ## Lock 2 — a code-level eligibility list
 *
 * A stored mode alone is not enough: the edit type must also appear in
 * `CUTOVER_ELIGIBLE_EDIT_TYPES`. §11.4 says automated deployment must not
 * advance migration state; this is the converse guard, so that a hand-edited or
 * mistaken row cannot advance a type whose phase has not been reached and whose
 * parity evidence does not exist. Widening the list is a reviewed code change.
 *
 * It only ever restricts *advancing*. Retreating stays a runtime operation:
 * roll the row back, or set the kill switch, and authority is gone on the next
 * read without a deploy.
 */

import {
  isGenericAuthoritative,
  resolveMigrationMode,
} from './migration-state.js';
import type { GovernanceDb } from './store/interface.js';

/**
 * Edit types this build will let the generic engine decide, once their
 * migration state says so.
 *
 * `wiki_fact` is Phase 8's target, and the plan's own suggestion: an atomic
 * fact is the most reversible content Kinetix publishes — one statement inside
 * one section, with a revision behind it — so a mistake is visible and undoable
 * without touching a computed value or a whole page.
 *
 * Deliberately not here: `parameter` and `param_entry` (they drive
 * calculations, Tier D in §13), `clinical_case` (never auto-published, safety-
 * critical), `wiki_new` (creates a drug row and a page at once), and everything
 * else awaiting its phase.
 */
export const CUTOVER_ELIGIBLE_EDIT_TYPES: readonly string[] = ['wiki_fact'];

/** The migration-state key for one edit type's apply authority. */
export function applyAuthorityKey(editType: string): string {
  return `pending_edit:${editType}`;
}

export interface ApplyAuthority {
  readonly authoritative: boolean;
  /** The key consulted, for logs and audit payloads. */
  readonly key: string;
  /**
   * Why authority was withheld. `null` when it was granted.
   *
   * Distinguishing these matters operationally: `not_eligible` needs a deploy
   * to change, `mode` needs a state row, and `force_legacy` means the kill
   * switch is on and nothing else will help.
   */
  readonly withheld: 'not_eligible' | 'mode' | null;
}

/**
 * Whether the generic engine decides publication for this edit type.
 *
 * Never throws: `resolveMigrationMode` already resolves a failed read to
 * `legacy_only` with a warning, and the fail-safe direction here is to leave
 * the proven path in charge (§1.6).
 */
export async function resolveApplyAuthority(
  editType: string,
  opts: { db?: GovernanceDb } = {},
): Promise<ApplyAuthority> {
  const key = applyAuthorityKey(editType);
  if (!CUTOVER_ELIGIBLE_EDIT_TYPES.includes(editType)) {
    // Checked before the state read, so an ineligible type costs no query.
    return { authoritative: false, key, withheld: 'not_eligible' };
  }
  const mode = await resolveMigrationMode(key, { db: opts.db });
  return isGenericAuthoritative(mode)
    ? { authoritative: true, key, withheld: null }
    : { authoritative: false, key, withheld: 'mode' };
}
