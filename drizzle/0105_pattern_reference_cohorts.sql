-- The atlas's admission record (spec §18.1, plan §10 Phase 3).
--
-- A cohort is one published dataset, admitted by one named admin, and every
-- reference case and observation reaches the atlas through one. That is what
-- makes invariant 31 auditable: recording admission here makes it impossible to
-- persist atlas data nobody admitted.
--
-- **Every column of the identity is NOT NULL.** PostgreSQL treats nulls as
-- distinct in a unique index, so one nullable member silently disables the
-- whole five-column constraint and lets the same cohort in twice. That includes
-- `source_dataset_hash`: a cohort transcribed by hand from an article with no
-- downloadable dataset still gets one, computed over the canonical
-- serialization of what was transcribed. A cohort with no bytes behind it
-- cannot be re-verified, which is what invariant 32 exists to guarantee.
--
-- `citation_id` is NOT NULL and RESTRICT rather than CASCADE: a cohort without
-- a published source is invalid (§13.3), and deleting a citation must not take
-- an admitted cohort with it. The merge path repoints this column explicitly —
-- see `api/_lib/citation-merge.ts`, which would otherwise fail on the
-- constraint.
CREATE TABLE IF NOT EXISTS pattern_reference_cohorts (
  id                     SERIAL PRIMARY KEY,
  citation_id            INTEGER NOT NULL REFERENCES citations(id) ON DELETE RESTRICT,
  -- '' means the whole dataset. A subgroup the paper reports separately —
  -- "CYP2C19 poor metabolisers", "cases with a stated interval under 2 h" —
  -- gets its own key, because it is a different population scored against a
  -- different case.
  subgroup_key           TEXT NOT NULL DEFAULT '',
  source_dataset_hash    TEXT NOT NULL,
  importer_version       TEXT NOT NULL,
  transformation_version TEXT NOT NULL,

  name                   TEXT NOT NULL,
  cohort_type            VARCHAR(40) NOT NULL,
  design                 TEXT,
  evidence_tier          VARCHAR(40),
  population_note        TEXT,
  analytical_note        TEXT,
  -- Anchors every relative hour on the cases below (§7.3), in the same
  -- vocabulary a case uses, so the two are compared rather than translated.
  time_origin            VARCHAR(40) NOT NULL,
  source_dataset_url     TEXT,
  transformation_notes   TEXT,
  version                TEXT,

  -- Invariant 31: who admitted this, and when.
  authorized_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- §16.5's identity. Five columns, every one NOT NULL above, so the constraint
-- cannot be disabled by a null.
CREATE UNIQUE INDEX IF NOT EXISTS pattern_reference_cohorts_identity_idx
  ON pattern_reference_cohorts (
    citation_id,
    source_dataset_hash,
    transformation_version,
    importer_version,
    subgroup_key
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_cohorts_citation_idx
  ON pattern_reference_cohorts (citation_id);
--> statement-breakpoint

-- The dataset identity is immutable once recorded (spec §18.1, invariant 32).
--
-- The importer verifies the file in hand against these values, and a
-- comparison against editable values verifies nothing: rewrite the hash and
-- changed input passes against a baseline that was moved to meet it. The
-- comment saying so is not a constraint, so this is.
--
-- Four columns, not three: invariant 32 aborts a bulk import when the
-- recomputed hash, importer version, transformation version **or dataset URL**
-- differs from the admission record, so the URL is part of what the import
-- verifies and has to be as fixed as the rest.
--
-- Including null → value. A cohort admitted with no URL was admitted with
-- nothing for an import to verify against, so supplying one afterwards does
-- not add a fact — it installs a baseline the admission never had, and the
-- next import measures itself against a value chosen after the fact. §34.3
-- already says what to do instead: a dataset that has changed is a new
-- admission, not a correction to an old one.
--
-- `citation_id` is deliberately *not* covered: the merge path repoints it, and
-- a merge is a statement about which handle names the paper rather than about
-- which dataset was admitted. `subgroup_key` likewise stays editable — it is
-- part of the uniqueness tuple but not of the bytes the importer checks.
CREATE OR REPLACE FUNCTION pattern_reference_cohorts_identity_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_dataset_hash IS DISTINCT FROM OLD.source_dataset_hash
     OR NEW.importer_version IS DISTINCT FROM OLD.importer_version
     OR NEW.transformation_version IS DISTINCT FROM OLD.transformation_version
     OR NEW.source_dataset_url IS DISTINCT FROM OLD.source_dataset_url
  THEN
    RAISE EXCEPTION
      'pattern_reference_cohorts: the admitted dataset identity is immutable (cohort %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- OR REPLACE, like every other statement in this file, because each one
-- autocommits on its own: a run that creates the trigger and then loses its
-- response before the journal records 0105 replays the whole file on the next
-- deploy, and a bare CREATE TRIGGER would stop it with "already exists" — a
-- migration needing a hand-run DROP before it can proceed. Single command
-- rather than DROP IF EXISTS followed by CREATE, which would leave a window,
-- however brief, where an update could rewrite an admitted identity.
CREATE OR REPLACE TRIGGER pattern_reference_cohorts_identity_immutable
  BEFORE UPDATE ON pattern_reference_cohorts
  FOR EACH ROW
  EXECUTE FUNCTION pattern_reference_cohorts_identity_is_immutable();
