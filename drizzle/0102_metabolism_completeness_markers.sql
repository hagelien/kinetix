-- Two completeness markers per substance, pinned to the edge set each was
-- earned on.
--
-- The metabolite ratio profile's source-ambiguity walk needs to know whether a
-- node's metabolism is *finished*, not whether anyone has touched it. Presence
-- answers the wrong question: a parent with one recorded elimination route and
-- no metabolite edges passes a presence check, produces an empty candidate set,
-- and clears every source degradation while an unrecorded administered source
-- stays possible. That is the failure the check exists to prevent, reintroduced
-- by the check.
--
-- So the claim is asserted explicitly, and it is two claims rather than one.
-- "Every metabolite of this substance is entered" and "every precursor of this
-- substance is entered" are made from different evidence and consumed
-- separately: the downstream walk reads only the first, the upstream walk only
-- the second. One flag would force a curator to vouch for both before either
-- could be used, so the common case — a well-characterised parent whose
-- metabolites are fully entered, walked downstream — would sit unasserted
-- waiting on a precursor claim the analysis never reads.
--
--   metabolites_complete_digest  the edge set the downstream claim was made about
--   precursors_complete_digest   the edge set the upstream claim was made about
--
-- NULL means nobody has claimed it. Otherwise the claim is current exactly
-- while the stored digest equals the substance's edge set *right now* —
-- computed at read time, from the edges, by the functions below.
--
-- **Nothing caches the current digest, and that is the design.** The obvious
-- shape is two more columns holding each direction's current digest, kept true
-- by a trigger. Every way that can go wrong ends in the same place: a cached
-- value that disagrees with the graph, and a marker that reads `complete` over
-- an edge nobody reviewed. Two transactions writing edges to one substance each
-- recompute from their own snapshot and the later one stores a digest for a
-- graph that no longer exists; serialising them needs a row lock the foreign-key
-- check has already taken in a weaker mode, so the two upgrades deadlock and a
-- metabolism write aborts instead. Comparing against the computed value removes
-- the question rather than answering it: there is no cache to fall behind, no
-- lock to take, and a marker cannot outlive its edge set even if a future
-- writer bypasses everything here.
--
-- A stale assertion keeps its stored value rather than being cleared: the
-- curator's judgement is still on record and what expired is its currency,
-- which is the difference that lets an editor offer "re-assert" rather than an
-- empty checkbox.

ALTER TABLE "drugs"
  ADD COLUMN IF NOT EXISTS "metabolites_complete_digest" TEXT,
  ADD COLUMN IF NOT EXISTS "precursors_complete_digest" TEXT;
--> statement-breakpoint

-- What identifies an edge, and therefore what a completeness claim is about.
--
-- A linked row is an edge to a *substance*, so it is keyed by the substance and
-- a relabelling leaves the set alone — the editor fills `metabolite_name` from
-- the linked drug's name in the editing user's language, so that string moves
-- for reasons that have nothing to do with which edges exist (0099). An
-- unlinked row names a substance the catalog does not carry, and the only key
-- it has is that string, case-folded.
--
-- Keys are length-prefixed rather than joined on a separator, because
-- `metabolite_name` is free text and any separator can appear inside one. Two
-- edges named `a` and `b` join to `n:a|n:b` on a pipe — and so does one edge
-- named `a|n:b`, so swapping the pair for the single row would leave the digest
-- unchanged and a completeness assertion current over a different graph. A
-- length prefix makes the concatenation parseable, so distinct sets cannot
-- share a pre-image.
--
-- The empty set digests to the empty string rather than to md5(''), so "no
-- edges" is legible wherever the value is shown and cannot be read as a hash.
CREATE OR REPLACE FUNCTION "metabolite_edges_digest_of"(p_drug_id INTEGER)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(md5(string_agg(length(k)::TEXT || ':' || k, '' ORDER BY k)), '')
    FROM (
      SELECT DISTINCT COALESCE('#' || "metabolite_drug_id"::TEXT,
                               'n:' || lower("metabolite_name")) AS k
        FROM "drug_metabolites"
       WHERE "parent_drug_id" = p_drug_id
    ) edges;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "precursor_edges_digest_of"(p_drug_id INTEGER)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(md5(string_agg(length(k)::TEXT || ':' || k, '' ORDER BY k)), '')
    FROM (
      SELECT DISTINCT '#' || "parent_drug_id"::TEXT AS k
        FROM "drug_metabolites"
       WHERE "metabolite_drug_id" = p_drug_id
    ) edges;
$$;
--> statement-breakpoint

-- Nobody has asserted anything yet, so every substance starts unasserted —
-- which is the honest starting state: a claim nobody has made is not a claim
-- that happens to be false. The partial indexes exist for the curation queries
-- that ask which substances carry a claim at all.
CREATE INDEX IF NOT EXISTS "drugs_metabolites_complete_idx"
  ON "drugs" ("id")
  WHERE "metabolites_complete_digest" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "drugs_precursors_complete_idx"
  ON "drugs" ("id")
  WHERE "precursors_complete_digest" IS NOT NULL;
