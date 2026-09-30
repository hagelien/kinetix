-- Metoder feature: richer analytical-method model.
--
-- analytical_methods gains the matrix list (sample media the method applies
-- to), the sample volume requirement, and a screening/confirmatory type.
-- analytical_method_components gains the per-component reporting figures from
-- the method sheet: lor (Påvisn. / lower limit of reporting), lod (Terskel /
-- lower limit of detection), unit (Benevn.), measurement_uncertainty
-- (Usikker. %), and an explicit sort order so a method's component list keeps
-- the source ordering.

ALTER TABLE "analytical_methods" ADD COLUMN IF NOT EXISTS "matrices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "analytical_methods" ADD COLUMN IF NOT EXISTS "volume_ml" double precision;--> statement-breakpoint
ALTER TABLE "analytical_methods" ADD COLUMN IF NOT EXISTS "method_type" varchar(30);--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "lor" double precision;--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "lod" double precision;--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "unit" varchar(20);--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "measurement_uncertainty" double precision;--> statement-breakpoint
ALTER TABLE "analytical_method_components" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
