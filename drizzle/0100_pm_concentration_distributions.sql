-- Carry a whole postmortem concentration distribution as one unit of meaning.
--
-- Kinetix already has a well-worn path for "what does the literature say this
-- drug's X is": `parameter_entries`, one row per source value, pooled into a
-- weighted median + IQR cache. That machinery is deliberately NOT reused here.
--
-- A postmortem cohort table is a different kind of object. It
-- is one laboratory's order statistics over tens of thousands of postmortem
-- femoral blood cases — a median, a 90th, a 95th, a 97.5th percentile that all
-- describe the SAME distribution. Feeding those into the pool would average a
-- percentile against somebody else's percentile and produce a number no cohort
-- ever measured, and it would do so under a parameter name
-- (`fatalConcentration`) the material explicitly does not support: it is
-- postmortem data with no link to cause of death. A 97.5th percentile here
-- says how often a
-- concentration is seen at autopsy, not that it kills.
--
-- So the distribution is stored whole, cited whole, and displayed whole.

-- ── 1. The cohort ───────────────────────────────────────────────────────────
-- Source-keyed from the start. Adding a second postmortem cohort (a published
-- one, another laboratory's) must be an INSERT, not another migration.
--
-- `citation` is free text rather than a `citations` foreign key on purpose.
-- This material is an unpublished conference presentation with no DOI and no
-- PMID; a citations row needs a resolvable handle, and minting a handle-less
-- one would put an entry in the reference index that no reader can follow.
CREATE TABLE IF NOT EXISTS "pm_concentration_sources" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR(60) NOT NULL UNIQUE,
  "citation" TEXT NOT NULL,
  "short_label" VARCHAR(40) NOT NULL,
  "heading" TEXT NOT NULL,
  "matrix" VARCHAR(40) NOT NULL,
  "unit" VARCHAR(20) NOT NULL,
  "description" TEXT NOT NULL,
  "caveats" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);

--> statement-breakpoint
-- ── 2. One analyte's distribution within a cohort ───────────────────────────
-- Numbers are stored in the SOURCE's unit and matrix (mg/L, postmortem femoral
-- whole blood), never pre-converted. Unit conversion depends on the reader's
-- display unit and matrix conversion depends on the drug's blood:plasma ratio,
-- which is itself an entry-backed value that changes as sources are added —
-- baking either into the stored row would freeze a derived number next to the
-- published one it was derived from.
--
-- `numeric` rather than `double precision`: these are read back and shown to
-- the reader as published, so a transcribed decimal must round-trip exactly.
CREATE TABLE IF NOT EXISTS "pm_concentration_distributions" (
  "id" SERIAL PRIMARY KEY,
  "source_id" INTEGER NOT NULL
    REFERENCES "pm_concentration_sources"("id") ON DELETE CASCADE,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "analyte" VARCHAR(200) NOT NULL,
  "n" INTEGER NOT NULL,
  "loq" NUMERIC(14, 6),
  "mean" NUMERIC(14, 6),
  "median" NUMERIC(14, 6),
  "p90" NUMERIC(14, 6),
  "p95" NUMERIC(14, 6),
  "p975" NUMERIC(14, 6),
  -- The source's own therapeutic plasma concentration and median(PM)/TC ratio.
  -- Held INSIDE the cohort so they can be shown beside the percentiles the way
  -- the source prints them, without ever reaching the `therapeuticConcentration`
  -- pool — that parameter is built from reviewed per-paper source values, and a
  -- single unsourced comparison figure would silently reweight it.
  "tc_plasma" NUMERIC(14, 6),
  "median_over_tc" NUMERIC(14, 6),
  -- A defect in the printed table, transcribed rather than corrected (e.g. a
  -- 90th percentile printed above the row's own 95th and 97.5th). Silently
  -- "fixing" source data is not ours to do, and drawing a line several times
  -- too high is worse than drawing none, so the row keeps the printed value,
  -- carries the note, and names the statistic in `undrawable`.
  "anomaly" TEXT,
  "undrawable" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "review_note" TEXT,
  -- Exact source strings for values a float cannot reproduce, keyed by column
  -- ({"p95": "0.20"}). A value printed 0.20 is not 0.2: trailing zeros are a
  -- statement about significant figures, and this table is quoted in forensic
  -- work, so dropping them silently changes what the source said about its own
  -- precision. Stored only where the printed form and the float differ.
  "printed" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);

--> statement-breakpoint
-- One distribution per analyte per cohort. This is what makes the seeder
-- idempotent by source observation: a corrected transcription UPDATEs the row
-- instead of leaving two distributions for the same drug, which would show the
-- reader two contradictory medians from one cohort.
CREATE UNIQUE INDEX IF NOT EXISTS "pm_concentration_distributions_source_drug_idx"
  ON "pm_concentration_distributions" ("source_id", "drug_id");

--> statement-breakpoint
-- The read path is "every distribution for the drugs on this chart".
CREATE INDEX IF NOT EXISTS "pm_concentration_distributions_drug_idx"
  ON "pm_concentration_distributions" ("drug_id");
