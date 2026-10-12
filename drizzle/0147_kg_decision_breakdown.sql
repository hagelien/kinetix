-- What a governance decision was taken under, kept with the decision.
--
-- assurance-core 0.5 asks a store to keep a decision's explanation, not only
-- its outcome: the fingerprint of the policy definition it was evaluated
-- against (`PolicySet.definitionFingerprint`, which tells "v1 as written then"
-- from "v1 edited in place since") and the rules that applied. The unmet
-- requirements already have a home in `unsatisfied_requirements`.
--
-- Both columns are nullable and nothing is backfilled: a decision recorded
-- before this migration did not record them, and inventing values for it
-- would claim a provenance the row never had.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator sends each chunk as one prepared statement.

ALTER TABLE kg_policy_decisions ADD COLUMN IF NOT EXISTS policy_fingerprint varchar(64);
--> statement-breakpoint
ALTER TABLE kg_policy_decisions ADD COLUMN IF NOT EXISTS matched_rule_ids jsonb;
