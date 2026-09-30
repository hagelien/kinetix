-- Reviewer's explicit attestation that a cited paper was read in full (not
-- abstract-only). Required for the fact/parameter reference gate: facts and
-- parameters may only cite resolvable references that carry a read-in-full
-- paper review. Existing rows default to false and must be re-attested.
ALTER TABLE "paper_reviews"
  ADD COLUMN IF NOT EXISTS "read_in_full" BOOLEAN NOT NULL DEFAULT false;
