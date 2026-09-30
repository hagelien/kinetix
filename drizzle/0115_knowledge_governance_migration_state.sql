-- Per-target migration control plane (§11 of
-- docs/plans/2026-08-26-general-knowledge-governance-extraction.md, Phase 4).
--
-- Phase 4 is where generic code first participates in a live Kinetix request —
-- as an observer that mirrors what already happened. §11.2 says a target may
-- only do that once it is at least in `shadow` mode, so the mode has to be
-- stored somewhere before the mirroring can be turned on for anything.
--
-- One row per (space, target_type). **A missing row means `legacy_only`**: a
-- target nobody has explicitly advanced does not participate, so adding a new
-- target type never silently opts it into the generic path. That is the same
-- fail-safe direction as §1.6 — absence of a decision is the conservative
-- decision, not the permissive one.
--
-- Advancing a target is an administrator action and is audited into
-- `kg_audit_events`; §11.4 also forbids automated deployment from advancing
-- state, which is why this table ships empty and no migration writes to it.
--
-- Additive and inert, like 0114: nothing in Kinetix reads this table unless a
-- row exists, and none does.
CREATE TABLE IF NOT EXISTS kg_migration_state (
  id          SERIAL PRIMARY KEY,
  space_id    INTEGER NOT NULL REFERENCES kg_spaces(id) ON DELETE CASCADE,
  target_type VARCHAR(60) NOT NULL,
  -- legacy_only | shadow | compare | generic_read |
  -- legacy_write_generic_mirror | generic_authoritative (§11.2).
  -- Varchar + a TS union at the edge, per this repo's convention: adding a mode
  -- is a code change, not a lock-taking DDL migration.
  mode        VARCHAR(40) NOT NULL DEFAULT 'legacy_only',
  -- Who advanced it. `users.id` as a plain integer with no foreign key, for the
  -- reason the kg_ tables reference actors by string: an audit fact must not be
  -- erasable by deleting an account. NULL for a row created by tooling.
  updated_by  INTEGER,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  notes       TEXT
);
--> statement-breakpoint

-- One mode per target per space. Both columns are NOT NULL above, so the
-- constraint cannot be disabled by a null.
CREATE UNIQUE INDEX IF NOT EXISTS kg_migration_state_identity_idx
  ON kg_migration_state (space_id, target_type);
