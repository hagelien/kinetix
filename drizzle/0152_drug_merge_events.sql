-- Lineage for drug merges (#29).
--
-- A drug merge repoints the loser's drug_parameter_revisions onto the
-- survivor (keeping their ids) and deletes the loser row, so afterwards
-- nothing records which rows in the survivor's history were the other drug's,
-- and source_diff's "previous revision" lookup could not tell the two
-- formerly independent histories apart.
--
-- One row per merge, written inside the merge's own transaction by both the
-- admin merge (api/_lib/drug-merge.ts) and scripts/merge-drugs.ts:
--   * the loser's identity as it stood (id, slug, PubChem CID, names);
--   * parameter_revision_ids: every drug_parameter_revisions.id it repointed;
--   * parameter_baselines: per parameter, which revision the survivor's
--     "previous revision" continues from when the newest pre-merge row is the
--     side whose value did not survive (api/_lib/drug-merge-lineage.ts);
--   * revision_high_water: the highest drug_parameter_revisions.id at the
--     merge, so "was this revision written before or after it" is decided by
--     id rather than by clock.
--
-- Additive only: a new table, no change to an existing column. Neither drug
-- id has a foreign key — the loser is deleted by the merge itself and the
-- record must outlive a later merge or delete of the survivor. Nothing is
-- backfilled: merges before this migration recorded none of this, and
-- inventing lineage for them would claim a provenance nobody kept.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator sends each chunk as one prepared statement.
CREATE TABLE IF NOT EXISTS "drug_merge_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "survivor_drug_id" integer NOT NULL,
  "loser_drug_id" integer NOT NULL,
  "loser_slug" varchar(200) NOT NULL,
  "loser_pubchem_cid" integer,
  "loser_names" jsonb NOT NULL,
  "parameter_revision_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
  "parameter_baselines" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "revision_high_water" integer NOT NULL,
  "repointed_monograph_page_id" integer,
  "merged_via" varchar(20) NOT NULL,
  "merged_by" integer,
  "merged_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "drug_merge_events"
    ADD CONSTRAINT "drug_merge_events_merged_by_users_id_fk"
    FOREIGN KEY ("merged_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_merge_events_survivor_idx" ON "drug_merge_events" ("survivor_drug_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drug_merge_events_loser_idx" ON "drug_merge_events" ("loser_drug_id");
