CREATE TABLE IF NOT EXISTS "user_groups" (
  "id" SERIAL PRIMARY KEY,
  "slug" VARCHAR(100) NOT NULL UNIQUE,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_group_members" (
  "group_id" INTEGER NOT NULL REFERENCES "user_groups"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "added_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_group_members_user_idx"
  ON "user_group_members" ("user_id");
--> statement-breakpoint

INSERT INTO "user_groups" ("slug", "name", "description")
VALUES (
  'rettstoks',
  'Rettstoks',
  'Access to Rettstoks-specific analytical methods.'
)
ON CONFLICT ("slug") DO NOTHING;
