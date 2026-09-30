-- What a citation identifies, as opposed to which identifier it is keyed by
-- (§13.3).
--
-- `citations.type` is the handle — `pmid`, `doi`, `url`, `freetext` — ranked by
-- durability. It says nothing about the object behind it, and the atlas above
-- it needs exactly that: `pattern_reference_cohorts.citation_id` is NOT NULL,
-- so "published sources only" is currently enforced as "some citation exists",
-- and a licensed dataset under a URL handle is a perfectly valid citation row.
-- Requiring a DOI instead would be worse, not better: datasets carry DOIs, so
-- the refused route would walk back in one handle up.
--
-- So the classification is about the work, it comes from the registries that
-- know (Crossref's `work.type`, PubMed's `pubtype`), and it is canonicalised
-- before it is stored — the two vocabularies disagree by construction, and an
-- ordinary article resolved through both handles would otherwise contradict
-- itself. The mapping lives in `src/lib/citationWorkKind.ts`; only canonical
-- values reach these columns.
--
-- Three states, not two:
--
--   unresolved   nobody has asked. Every row predating this migration, and
--                every row whose handle set has since grown.
--   resolved     every handle that answered agreed; `work_kind` holds it.
--   conflicted   two registries disagree about what the object is. Kept as a
--                state of its own — a retry reproduces it, and clearing it to
--                unresolved would route back into a re-resolve that can land on
--                the more permissive verdict and admit the source the
--                disagreement was evidence against.
--
-- `work_kind_handles` records the handles that were asked, and it is what makes
-- the verdict expire correctly. The claim a resolution makes is "every handle
-- this row carried was asked", so it stands exactly while the row's current
-- handles are all among the examined ones — a subset test, computed from the
-- row at read time rather than cached, the shape 0102's completeness markers
-- use. A handle appearing (a merge, a promotion, an altIds expansion) expires
-- it; a handle disappearing does not, which is what keeps a `conflicted`
-- verdict from being erased by patching away the DOI that produced it. Adding a
-- handle re-opens the question; removing one does not answer it.
--
-- Nothing here is enforced by a trigger, deliberately. A trigger would have to
-- distinguish those two directions and would still be a cached answer that a
-- future writer could leave stale; a claim recomputed from the row's own
-- handles cannot go stale, and no writer has to know it exists.

ALTER TABLE "citations"
  ADD COLUMN IF NOT EXISTS "work_kind" TEXT,
  ADD COLUMN IF NOT EXISTS "work_kind_status" TEXT NOT NULL DEFAULT 'unresolved',
  ADD COLUMN IF NOT EXISTS "work_kind_handles" TEXT[],
  ADD COLUMN IF NOT EXISTS "work_kind_verdicts" JSONB,
  ADD COLUMN IF NOT EXISTS "work_kind_resolved_at" TIMESTAMP;
--> statement-breakpoint

-- The canonical vocabulary, in one place: the column check and the per-verdict
-- check below both read it, so a kind can never be admissible in the evidence
-- and inadmissible in the column it summarises.
CREATE OR REPLACE FUNCTION "citation_work_kind_is_known"(p_kind TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_kind IN (
    'journal_article', 'conference_paper', 'book', 'book_chapter', 'preprint',
    'dissertation', 'report', 'dataset', 'database', 'peer_review',
    'component', 'other'
  );
$$;
--> statement-breakpoint

-- The shape of a classification, checked as one rule because the parts are only
-- meaningful together.
--
-- A `conflicted` row with one verdict is not a conflict, and a `resolved` row
-- whose verdicts do not all say what the column says is a summary that
-- contradicts its own evidence — either would be read downstream as a settled
-- answer. Every verdict names a handle that was actually asked, and no handle
-- answers twice.
--
-- A handle that answered nothing carries no verdict, so the verdict list is a
-- subset of the examined handles rather than a match: silence from a registry
-- is not evidence, and recording it as one would turn an outage into a kind.
CREATE OR REPLACE FUNCTION "citation_work_kind_evidence_ok"(
  p_status TEXT,
  p_kind TEXT,
  p_handles TEXT[],
  p_verdicts JSONB
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  -- COALESCE, not decoration. A `CHECK` that evaluates to NULL *passes*, and
  -- every predicate below goes NULL against a NULL argument:
  -- `jsonb_typeof(NULL)` is NULL, and a scalar subquery over
  -- `jsonb_array_elements(NULL)` aggregates zero rows to NULL. So a `resolved`
  -- row with a kind, an examined set and no verdicts at all — a settled
  -- classification with nothing behind it — would be accepted by the rule
  -- written to refuse exactly that. Unknown is not permission.
  SELECT COALESCE(CASE
    WHEN p_status = 'unresolved' THEN
      p_kind IS NULL AND p_handles IS NULL AND p_verdicts IS NULL
    WHEN p_status IN ('resolved', 'conflicted') THEN
      p_handles IS NOT NULL
      AND COALESCE(array_length(p_handles, 1), 0) >= 1
      AND array_position(p_handles, NULL) IS NULL
      AND (SELECT count(*) = count(DISTINCT h) FROM unnest(p_handles) AS h)
      AND (SELECT bool_and(h ~ '^(pmid|doi):[^[:space:]]+$')
             FROM unnest(p_handles) AS h)
      AND jsonb_typeof(p_verdicts) = 'array'
      AND jsonb_array_length(p_verdicts) >= 1
      AND (SELECT bool_and(
                    jsonb_typeof(v) = 'object'
                    AND v ? 'handle'
                    AND v ? 'kind'
                    AND jsonb_typeof(v -> 'handle') = 'string'
                    AND jsonb_typeof(v -> 'kind') = 'string'
                    AND (v ->> 'handle') = ANY (p_handles)
                    AND "citation_work_kind_is_known"(v ->> 'kind'))
             FROM jsonb_array_elements(p_verdicts) AS v)
      AND (SELECT count(DISTINCT v ->> 'handle') = jsonb_array_length(p_verdicts)
             FROM jsonb_array_elements(p_verdicts) AS v)
      AND CASE p_status
            WHEN 'resolved' THEN
              p_kind IS NOT NULL
              AND (SELECT bool_and(v ->> 'kind' = p_kind)
                     FROM jsonb_array_elements(p_verdicts) AS v)
            ELSE
              p_kind IS NULL
              AND (SELECT count(DISTINCT v ->> 'kind') > 1
                     FROM jsonb_array_elements(p_verdicts) AS v)
          END
    ELSE FALSE
  END, FALSE);
$$;
--> statement-breakpoint

ALTER TABLE "citations"
  DROP CONSTRAINT IF EXISTS "citations_work_kind_status_vocabulary";
--> statement-breakpoint

-- Spelled out here as well as in the shape rule: a status outside the
-- vocabulary would fall to that rule's ELSE and be refused, but by a message
-- naming the evidence rather than the value that is actually wrong.
ALTER TABLE "citations"
  ADD CONSTRAINT "citations_work_kind_status_vocabulary"
  CHECK ("work_kind_status" IN ('unresolved', 'resolved', 'conflicted'));
--> statement-breakpoint

ALTER TABLE "citations"
  DROP CONSTRAINT IF EXISTS "citations_work_kind_vocabulary";
--> statement-breakpoint

-- A kind outside the canonical set is not a coarser answer; it is a value no
-- admission rule is written about, so it would pass every gate by matching no
-- refusal. The same argument the matrix and qualifier vocabularies carry in
-- 0106.
ALTER TABLE "citations"
  DROP CONSTRAINT IF EXISTS "citations_work_kind_evidence";
--> statement-breakpoint

ALTER TABLE "citations"
  ADD CONSTRAINT "citations_work_kind_vocabulary"
  CHECK ("work_kind" IS NULL OR "citation_work_kind_is_known"("work_kind"));
--> statement-breakpoint

ALTER TABLE "citations"
  ADD CONSTRAINT "citations_work_kind_evidence"
  CHECK ("citation_work_kind_evidence_ok"(
    "work_kind_status", "work_kind", "work_kind_handles", "work_kind_verdicts"
  ));
--> statement-breakpoint

ALTER TABLE "citations"
  DROP CONSTRAINT IF EXISTS "citations_work_kind_resolved_at";
--> statement-breakpoint

-- When the answer was obtained, which is what lets an operator re-ask the
-- oldest classifications without re-asking every one of them. Present exactly
-- when there is an answer to date.
ALTER TABLE "citations"
  ADD CONSTRAINT "citations_work_kind_resolved_at"
  CHECK (("work_kind_status" = 'unresolved') = ("work_kind_resolved_at" IS NULL));
--> statement-breakpoint

-- The backfill's working set, and after it the residue that never resolved.
CREATE INDEX IF NOT EXISTS "citations_work_kind_unresolved_idx"
  ON "citations" ("id")
  WHERE "work_kind_status" = 'unresolved';
