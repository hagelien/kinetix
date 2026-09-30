-- Backfill a baseline revision for existing wiki pages that predate
-- complete revision tracking, so their history view is not empty.
INSERT INTO "wiki_revisions" (
  "page_id",
  "content",
  "content_html",
  "edit_summary",
  "created_by",
  "created_at"
)
SELECT
  p."id",
  COALESCE(
    p."content",
    '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb
  ),
  p."content_html",
  NULL,
  p."updated_by",
  p."updated_at"
FROM "wiki_pages" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "wiki_revisions" r
  WHERE r."page_id" = p."id"
);
