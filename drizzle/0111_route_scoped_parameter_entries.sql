-- Route-scoped parameter entries (CV-2c).
--
-- Absorption, bioavailability (F) and the first-order absorption rate (ka) are
-- genuinely per-ADMINISTRATION-ROUTE properties: the same molecule absorbs
-- differently intranasally than orally, so its F and ka differ by route. Until
-- now `parameter_entries` had no route key, so a multi-route drug's absorption
-- collapsed to one drug-level shape and route-specific F/ka had nowhere to live
-- (CV-2b's documented limitation). This adds that key.
--
-- `route` is NULLABLE and defaults to unset: every existing row, and every
-- genuinely molecule-level parameter (half-life, Vd, clearance, …), keeps it
-- NULL and is untouched — the migration is additive and backward-compatible. A
-- non-null value scopes the entry to one administration route. The admissible
-- words are the kinetics-core `RouteId` vocabulary; the CHECK below mirrors them,
-- and `src/lib/modelStructureVocabulary.test.ts` holds the two in step so a route
-- can never be admissible in the engine and inadmissible in the column, or vice
-- versa. Which PARAMETERS may carry a route (the route-specific ones) is enforced
-- on the write path (Zod), where the evolving parameter vocabulary lives.
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "route" VARCHAR(20);
--> statement-breakpoint

-- COALESCE to FALSE for the same reason as the categorical CHECK (0109): a CHECK
-- that evaluates to NULL *passes*, and `NULL IN (...)` is NULL — but here NULL is
-- the legitimate "drug-level" value, so the NULL branch must PASS. The membership
-- test only applies once `route` is non-null.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_route_vocabulary";
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_route_vocabulary"
  CHECK (
    "route" IS NULL
    OR "route" IN (
      'oral', 'intranasal', 'iv', 'im', 'sublingual', 'rectal', 'inhalation', 'other'
    )
  );
