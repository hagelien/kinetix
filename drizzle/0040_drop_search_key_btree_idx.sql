-- drugs_search_key_trgm_idx (GIN, added in 0008) handles all LIKE '%q%'
-- search queries against drugs.search_key. The original B-tree index from
-- migration 0001 cannot serve leading-wildcard LIKE patterns and has been
-- unused since 0008 was applied. Drop it to eliminate unnecessary write
-- amplification on every drug INSERT / UPDATE.
DROP INDEX CONCURRENTLY IF EXISTS "drugs_search_key_idx";
