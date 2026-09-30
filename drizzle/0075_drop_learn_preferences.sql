-- Remove the Kinetix Learn "My Path" preference-tilt feature. The
-- learner-facing preferences card, its /api/preferences write path, and the
-- recommendation-engine scoring that consumed it are all gone, so the
-- users.learn_preferences column has no remaining readers or writers.
ALTER TABLE "users" DROP COLUMN IF EXISTS "learn_preferences";
