-- Adjustable capability matrix.
--
-- Which tier may do what has so far been hardcoded across the API routes and
-- the React components. The registry in src/lib/permissions.ts names every
-- gated action and carries the shipped default; these tables hold only the
-- deviations an admin makes from Admin -> Permissions, so a stock install
-- starts empty and behaves exactly as before.
--
-- `capability` is the natural key. Rows whose id a later release drops are
-- ignored at read time (sanitizeOverrides) rather than migrated away, so no
-- FK to application code is implied here.
CREATE TABLE IF NOT EXISTS "permission_overrides" (
  "capability" VARCHAR(64) PRIMARY KEY,
  "min_tier" VARCHAR(20) NOT NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Append-only audit trail, mirroring user_role_history. `to_tier` is NULL when
-- the override was cleared and the capability returned to its code default.
CREATE TABLE IF NOT EXISTS "permission_override_history" (
  "id" SERIAL PRIMARY KEY,
  "capability" VARCHAR(64) NOT NULL,
  "from_tier" VARCHAR(20),
  "to_tier" VARCHAR(20),
  "changed_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "changed_at" TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_override_history_cap_idx"
  ON "permission_override_history" ("capability", "changed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_override_history_changed_idx"
  ON "permission_override_history" ("changed_at");
