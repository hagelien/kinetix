-- Clear the agent-focus `parameters` array on a row whose mode is `methods`.
--
-- `agent_focus_config` holds exactly one row, and its schema has always said
-- `parameters` is the "DrugParameterId list for mode='parameters'; empty
-- otherwise" (db/schema.ts). The write path never enforced the second half:
-- `PUT /api/agent-focus` stored whichever arrays the request carried, and the
-- admin form always submitted its whole `parameters` state regardless of which
-- mode radio was selected. So an admin who scoped the agents to a few
-- parameters and later switched the same config to `methods` left the old
-- selection sitting in the row, inert.
--
-- Inert is the operative word: `resolveFocusNarrowing` returned
-- `parameters: null` for `methods`, so the array changed nothing and nobody had
-- reason to notice it. The commit this migration ships with makes `methods`
-- compose the two narrowings, which turns that dormant array into an ACTIVE
-- filter the moment it deploys — a method-focused agent would silently stop
-- working every parameter outside a set nobody chose for this purpose, and the
-- only visible symptom would be a quieter queue. A focus that narrows itself
-- without an admin saying so is the failure worth spending a migration on;
-- an empty array here means "no extra filter", which is the behaviour the
-- config had yesterday.
--
-- Scope: `methods` rows only. A `parameters` row's array is its whole
-- instruction and is left alone. `pages` and `all` still ignore the column, and
-- the API now clears it for them on the next write (api/agent-focus.ts), so
-- this sweep is about the one mode whose reading actually changes today.
--
-- Nothing is lost that an admin could not re-pick in the form in a few seconds,
-- and the new UI shows the picker in `methods` mode, so a deliberate
-- combination is expressible immediately after this runs.
--
-- Re-running changes nothing: the statement selects on a non-empty array and
-- writes an empty one, so a second pass matches no rows.

UPDATE "agent_focus_config"
SET "parameters" = '[]'::jsonb,
    "updated_at" = now()
WHERE "mode" = 'methods'
  AND "parameters" IS NOT NULL
  AND jsonb_typeof("parameters") = 'array'
  AND jsonb_array_length("parameters") > 0;
