/**
 * Types for the approval summaries that history and discussion
 * endpoints attach to each row (#344). The interactive approval chip was
 * removed from the UI; approvals are still recorded server-side (reviewer
 * stamps on applied edits, agent "no concern" stamps) and feed the
 * verification level. Never gate agentic evaluation logic on the count.
 */
import type { UserBadgeData } from '@/components/ui/UserBadge';

export type ApprovalTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion';

export type ApproverRef = { id: number } & UserBadgeData;

export interface ApprovalSummary {
  count: number;
  approvers: ApproverRef[];
  /** Present when the request carried auth context. */
  approvedByMe?: boolean;
}
