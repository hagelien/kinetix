-- A mode-independent switch: "agents work parameters only, no wiki content".
--
-- Until now the only way to stop the scheduled agents filing monograph facts
-- was `mode = 'parameters'`, which also throws away the drug axis: an admin
-- who had scoped the agents to the components of an analytical method (or to a
-- list of pages) and wanted the monograph action quiet had to abandon that
-- scope to get it. The two questions are orthogonal — *which* drugs and
-- parameters are in scope, and *whether* agent-authored wiki content is open
-- at all — so this is a column beside `mode`, not a fifth mode.
--
-- Default false: the shipped behaviour is unchanged, and the flag can only
-- become true through the composition-aware form that ships with it. Unlike
-- `methods_parameters_opt_in` (0122) this needs no opt-in guard for the
-- deploy window. That window is dangerous when a NEW READER activates a value
-- an OLD WRITER left behind; here the old writer cannot produce a `true` (it
-- never names the column, and its upsert's DO UPDATE set-list leaves a stored
-- value alone), and false is exactly the permissive status quo. The failure
-- direction is the safe one in both halves of the window.

ALTER TABLE "agent_focus_config"
  ADD COLUMN IF NOT EXISTS "skip_wiki_content" boolean NOT NULL DEFAULT false;
