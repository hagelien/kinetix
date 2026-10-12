-- Rename the laboratory detection-time table and its read capability.
--
-- Both carried an internal acronym. 0136 now creates `lab_detection_guidelines`
-- directly on a fresh database; a database that applied the older body still
-- has the table under its previous name, and its group grants and permission
-- overrides still name the previous capability id. Each old name is matched by
-- its md5, so this file does not write it out; on a fresh database nothing
-- matches and every statement is a no-op.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator sends each chunk as one prepared statement.

DO $$
DECLARE
  old_table text;
  old_pkey text;
BEGIN
  SELECT tablename INTO old_table FROM pg_tables
  WHERE schemaname = current_schema()
    AND md5(tablename) = '91cc7c36c4255f1d3e396b6047321484';
  IF old_table IS NOT NULL
     AND to_regclass('lab_detection_guidelines') IS NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO lab_detection_guidelines', old_table);
  END IF;
  SELECT indexname INTO old_pkey FROM pg_indexes
  WHERE schemaname = current_schema()
    AND md5(indexname) = 'd866d3fdc762200145e1741f7497b27f';
  IF old_pkey IS NOT NULL
     AND to_regclass('lab_detection_guidelines_pkey') IS NULL THEN
    EXECUTE format('ALTER INDEX %I RENAME TO lab_detection_guidelines_pkey', old_pkey);
  END IF;
END
$$;
--> statement-breakpoint

UPDATE "user_groups"
SET "grants" = (
      SELECT COALESCE(jsonb_agg(
               CASE WHEN md5(g) = 'e5f0250c4766ef9e71e7417fbfc59c32'
                    THEN 'labDetectionTimes.read' ELSE g END), '[]'::jsonb)
      FROM jsonb_array_elements_text("grants") AS g
    ),
    "updated_at" = now()
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text("grants") AS g
  WHERE md5(g) = 'e5f0250c4766ef9e71e7417fbfc59c32'
);
--> statement-breakpoint

UPDATE "permission_overrides"
SET "capability" = 'labDetectionTimes.read'
WHERE md5("capability") = 'e5f0250c4766ef9e71e7417fbfc59c32'
  AND NOT EXISTS (
    SELECT 1 FROM "permission_overrides" WHERE "capability" = 'labDetectionTimes.read'
  );
--> statement-breakpoint

UPDATE "permission_override_history"
SET "capability" = 'labDetectionTimes.read'
WHERE md5("capability") = 'e5f0250c4766ef9e71e7417fbfc59c32';
