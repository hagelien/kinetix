-- Metabolism pathways are now recorded as ranges. A biotransformation is
-- rarely a single point: "CYP3A4 converts 30–40% of drug X into metabolite Y"
-- needs a min and a max, with the central estimate optional. We keep the
-- existing `conversion_fraction` / `fraction` columns as the representative
-- central value (median preferred, mean fallback — matching the NumericRange
-- convention established by 0071) and add the bound columns alongside.
--
-- Additive only: existing rows keep their central value and read back as a
-- point range (min/max null).

ALTER TABLE "drug_metabolites"
  ADD COLUMN "conversion_fraction_min" numeric(6, 4),
  ADD COLUMN "conversion_fraction_max" numeric(6, 4);
--> statement-breakpoint
ALTER TABLE "drug_elimination_routes"
  ADD COLUMN "fraction_min" numeric(6, 4),
  ADD COLUMN "fraction_max" numeric(6, 4);
