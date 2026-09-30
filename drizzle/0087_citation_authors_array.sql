-- Canonicalize `citations.metadata->'authors'` to the array shape the rest of
-- the stack requires.
--
-- `createReferenceSchema` types authors as `z.array(z.string()).optional()` and
-- has a test asserting a comma-separated string is malformed input, so no live
-- write path can produce one. Rows predating that contract can still carry
-- `"authors": "Huertas T, Aasen B"`, and on the read side
-- `normalizeReferenceMetadata` drops a non-array value outright: such a paper
-- renders with no author anywhere it is cited, and the reference index's author
-- axis files it under "Uten forfatter" instead of its real surname bucket.
--
-- Splitting on the comma matches `normalizeAuthorList` in
-- `src/lib/authorNames.ts`, which the citation formatter and the author axis
-- share — the same parse the client has always applied when rendering a
-- "[Huertas 2020]" marker, now applied once to the stored value.
--
-- WITH ORDINALITY preserves author order: the first author decides both the
-- bucket and the "et al." label, so a reordered list would file the paper under
-- the wrong letter. A no-op when no such rows exist.

-- ── Rows carrying at least one real name ────────────────────────────────────
-- The guard matches a value holding any character that is neither a comma nor
-- whitespace, i.e. one that yields a non-empty author after splitting.
UPDATE "citations"
SET "metadata" = jsonb_set(
      "metadata",
      '{authors}',
      (
        SELECT jsonb_agg(part.name ORDER BY part.pos)
        FROM (
          SELECT btrim(raw) AS name, pos
          FROM regexp_split_to_table("metadata"->>'authors', ',')
               WITH ORDINALITY AS split(raw, pos)
        ) AS part
        WHERE part.name <> ''
      )
    )
WHERE jsonb_typeof("metadata"->'authors') = 'string'
  AND "metadata"->>'authors' ~ '[^,[:space:]]';
--> statement-breakpoint

-- ── Rows whose string held no name at all ───────────────────────────────────
-- Only the degenerate leftovers ("", "  ", ",,") still type as a string here.
-- They carry no author to recover, so the key goes rather than becoming an
-- empty array — `normalizeReferenceMetadata` drops an empty list anyway, and
-- an absent key is what it would have written.
UPDATE "citations"
SET "metadata" = "metadata" - 'authors'
WHERE jsonb_typeof("metadata"->'authors') = 'string';
