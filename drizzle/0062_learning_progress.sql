-- Kinetix Learn Phase C: learner state.
-- learning_question_attempts is an append-only event log (one row per answered
-- question) with the question's pedagogical tags frozen at attempt time so
-- competence aggregates survive later unit edits. learning_unit_progress is the
-- per-(user, unit) rollup plus the SM-2-style spaced-review schedule
-- (review_ease stored x100). users.learn_preferences holds the My Path tilt.

CREATE TABLE IF NOT EXISTS "learning_question_attempts" (
  "id"                   SERIAL PRIMARY KEY,
  "user_id"              INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "unit_id"              INTEGER NOT NULL REFERENCES "learning_units"("id") ON DELETE CASCADE,
  "question_index"       INTEGER NOT NULL,
  "category"             VARCHAR(10) NOT NULL,
  "cognitive_skill"      VARCHAR(30),
  "difficulty"           VARCHAR(30) NOT NULL,
  "concepts"             JSONB NOT NULL DEFAULT '[]'::jsonb,
  "correct"              BOOLEAN NOT NULL,
  "selected_option_ids"  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "mode"                 VARCHAR(20) NOT NULL,
  "created_at"           TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_attempts_user_created_idx"
  ON "learning_question_attempts" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_attempts_user_unit_idx"
  ON "learning_question_attempts" ("user_id", "unit_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_unit_progress" (
  "user_id"               INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "unit_id"               INTEGER NOT NULL REFERENCES "learning_units"("id") ON DELETE CASCADE,
  "attempts"              INTEGER NOT NULL DEFAULT 0,
  "best_score_pct"        INTEGER NOT NULL DEFAULT 0,
  "last_score_pct"        INTEGER NOT NULL DEFAULT 0,
  "status"                VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  "review_reps"           INTEGER NOT NULL DEFAULT 0,
  "review_ease"           INTEGER NOT NULL DEFAULT 250,
  "review_interval_days"  INTEGER NOT NULL DEFAULT 0,
  "next_review_at"        TIMESTAMP,
  "last_attempt_at"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "created_at"            TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "learning_unit_progress_user_id_unit_id_pk" PRIMARY KEY ("user_id", "unit_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_progress_user_due_idx"
  ON "learning_unit_progress" ("user_id", "next_review_at");
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "learn_preferences" JSONB NOT NULL DEFAULT '{}'::jsonb;
