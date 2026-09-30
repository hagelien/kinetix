-- Retire the free-text drug-class `category` column (#). The pharmacological
-- class it captured is now expressed by nesting monographs under a parent
-- rather than tagging each drug with a loose string, so the column is no
-- longer read or written anywhere in the app. Existing `search_key` values
-- still contain the old category text on rows that haven't been re-saved;
-- that is harmless and self-heals the next time a row's names/aliases change.
ALTER TABLE "drugs" DROP COLUMN IF EXISTS "category";
