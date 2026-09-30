-- Agent focus config — add the 'methods' scope.
--
-- Lets an admin point the scheduled drug-database maintainer at every drug
-- component that belongs to a selected set of analytical methods (the
-- `rettstoks` test panels). Stored as analytical_methods.id values; the
-- agent never needs `rettstoks` group membership — GET /api/agent-focus
-- resolves the component drug ids on its behalf.
--
--   mode = 'methods' → restrict work to the components of method_ids.

ALTER TABLE "agent_focus_config"
  ADD COLUMN IF NOT EXISTS "method_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;
