-- Admission: which citations may back a reference cohort (§13.3, §34.4).
--
-- 0107 recorded what a citation identifies. This is the rule that reads it, and
-- it closes the route the owner's 2026-08-12 decision declined — mechanically,
-- at the object rather than at the handle. `citation_id` being `NOT NULL` only
-- demands *a* citation, and a licensed dataset under a URL handle is a citation.
--
-- Two conditions, both at the table.
--
-- **The citation is a publication, resolved now.** A `dataset`, a `database`, a
-- `peer_review`, a container, or a DOI whose kind will not resolve is refused —
-- and so is a `conflicted` one, because two registries disagreeing about what
-- an object is, is a curation question and no cohort should rest on it until a
-- human settles it.
--
-- **The paper was read in full** (§34.4). Reference data drives inferential
-- displays, and a percentile computed from a paper nobody read in full is
-- exactly the claim the citation governance system exists to prevent. Binding
-- that check to admission is what keeps the atlas inside the gate the rest of
-- the system already enforces, instead of relying on operator discipline.
--
-- ## Why this fires on INSERT only
--
-- Admission is an insert. A citation merge *repoints* a cohort — `UPDATE …
-- SET citation_id` — and that must not be refused: #1083 made the atlas survive
-- an ordinary DOI→PMID merge precisely so a merge is not a data-loss event, and
-- a merge that lands two disagreeing work kinds on the winner marks it
-- `conflicted` (0107). Firing on the repoint would make the guard turn every
-- such merge into a failure, which is not a stricter atlas — it is a broken
-- merge path with the cohort still admitted.
--
-- The condition does not lapse, and this is not where it is kept. Matching
-- reads the citation's *current* classification on every case, so a cohort
-- whose citation has since become conflicted, or has acquired a handle nobody
-- has asked about, contributes nothing — skipped exactly as an unprovenanced
-- band is. Admission happens once; matching happens every time, which is the
-- right place for a claim that can expire.
--
-- ## The stale case, and how far SQL can go on its own
--
-- A classification claims "every handle this row carried was asked", and it
-- expires when a handle appears (0107). A row that was resolved as a
-- `journal_article` and has since acquired an unexamined DOI still *stores*
-- `resolved`, so a guard reading the status alone would admit it — and the
-- unexamined DOI is exactly where a dataset verdict would have come from.
--
-- Deciding that in general needs the row's handle set, which needs the
-- identifier normalization and resolver-URL parsing in
-- `src/lib/citationHandles.ts`. Reimplemented here it would be a second parser,
-- and a second parser that disagrees is worse than none: normalize a DOI
-- differently and this guard refuses an insert the application just approved.
--
-- So the guard derives only the handles it can be *certain* of — an identifier
-- already in canonical form, in the row's own columns or in `metadata.altIds`.
-- Anything it cannot recognise without parsing — an identifier stored in some
-- other spelling, a resolver URL that is percent-escaped or carries a query
-- string — it leaves out. That makes its answer a subset
-- of the real handle set, which is the direction that cannot cause harm: every
-- handle it names is one the TypeScript derivation names too, so this can only
-- refuse what `judgeStoredAdmission` would also refuse, never the reverse.
-- `citation_certain_handles` is pinned to that relation by a test that runs a
-- table of rows through both.
--
-- Resolver URLs are recognised in their plain form, because that is the one way
-- a citation acquires a handle without its own columns changing: `altIds.url`
-- set to `https://doi.org/…` introduces a DOI nobody asked about. What stays
-- outside the guard is the awkward spelling of the same thing — percent-escaped,
-- upper-cased, carrying a query string — which needs the decoding
-- `resolverHandleFromUrl` does and would be the first place two derivations
-- disagreed. Those are caught by the admission path before it inserts, and by
-- matching on every read.
--
-- ## It does not lock the citation
--
-- The foreign key already holds a key-share lock on that row for this insert,
-- so it cannot be deleted underneath us, but its classification can still
-- change between this read and the commit. A handle appearing in that window
-- leaves the cohort admitted against a claim that has just expired — which
-- matching, reading the current classification on every case, declines to score
-- until someone re-resolves it.

-- The publication kinds a cohort may rest on.
--
-- Not a fresh policy: `src/lib/pattern/publishedWorks.ts` already answers the
-- owner's published-sources decision for the registries, and this list must not
-- be looser than that one, or a source failing the registries' gate would start
-- backing inferential reference data through a different door. `preprint`,
-- `dissertation` and `conference_paper` are refused because their counterparts
-- there — `preprint`, `thesis`, `conference_abstract` — sit outside
-- `PUBLISHED_KINDS`. A test enforces that relation against the TypeScript list;
-- this list and that one are the two copies the SQL guard and the application
-- path read, and a third test pins them to each other.
--
-- `report` is refused although its counterpart `official_guideline` is
-- published, which is the one place this is deliberately stricter: the
-- canonical kind covers Crossref's `report`, `standard` and their series, so it
-- is both a published guideline and the write-up an institution would give its
-- own casework — materially the route the 2026-08-12 decision declined. One
-- kind cannot separate them, so it waits for something that can.

CREATE OR REPLACE FUNCTION "citation_work_kind_is_admissible"(p_kind TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_kind IN (
    'journal_article', 'book', 'book_chapter'
  ), FALSE);
$$;
--> statement-breakpoint

-- The handles this row carries that can be read off it without a parser.
--
-- Recognition, not normalization: an identifier is emitted only when it is
-- already in the canonical form `citationHandles.ts` would produce — a bare
-- PMID with no leading zeros, a lower-cased DOI, a plain resolver URL — so
-- there is no second spelling of the same handle to disagree about. Anything
-- else is skipped, which keeps the result a subset of the real set.
CREATE OR REPLACE FUNCTION "citation_certain_handles"(
  p_type TEXT,
  p_identifier TEXT,
  p_metadata JSONB
) RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  WITH raw AS (
    -- Everywhere a handle can sit: the row's own identifier, and the alt ids.
    -- `url` is included because a resolver URL is a handle wearing a coat, and
    -- it is the one way a citation acquires a handle without its own columns
    -- changing — `altIds.url` set to `https://doi.org/…` introduces a DOI the
    -- classification never examined.
    SELECT CASE WHEN p_type IN ('pmid', 'doi', 'url') THEN p_type END AS kind,
           p_identifier AS value
    UNION ALL SELECT 'pmid', p_metadata -> 'altIds' ->> 'pmid'
    UNION ALL SELECT 'doi', p_metadata -> 'altIds' ->> 'doi'
    UNION ALL SELECT 'url', p_metadata -> 'altIds' ->> 'url'
  ),
  recognised AS (
    SELECT 'pmid:' || value AS handle
      FROM raw
     WHERE kind = 'pmid' AND value ~ '^[1-9][0-9]{0,7}$'
    UNION ALL
    SELECT 'doi:' || value
      FROM raw
     WHERE kind = 'doi'
       AND value ~ '^10\.[0-9]{4,}/.+$'
       AND value = lower(value)
    -- Resolver URLs in their plain form only: no percent-escapes, no query or
    -- fragment, already lower-cased. Any other spelling needs the decoding and
    -- host-folding `resolverHandleFromUrl` performs, and guessing at it is
    -- where two derivations would start to disagree.
    UNION ALL
    SELECT 'doi:' || substring(
             value FROM '^https?://(?:dx\.)?doi\.org/(10\.[0-9]{4,}/[^?#%[:space:]]+)$')
      FROM raw
     WHERE kind = 'url'
       AND value = lower(value)
       AND value ~ '^https?://(?:dx\.)?doi\.org/10\.[0-9]{4,}/[^?#%[:space:]]+$'
    UNION ALL
    SELECT 'pmid:' || substring(
             value FROM '^https?://pubmed\.ncbi\.nlm\.nih\.gov/([1-9][0-9]{0,7})/?$')
      FROM raw
     WHERE kind = 'url'
       AND value = lower(value)
       AND value ~ '^https?://pubmed\.ncbi\.nlm\.nih\.gov/[1-9][0-9]{0,7}/?$'
  )
  SELECT COALESCE(array_agg(DISTINCT handle ORDER BY handle), ARRAY[]::TEXT[])
    FROM recognised;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "pattern_reference_cohort_admission_guard"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
  v_kind TEXT;
  v_examined TEXT[];
  v_certain TEXT[];
  v_read_in_full BOOLEAN;
BEGIN
  SELECT c."work_kind_status",
         c."work_kind",
         COALESCE(c."work_kind_handles", ARRAY[]::TEXT[]),
         "citation_certain_handles"(c."type", c."identifier", c."metadata")
    INTO v_status, v_kind, v_examined, v_certain
    FROM "citations" c
   WHERE c."id" = NEW."citation_id";

  -- The foreign key reports a missing citation in its own words; reaching here
  -- with no row means this trigger ran before it, so say something true rather
  -- than reading NULL as "not a publication".
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = format('cohort admission: citation %s does not exist', NEW."citation_id"),
      ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'cohort admission refused: citation %s work kind is %s, not a resolved publication',
        NEW."citation_id", COALESCE(v_status, 'unknown')),
      ERRCODE = 'restrict_violation';
  END IF;

  IF NOT "citation_work_kind_is_admissible"(v_kind) THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'cohort admission refused: citation %s identifies a %s, which is not a publication this atlas admits',
        NEW."citation_id", COALESCE(v_kind, 'unknown')),
      ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (v_certain <@ v_examined) THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'cohort admission refused: citation %s carries handle(s) %s that its classification never examined',
        NEW."citation_id",
        array_to_string(ARRAY(SELECT unnest(v_certain) EXCEPT SELECT unnest(v_examined)), ', ')),
      ERRCODE = 'restrict_violation';
  END IF;

  -- `paper_reviews` is unique on `citation_id`, so this is one row or none.
  SELECT COALESCE(bool_or(r."read_in_full"), FALSE)
    INTO v_read_in_full
    FROM "paper_reviews" r
   WHERE r."citation_id" = NEW."citation_id";

  IF NOT v_read_in_full THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'cohort admission refused: citation %s has no read-in-full review (§34.4)',
        NEW."citation_id"),
      ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- `CREATE OR REPLACE TRIGGER` (PG 14+): the migration runner can replay a file
-- after a partially applied deploy, and a bare CREATE TRIGGER would stop it with
-- "already exists" — the same reasoning 0105 records.
CREATE OR REPLACE TRIGGER "pattern_reference_cohorts_admission"
  BEFORE INSERT ON "pattern_reference_cohorts"
  FOR EACH ROW
  EXECUTE FUNCTION "pattern_reference_cohort_admission_guard"();
