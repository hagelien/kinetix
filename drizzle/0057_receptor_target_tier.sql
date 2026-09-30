-- Rank receptor-target mechanisms for the monograph pharmacodynamics box.
--
-- Each drug_receptor_targets row is one mechanism (an interaction at a target,
-- e.g. "antagonist at SERT"). `tier` ranks it by contribution to the drug's
-- overall effect — 'primary' | 'secondary' | 'tertiary' — so the monograph
-- pharmacodynamics box can present mechanisms grouped as
-- Primary/Secondary/Tertiary mechanism(s). NULL = unranked (grouped under
-- "other"). Validation of the allowed values lives at the API edge.
ALTER TABLE "drug_receptor_targets" ADD COLUMN IF NOT EXISTS "tier" VARCHAR(20);
