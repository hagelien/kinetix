-- Restricted reference tables served behind a gate (today the laboratory urine
-- detection-time guideline behind /api/refs-detection-times).
--
-- Schema only. The contents are a restricted internal document and are loaded
-- by an operator from outside the repository; no row is ever seeded here. An
-- absent row means the route answers 503 and the section stays empty.
CREATE TABLE IF NOT EXISTS "refs_detection_guidelines" (
  "key" VARCHAR(64) PRIMARY KEY,
  "source" JSONB NOT NULL,
  "preamble" TEXT NOT NULL DEFAULT '',
  "rows" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
