-- Index on wiki_pages.parent_id to support the recursive CTE walks used by
-- validateParentAssignment (ancestor chain + descendant BFS) and the
-- breadcrumb query in getBySlug. Without this index both CTEs scan the
-- full wiki_pages table on each recursive step.
CREATE INDEX CONCURRENTLY "wiki_pages_parent_id_idx"
  ON "wiki_pages" ("parent_id");
