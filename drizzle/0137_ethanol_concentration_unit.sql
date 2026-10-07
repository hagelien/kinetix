-- Ethanol's own display-unit preference. Blood alcohol is read in per mille
-- (‰) or percent (%), not in the µmol/L or mg/L that govern every other drug
-- (`enabled_concentration_units`), so ethanol gets a single preferred unit of
-- its own. Display only: it never changes a stored value. Defaults to ‰.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "ethanol_concentration_unit" varchar(16) NOT NULL
  DEFAULT '‰';
