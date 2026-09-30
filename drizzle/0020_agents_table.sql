-- #319 P1: agents table + backfill the existing kinetix-agent.
--
-- Each agent is a regular user row (so JWT/auth/audit work unchanged)
-- linked to an `agents` record carrying public-facing metadata + the
-- accountable maintainer. Bilingual columns follow the AGENTS.md
-- convention: `name`/`description` are Norwegian (primary) and
-- `name_en`/`description_en` are optional English overrides that the
-- frontend falls back to when the user's locale is `en`.
--
-- The single existing service account (`kinetix-agent`) is backfilled
-- here when the user already exists; on a fresh database the
-- `seed-agent-user` script also upserts the agents row so this
-- migration isn't the only path that creates it.

CREATE TABLE "agents" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "name" VARCHAR(100) NOT NULL,
  "name_en" VARCHAR(100),
  "slug" VARCHAR(100) NOT NULL UNIQUE,
  "description" TEXT,
  "description_en" TEXT,
  "maintainer_user_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX "agents_active_idx" ON "agents" USING btree ("active");
--> statement-breakpoint
CREATE INDEX "agents_maintainer_idx" ON "agents" USING btree ("maintainer_user_id");
--> statement-breakpoint

-- Backfill the existing kinetix-agent if its user row already exists.
-- Maintainer is left NULL — admins attach themselves via the admin UI
-- in P2. Slug matches the username so existing operators recognise it.
INSERT INTO "agents" (
  "user_id", "name", "name_en", "slug", "description", "description_en", "active"
)
SELECT
  id,
  'Kinetix vedlikeholdsagent',
  'Kinetix maintenance agent',
  'kinetix-agent',
  'Kjører time-baserte oppdateringer mot legemiddeldatabasen. Sender atomiske faktaforslag for menneskelig gjennomgang.',
  'Hourly drug-database curation routine. Submits parameter and monograph atomic-fact pending edits for human review.',
  TRUE
FROM "users"
WHERE "username" = 'kinetix-agent'
ON CONFLICT ("user_id") DO NOTHING;
