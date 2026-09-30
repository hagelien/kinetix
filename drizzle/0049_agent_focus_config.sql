-- Agent focus config — scope of the scheduled drug-database maintainer.
--
-- Singleton row (id = 1) an admin uses to steer what the hourly maintenance
-- routine (agents/drug-db-maintainer.md §3) works on. It globally narrows the
-- popularity-ordered queues; it does NOT boost a single drug/parameter (that
-- is parameter_priority_flags).
--
--   mode = 'all'        → any page, drug, and parameter (popularity order).
--   mode = 'pages'      → restrict work to the wiki pages listed in page_ids.
--   mode = 'parameters' → restrict parameter work to the parameters listed.

CREATE TABLE IF NOT EXISTS "agent_focus_config" (
  "id"         INTEGER PRIMARY KEY DEFAULT 1,
  "mode"       VARCHAR(20) NOT NULL DEFAULT 'all',
  "page_ids"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "parameters" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
-- Seed the single config row so reads never depend on a prior write.
INSERT INTO "agent_focus_config" ("id", "mode") VALUES (1, 'all')
  ON CONFLICT ("id") DO NOTHING;
