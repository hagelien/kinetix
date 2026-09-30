-- Retire the "Saksspesifikke tolkningsmaler" (case_templates) and
-- "Evidenskvalitet og kildenoter" (evidence) monograph fact categories.
--
-- There is no dedicated column for either category: monograph facts live
-- inside the wiki page content JSONB under `sections.<id>`, and pending edits
-- reference a section via the shared `pending_edits.section_id` column. So the
-- cleanup is purely data — strip every residual entry that points at the two
-- removed categories. The schema (src/lib/monographSections.ts) no longer
-- declares them, so the renderer/extractor already ignore any leftovers; this
-- migration removes the stored bytes as well.

-- 1. Pending edits (any status) that targeted one of the removed sections.
DELETE FROM "pending_edits"
WHERE "section_id" IN ('case_templates', 'evidence');
--> statement-breakpoint

-- 2. Strip the orphaned section bodies from current page content...
UPDATE "wiki_pages"
SET "content" = ("content" #- '{sections,case_templates}') #- '{sections,evidence}'
WHERE "content" -> 'sections' ? 'case_templates'
   OR "content" -> 'sections' ? 'evidence';
--> statement-breakpoint

-- 3. ...and from the historical revisions that retain their own content snapshots.
UPDATE "wiki_revisions"
SET "content" = ("content" #- '{sections,case_templates}') #- '{sections,evidence}'
WHERE "content" -> 'sections' ? 'case_templates'
   OR "content" -> 'sections' ? 'evidence';
