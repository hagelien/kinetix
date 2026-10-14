-- `wiki_pages.drug_cid` means `drugs.id`, and only that.
--
-- It used to mean two things. `ensureDrugMonograph` has always written
-- `drugs.id`, but the original `scripts/seed-drug-monographs.ts` wrote the
-- drug's PubChem CID, so every reader resolved both — and because the two
-- numbering spaces overlap (25C-NBOMe is id 281, carbon monoxide is CID 281),
-- each one also had to carry a collision rule saying which reading wins. This
-- migration moves the last CID-keyed pages onto `drugs.id` so those readers can
-- drop the CID interpretation (#16 item 7).
--
-- Production was checked read-only on 2026-10-14 before this was written: all
-- 694 `drug_monograph` pages already hold an existing `drugs.id` — none null,
-- none CID-only, none dangling — and the 13 whose number is also some other
-- drug's `pubchem_cid` are each titled for the drug whose internal id it is.
-- There it is a no-op. It exists for development and preview databases seeded
-- from the old script.
--
-- A page is moved only when the answer is unambiguous, which is the same rule
-- the readers applied:
--
--   * its number is NOT any drug's internal id. If it is, the page is that
--     drug's modern monograph, whatever other drug's CID it also happens to be;
--     moving it would steal it.
--   * its number IS a drug's `pubchem_cid`. That column is unique, so it names
--     at most one drug.
--   * that drug has no other monograph. If it has, moving this page onto it
--     would give the drug two pages — the silent duplicate #1256 described —
--     and choosing which one survives is a human's call.
--   * no other page carries the same number. Two legacy pages for one CID would
--     otherwise both be moved, recreating that duplicate in one statement.
--
-- Anything else is left exactly as it is, and nothing is deleted. A page left
-- behind no longer resolves to a drug once the readers stop interpreting CIDs;
-- `scripts/fix-monograph-drug-links.ts` is the reviewed way to settle it.
--
-- `updated_at` is deliberately left alone: the page's content did not change,
-- and the wiki shows that timestamp as the last edit.
--
-- Open `wiki_new` proposals carry the number the new page will get in
-- `proposed_meta.drugCid`, and approval copies it into `drug_cid`. A proposal
-- queued under the old two-space reading is normalized by the same rule
-- (minus the page-count conditions, which apply only once a page exists);
-- approval refuses whatever is left. Production had no open ones on
-- 2026-10-14.
--
-- Idempotent. A moved page or proposal now holds a `drugs.id`, which the
-- first condition excludes, so a re-run finds nothing to do.

UPDATE "wiki_pages" AS "wp"
SET "drug_cid" = "d"."id"
FROM "drugs" AS "d"
WHERE "wp"."page_type" = 'drug_monograph'
  AND "wp"."drug_cid" IS NOT NULL
  AND "d"."pubchem_cid" = "wp"."drug_cid"
  AND NOT EXISTS (
    SELECT 1 FROM "drugs" AS "owner" WHERE "owner"."id" = "wp"."drug_cid"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "wiki_pages" AS "other"
    WHERE "other"."page_type" = 'drug_monograph'
      AND "other"."drug_cid" = "d"."id"
      AND "other"."id" <> "wp"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "wiki_pages" AS "twin"
    WHERE "twin"."page_type" = 'drug_monograph'
      AND "twin"."drug_cid" = "wp"."drug_cid"
      AND "twin"."id" <> "wp"."id"
  );
--> statement-breakpoint

UPDATE "pending_edits" AS "pe"
SET "proposed_meta" = jsonb_set("pe"."proposed_meta", '{drugCid}', to_jsonb("d"."id"))
FROM "drugs" AS "d"
WHERE "pe"."edit_type" = 'wiki_new'
  AND "pe"."status" IN ('pending', 'draft', 'returned')
  AND jsonb_typeof("pe"."proposed_meta" -> 'drugCid') = 'number'
  -- A whole number within int range, so the casts below cannot fail and
  -- abort the migration on a malformed proposal.
  AND ("pe"."proposed_meta" ->> 'drugCid') ~ '^[0-9]{1,9}$'
  AND "d"."pubchem_cid" = ("pe"."proposed_meta" ->> 'drugCid')::int
  AND NOT EXISTS (
    SELECT 1 FROM "drugs" AS "owner"
    WHERE "owner"."id" = ("pe"."proposed_meta" ->> 'drugCid')::int
  );
