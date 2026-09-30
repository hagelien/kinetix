/**
 * The Kinetix adapter set, and its one registration entry point.
 *
 * Every target type Kinetix currently governs through `agent_verifications` has
 * an adapter here — the five the queue interleaves plus `learning_unit_revision`,
 * which is in the approvals taxonomy but deliberately not served (Phase 0 doc
 * §5.2). That is Phase 2's exit gate: *every currently supported verification
 * target can be represented by an adapter*.
 *
 * Nothing in Kinetix's request path calls any of this yet. Registration is
 * explicit rather than an import side effect, so pulling a type in for its
 * definition can never mutate the registry as a consequence.
 */

import {
  findKnowledgeTargetAdapter,
  registerKnowledgeTargetAdapter,
} from '../../registry.js';
import type { AnyKnowledgeTargetAdapter } from '../../target-adapter.js';
import { KINETIX_SPACE } from './support.js';
import { drugDiscussionAdapter, DRUG_DISCUSSION_TYPE } from './drug-discussion.js';
import {
  drugParameterRevisionAdapter,
  DRUG_PARAMETER_REVISION_TYPE,
} from './drug-parameter-revision.js';
import {
  learningUnitRevisionAdapter,
  LEARNING_UNIT_REVISION_TYPE,
} from './learning-unit-revision.js';
import { paperReviewAdapter, PAPER_REVIEW_TYPE } from './paper-review.js';
import { pendingEditAdapter, PENDING_EDIT_TYPE } from './pending-edit.js';
import { wikiRevisionAdapter, WIKI_REVISION_TYPE } from './wiki-revision.js';

export {
  DRUG_DISCUSSION_TYPE,
  DRUG_PARAMETER_REVISION_TYPE,
  LEARNING_UNIT_REVISION_TYPE,
  PAPER_REVIEW_TYPE,
  PENDING_EDIT_TYPE,
  WIKI_REVISION_TYPE,
  KINETIX_SPACE,
};

export const KINETIX_ADAPTERS: readonly AnyKnowledgeTargetAdapter[] = [
  drugParameterRevisionAdapter,
  wikiRevisionAdapter,
  paperReviewAdapter,
  drugDiscussionAdapter,
  pendingEditAdapter,
  learningUnitRevisionAdapter,
] as AnyKnowledgeTargetAdapter[];

/**
 * Register every Kinetix adapter.
 *
 * Idempotent by **identity**, not by type name. Skipping any type that happened
 * to be registered was the first version of this, and it defeated the very
 * check the registry exists for: another adapter already holding
 * `pending_edit` would be silently left in place, `DuplicateAdapterError` would
 * never fire, and the wrong code would go on deciding what a drug parameter
 * means. Comparing the object means a second call is a genuine no-op while a
 * *conflicting* registration still raises.
 */
export function registerKinetixAdapters(): void {
  for (const adapter of KINETIX_ADAPTERS) {
    const existing = findKnowledgeTargetAdapter(KINETIX_SPACE, adapter.type);
    if (existing === adapter) continue;
    // Either nothing is registered (this registers it) or something else is
    // (the registry throws, which is the point).
    registerKnowledgeTargetAdapter(adapter);
  }
}
