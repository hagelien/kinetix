-- Stop the maintenance agent's gap queue from re-selecting parameters that can
-- never be filled.
--
-- The core-coverage queue (§3 tier A in agents/drug-db-maintainer.md) is a
-- plain "no row in drug_parameters" scan. It has no memory of a search that
-- came back empty and no notion of a quantity that is undefined, so an
-- unfillable pair sits at the head of the queue and is re-picked every hourly
-- cycle. Benzoylecgonine's bioavailability was the case that surfaced it: a
-- cocaine metabolite nobody administers has no absolute bioavailability, and
-- being a component of a screening method sorts it ahead of everything
-- else. Screening panels are full of such analytes, so this is a class of
-- pairs, not one row.
--
-- Two durable layers land here; the third (an exhaustive search that found
-- nothing) needs no schema, since it is already a verification_log row with
-- concordance='absent' and only suppresses the pair for ABSENT_RECHECK_DAYS.

-- ── 1. Substance class ──────────────────────────────────────────────────────
-- What kind of thing the entry is. Drives the class-wide rule in
-- src/lib/parameterApplicability.ts: bioavailability and the dose
-- parameters all describe an administered dose, so they are undefined for
-- anything that is not administered. Defaulting to 'drug' means existing rows
-- keep every parameter in scope — the safe direction, since a spurious gap
-- costs one cycle while a wrongly hidden one hides real missing data.
ALTER TABLE "drugs"
  ADD COLUMN IF NOT EXISTS "substance_class" VARCHAR(20) NOT NULL DEFAULT 'drug';

--> statement-breakpoint
-- ── 2. Pair-level not-applicable marker ─────────────────────────────────────
-- For the one-offs the class rule cannot express. `reason` is NOT NULL because
-- an unexplained marker is indistinguishable from a mistake, and it is what a
-- future curator reads when deciding whether to lift it.
CREATE TABLE IF NOT EXISTS "drug_parameter_applicability" (
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "parameter" VARCHAR(60) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'not_applicable',
  "reason" TEXT NOT NULL,
  "set_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY ("drug_id", "parameter")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_parameter_applicability_param_idx"
  ON "drug_parameter_applicability" ("parameter");

--> statement-breakpoint
-- ── 3. Absent-cooldown lookup ───────────────────────────────────────────────
-- The gap query asks, for every candidate pair, whether a concordance='absent'
-- verification exists inside the cooldown window. The existing
-- verification_log_target_param_idx is not selective enough for that sweep:
-- 'absent' rows are a small minority of parameter verifications, so a partial
-- index over just them keeps the check cheap as the log grows.
CREATE INDEX IF NOT EXISTS "verification_log_absent_param_idx"
  ON "verification_log" ("target_id", "parameter", "verified_at" DESC)
  WHERE "target_type" = 'parameter' AND "concordance" = 'absent';

-- ── 4. No classification data here, on purpose ──────────────────────────────
-- The catalog classification (`data/substanceClasses.ts`) is applied by
-- `scripts/backfill-substance-classes.ts`, run AFTER the deploy, not by this
-- migration. Two reasons, and the second is the one that bites:
--
-- 1. A migration runs while the *previous* application version is still
--    serving writes. Classifying a substance here declares bioavailability,
--    and the dose ranges undefined for it, but the old build has no
--    applicability guard — so it can store one of those values moments after
--    this statement's snapshot, and the new API then serves a number for a
--    pair its own queue calls impossible. A conditional UPDATE cannot close
--    that window; running after the guarded writers are live does.
--
-- 2. A migration runs once. The classification is a list of scientific
--    judgements, and four entries have already been withdrawn from it after
--    review (beta-hydroxybutyrate, hydroxybupropion, cotinine,
--    3-hydroxyphenazepam are all administered in some form). Baked into a
--    migration, a withdrawn entry stays wrong in every database that already
--    ran it, with nothing to correct it. The script is idempotent and reports
--    classifications the list no longer claims.
