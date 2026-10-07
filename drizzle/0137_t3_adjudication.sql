-- T3 adjudication records (docs/plans/2026-09-18-t3-adjudication-backend.md,
-- agents/drug-db-adjudication.md).
--
-- T3 is the rare, non-blind, two-panelist appellate tier for a disagreement
-- that survives blind T2 re-verification. Three tables, shaped like the
-- governance store's (append-only, a pinned immutable version, a capability
-- snapshot at decision time) so a later port is a data migration:
--
--   adjudication_cases       one row per (target, version), for all time. The
--                            unique key has no partial predicate: a target
--                            version is adjudicated at most once, so a standing
--                            trigger re-read by the sweep cannot reopen it. The
--                            lower-tier verdicts the case rests on are COPIED in
--                            (t1_snapshot / t2_snapshot), because a verdict row
--                            is upserted in place and a later re-verdict would
--                            otherwise rewrite the appeal record.
--   adjudication_case_seats  who sits on the panel, claimed before anyone reads
--                            the case file. One identity per seat, and no
--                            identity on both.
--   adjudication_opinions    strictly append-only, one row per panelist
--                            revision. A changed mind appends a row pointing
--                            back at the one it supersedes; a trigger refuses
--                            every UPDATE and DELETE.
--
-- agents.adjudicator is the per-agent grant (server-owned, set by an admin like
-- self_review_enabled): the capability matrix is monotone by role, so it cannot
-- express "this one flagship identity may read a T3 case file". Being flagship
-- grants nothing on its own. agents.model_family records the model family for
-- the panel-diversity audit; it never blocks a case.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "adjudicator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "model_family" varchar(40);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjudication_cases" (
  "id" serial PRIMARY KEY NOT NULL,
  "target_type" varchar(40) NOT NULL,
  "target_id" integer NOT NULL,
  "target_version" varchar(80) NOT NULL,
  "triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "trigger_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dispute_origin" varchar(10) NOT NULL,
  "t2_verification_id" integer,
  "t2_snapshot" jsonb NOT NULL,
  "t1_snapshot" jsonb NOT NULL,
  "state" varchar(20) DEFAULT 'open' NOT NULL,
  "panel_family_diversity" varchar(10),
  "opened_at" timestamp DEFAULT now() NOT NULL,
  "sealed_at" timestamp,
  "closed_at" timestamp,
  "invalidated_reason" text,
  CONSTRAINT "adjudication_cases_dispute_origin_check"
    CHECK ("dispute_origin" IN ('agent', 'human', 'mixed')),
  CONSTRAINT "adjudication_cases_state_check"
    CHECK ("state" IN ('open', 'sealed', 'converged', 'diverged', 'invalidated')),
  CONSTRAINT "adjudication_cases_panel_family_diversity_check"
    CHECK ("panel_family_diversity" IS NULL OR "panel_family_diversity" IN ('distinct', 'same', 'unknown'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_cases"
    ADD CONSTRAINT "adjudication_cases_t2_verification_id_fk"
    FOREIGN KEY ("t2_verification_id") REFERENCES "agent_verifications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjudication_cases_target_version_uq" ON "adjudication_cases" ("target_type","target_id","target_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjudication_cases_state_opened_idx" ON "adjudication_cases" ("state","opened_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjudication_case_seats" (
  "id" serial PRIMARY KEY NOT NULL,
  "case_id" integer NOT NULL,
  "seat" varchar(1) NOT NULL,
  "agent_id" integer NOT NULL,
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  "sealed_at" timestamp,
  CONSTRAINT "adjudication_case_seats_seat_check" CHECK ("seat" IN ('a', 'b'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_case_seats"
    ADD CONSTRAINT "adjudication_case_seats_case_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "adjudication_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_case_seats"
    ADD CONSTRAINT "adjudication_case_seats_agent_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjudication_case_seats_case_seat_uq" ON "adjudication_case_seats" ("case_id","seat");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjudication_case_seats_case_agent_uq" ON "adjudication_case_seats" ("case_id","agent_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjudication_opinions" (
  "id" serial PRIMARY KEY NOT NULL,
  "case_id" integer NOT NULL,
  "seat" varchar(1) NOT NULL,
  "revision_no" integer NOT NULL,
  "supersedes_opinion_id" integer,
  "adjudicator_tier" varchar(20),
  "model" varchar(80),
  "resolution" varchar(20) NOT NULL,
  "proposition" text NOT NULL,
  "scope_key" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "resolved_value" double precision,
  "resolved_low" double precision,
  "resolved_high" double precision,
  "resolved_unit" varchar(40),
  "reasoning_md" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "confidence" varchar(10) NOT NULL,
  "human_required" boolean DEFAULT false NOT NULL,
  "human_reason" text,
  "finalized_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "adjudication_opinions_resolution_check"
    CHECK ("resolution" IN ('approve', 'dispute', 'return', 'split_scope', 'abstain', 'human')),
  CONSTRAINT "adjudication_opinions_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "adjudication_opinions_human_reason_check"
    CHECK (NOT "human_required" OR "human_reason" IS NOT NULL),
  -- A scalar or a range, never both; a range has both ends, low <= high; a
  -- unit exactly when a value is present.
  CONSTRAINT "adjudication_opinions_value_shape_check" CHECK (
    ("resolved_value" IS NULL OR ("resolved_low" IS NULL AND "resolved_high" IS NULL))
    AND (("resolved_low" IS NULL) = ("resolved_high" IS NULL))
    AND ("resolved_low" IS NULL OR "resolved_low" <= "resolved_high")
    AND (("resolved_unit" IS NULL) = ("resolved_value" IS NULL AND "resolved_low" IS NULL))
  )
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_opinions"
    ADD CONSTRAINT "adjudication_opinions_seat_fk"
    FOREIGN KEY ("case_id","seat") REFERENCES "adjudication_case_seats"("case_id","seat") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "adjudication_opinions"
    ADD CONSTRAINT "adjudication_opinions_supersedes_fk"
    FOREIGN KEY ("supersedes_opinion_id") REFERENCES "adjudication_opinions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjudication_opinions_case_seat_revision_uq" ON "adjudication_opinions" ("case_id","seat","revision_no");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "adjudication_opinions_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'adjudication_opinions is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "adjudication_opinions_append_only_trg" ON "adjudication_opinions";--> statement-breakpoint
CREATE TRIGGER "adjudication_opinions_append_only_trg"
  BEFORE UPDATE OR DELETE ON "adjudication_opinions"
  FOR EACH ROW EXECUTE FUNCTION "adjudication_opinions_append_only"();
