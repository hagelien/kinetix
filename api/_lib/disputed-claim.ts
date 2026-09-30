/**
 * "Quote the claim" rule for dispute verdicts (issue #1357).
 *
 * A dispute blocks consensus on its own, however many approvals a target has,
 * so a dispute that rests on a misreading costs a moderator's time. #1357 is
 * the case in point: a blind T2 reviewer disputed an oxymorphone pKa proposal
 * "as if 8.17 were the drug's only pKa" — a claim the proposal never made (it
 * named 8.17 as the basic amine pKa and disclosed pKa2 = 9.54 explicitly). The
 * reviewer had pattern-matched from the previous item in its batch.
 *
 * So a dispute must quote, verbatim, the passage of the target it says is
 * wrong, and the server checks the quote is really there. A reviewer who
 * cannot find the sentence it is objecting to has found a misreading, not a
 * flaw. This costs nothing in independence: the check reads only the target
 * itself, never another reviewer's verdict.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { VERIFICATION_SOURCE_TABLES } from './verification-targets.js';
import type { AgentVerificationTargetType } from '../../db/schema.js';
import { claimAppearsIn, claimTextBlocks } from '../../src/lib/disputedClaim.js';

export {
  claimAppearsIn,
  claimTextBlocks,
  collectTextBlocks,
  DISPUTED_CLAIM_MAX_CHARS,
  DISPUTED_CLAIM_MIN_CHARS,
  normalizeClaimText,
  rationaleWithDisputedClaim,
} from '../../src/lib/disputedClaim.js';

/** Load the target's source row and check the quote against its claim fields. */
export async function disputedClaimAppearsInTarget(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
  claim: string;
}): Promise<boolean> {
  const table = VERIFICATION_SOURCE_TABLES[args.targetType];
  if (!table) return false;
  const [row] = await getDb()
    .select()
    .from(table)
    .where(eq(table.id, args.targetId))
    .limit(1);
  if (!row) return false;
  return claimAppearsIn(
    args.claim,
    claimTextBlocks(args.targetType, row as Record<string, unknown>),
  );
}
