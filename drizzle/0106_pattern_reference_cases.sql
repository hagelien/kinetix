-- The atlas below the admission record (spec §18.2–18.6, plan §10 Phase 3).
--
-- Five tables hanging off `pattern_reference_cohorts`, which 0105 made the one
-- way in. Everything here reaches the atlas through a cohort, so invariant 31
-- is answered by construction: there is no path to atlas data nobody admitted.
--
-- The foreign keys down this chain CASCADE, deliberately and in the opposite
-- direction from the citation key on the cohort itself. Deleting a cohort
-- means withdrawing an admission, and an observation that outlived the
-- admission it arrived under is exactly the row invariant 31 forbids. What
-- must never cascade is the *citation* — see 0105, where that key is RESTRICT.
--
-- `source_locator` sits on every table rather than at case and observation
-- level only (§18.4). One reference case is routinely assembled from four
-- places in a paper: dose and route from a methods table, collection timing
-- from a figure caption, postmortem interval from the narrative,
-- concentrations from a results table. A single locator would be right for
-- some columns and wrong for others, which is worse than none — it reads as
-- provenance and is not.
CREATE TABLE IF NOT EXISTS pattern_reference_cases (
  id                     SERIAL PRIMARY KEY,
  cohort_id              INTEGER NOT NULL
                           REFERENCES pattern_reference_cohorts(id) ON DELETE CASCADE,

  -- Publication- or dataset-local and pseudonymous: "case 3", "subject B".
  -- Never a patient identifier — this table is a transcription of a published
  -- paper, and the paper's own key is the only one that can be checked against
  -- it (§18.2).
  source_subject_key     TEXT NOT NULL,
  sex                    VARCHAR(20),
  age                    NUMERIC,

  -- Nullable, and read as an override: the effective origin is this value
  -- where present and the cohort's otherwise (§18.2).
  --
  -- The cohort carries it because a cohort is normally one study with one
  -- design. A cohort assembled from case reports that genuinely differ — one
  -- anchored on death, another on a declared exposure — sets it per case, and
  -- without that the two cases would be compared as if their hour zero meant
  -- the same thing.
  time_origin            VARCHAR(40),
  context_json           JSONB,
  source_locator         TEXT NOT NULL,

  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW(),

  -- §7.3's vocabulary, the same one a case uses, so the two are compared
  -- rather than translated. A value outside it is not a stricter origin — it
  -- is an origin the matcher cannot read, and it would silently drop the case
  -- out of every time-conditioned comparison instead of failing at import.
  CONSTRAINT pattern_reference_cases_time_origin_vocabulary CHECK (
    time_origin IS NULL
    OR time_origin IN ('first_specimen_collection', 'declared_exposure', 'death', 'admission')
  ),
  CONSTRAINT pattern_reference_cases_locator_present CHECK (source_locator ~ '\S'),
  -- The paper's key for this subject, stored with no surrounding whitespace
  -- rather than merely non-blank. The uniqueness index below compares bytes,
  -- so 'case 1' and 'case 1 ' are two subjects to it and one to everyone else
  -- — a re-import with incidental whitespace would double every count the
  -- atlas reports for that study.
  --
  -- Written as a regex, not `= btrim(...)`: one-argument btrim strips ordinary
  -- spaces and nothing else, so a key ending in a tab or a newline — which is
  -- what a CSV column or a copied table cell brings — passed that test and
  -- still counted twice. `\s` covers the whole class. Every non-blank and
  -- no-padding check in this file is written the same way for the same reason.
  CONSTRAINT pattern_reference_cases_subject_key_present CHECK (
    source_subject_key ~ '\S' AND source_subject_key !~ '^\s|\s$'
  ),
  CONSTRAINT pattern_reference_cases_age_non_negative CHECK (age IS NULL OR age >= 0),
  -- NUMERIC admits 'NaN' and 'Infinity', and NaN sorts *above* every finite
  -- value, so the bound above lets both through — and `resolveValue` only
  -- rejects what is below zero. Checked on every numeric column in these
  -- tables, not just this one.
  CONSTRAINT pattern_reference_cases_age_finite CHECK (
      (age IS NULL OR age NOT IN ('NaN', 'Infinity', '-Infinity'))
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_cases_cohort_idx
  ON pattern_reference_cases (cohort_id);
--> statement-breakpoint

-- One row per subject per cohort. A second import of the same dataset under
-- the same admission is the same subjects, and without this the atlas counts
-- them twice — which is not a display bug but a wrong denominator under every
-- percentile the ladder reports.
CREATE UNIQUE INDEX IF NOT EXISTS pattern_reference_cases_subject_idx
  ON pattern_reference_cases (cohort_id, source_subject_key);
--> statement-breakpoint

-- §18.3. What the paper says was taken, with the certainty it says it.
CREATE TABLE IF NOT EXISTS pattern_reference_exposures (
  id                     SERIAL PRIMARY KEY,
  case_id                INTEGER NOT NULL
                           REFERENCES pattern_reference_cases(id) ON DELETE CASCADE,
  drug_id                INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,
  -- confirmed | reported | suspected
  certainty              VARCHAR(20) NOT NULL,
  amount                 NUMERIC,
  amount_unit            VARCHAR(40),
  route                  VARCHAR(40),
  -- Against the case's effective origin, never against wall-clock time.
  time_relative_hours    NUMERIC,
  time_low_hours         NUMERIC,
  time_high_hours        NUMERIC,
  regimen_json           JSONB,
  source_locator         TEXT NOT NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT pattern_reference_exposures_certainty_vocabulary CHECK (
    certainty IN ('confirmed', 'reported', 'suspected')
  ),
  -- An interval with one end is not an interval. A row carrying only a low
  -- bound reads as "from here on", which is not what a paper reporting a
  -- window said, and the matcher cannot tell the two apart afterwards.
  CONSTRAINT pattern_reference_exposures_window_complete CHECK (
    (time_low_hours IS NULL) = (time_high_hours IS NULL)
  ),
  CONSTRAINT pattern_reference_exposures_window_ordered CHECK (
    time_low_hours IS NULL OR time_high_hours >= time_low_hours
  ),
  -- A row carrying both has to mean one thing. "Ten hours before, somewhere
  -- between two and six hours before" is two answers, and which one a consumer
  -- gets depends on which column it happens to read.
  CONSTRAINT pattern_reference_exposures_point_within_window CHECK (
    time_relative_hours IS NULL
    OR time_low_hours IS NULL
    OR (time_relative_hours >= time_low_hours AND time_relative_hours <= time_high_hours)
  ),
  -- A quantity with no unit is a number somebody will read as milligrams —
  -- and a blank unit is no unit with a column that looks filled in.
  CONSTRAINT pattern_reference_exposures_amount_unit CHECK (
    amount IS NULL OR coalesce(amount_unit, '') ~ '\S'
  ),
  CONSTRAINT pattern_reference_exposures_locator_present CHECK (source_locator ~ '\S'),
  CONSTRAINT pattern_reference_exposures_unit_trimmed CHECK (
    amount_unit IS NULL OR amount_unit !~ '^\s|\s$'
  ),
  -- An administered amount is a magnitude. A negative one is an impossible
  -- dose that dose-conditioned matching would read as real.
  CONSTRAINT pattern_reference_exposures_amount_non_negative CHECK (
    amount IS NULL OR amount >= 0
  ),
  CONSTRAINT pattern_reference_exposures_finite CHECK (
      (amount IS NULL OR amount NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (time_relative_hours IS NULL OR time_relative_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (time_low_hours IS NULL OR time_low_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (time_high_hours IS NULL OR time_high_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_exposures_case_idx
  ON pattern_reference_exposures (case_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_exposures_drug_idx
  ON pattern_reference_exposures (drug_id);
--> statement-breakpoint

-- §18.4. What was collected, when, and under what conditions.
CREATE TABLE IF NOT EXISTS pattern_reference_specimens (
  id                          SERIAL PRIMARY KEY,
  case_id                     INTEGER NOT NULL
                                REFERENCES pattern_reference_cases(id) ON DELETE CASCADE,
  matrix                      VARCHAR(40) NOT NULL,
  collection_relative_hours   NUMERIC,
  -- Femoral blood and heart blood are not interchangeable in a postmortem
  -- case, and a band matched across them is comparing two different numbers.
  blood_site                  VARCHAR(40),
  postmortem_interval_hours   NUMERIC,
  urine_creatinine_mmol_l     NUMERIC,
  urine_specific_gravity      NUMERIC,
  urine_ph                    NUMERIC,
  urine_volume_ml             NUMERIC,
  collection_duration_hours   NUMERIC,
  metadata_json               JSONB,
  source_locator              TEXT NOT NULL,
  created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT pattern_reference_specimens_locator_present CHECK (source_locator ~ '\S'),
  -- Matrix is matching context: blood and urine are not compared, and a blank
  -- one is a third matrix that matches nothing while looking like a value.
  -- `PatternMatrix`, the vocabulary matching compares against. A specimen
  -- recorded as 'blood' is not a coarser statement — whole, femoral and
  -- cardiac blood are separate values there, and none of them is that string,
  -- so the specimen silently misses every blood-compatible reference set.
  -- 'other' is the escape value for a matrix the vocabulary has no name for.
  -- Durations and quantities, all of them magnitudes. `collection_relative_hours`
  -- is deliberately not here: it is measured from the case's origin and is
  -- negative before it, which is the ordinary case for a specimen taken before
  -- a declared exposure. A postmortem interval is a duration from death to
  -- collection, so a negative one is an impossible chronology rather than an
  -- earlier moment.
  CONSTRAINT pattern_reference_specimens_durations_non_negative CHECK (
    (postmortem_interval_hours IS NULL OR postmortem_interval_hours >= 0)
    AND (collection_duration_hours IS NULL OR collection_duration_hours >= 0)
    -- Strictly positive: creatinine is a denominator, and `creatinineFactor`
    -- returns null at or below zero. Stored as 0 the specimen shows an
    -- impossible measurement and quietly drops out of every
    -- creatinine-normalized comparison it was recorded for.
    AND (urine_creatinine_mmol_l IS NULL OR urine_creatinine_mmol_l > 0)
    AND (urine_volume_ml IS NULL OR urine_volume_ml >= 0)
    AND (urine_specific_gravity IS NULL OR urine_specific_gravity > 0)
    AND (urine_ph IS NULL OR (urine_ph >= 0 AND urine_ph <= 14))
  ),
  CONSTRAINT pattern_reference_specimens_finite CHECK (
      (collection_relative_hours IS NULL OR collection_relative_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (postmortem_interval_hours IS NULL OR postmortem_interval_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (urine_creatinine_mmol_l IS NULL OR urine_creatinine_mmol_l NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (urine_specific_gravity IS NULL OR urine_specific_gravity NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (urine_ph IS NULL OR urine_ph NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (urine_volume_ml IS NULL OR urine_volume_ml NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (collection_duration_hours IS NULL OR collection_duration_hours NOT IN ('NaN', 'Infinity', '-Infinity'))
    ),
  CONSTRAINT pattern_reference_specimens_matrix_vocabulary CHECK (
    matrix IN (
      'whole_blood', 'femoral_blood', 'cardiac_blood', 'serum', 'plasma',
      'urine', 'vitreous', 'other'
    )
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_specimens_case_idx
  ON pattern_reference_specimens (case_id);
--> statement-breakpoint

-- §18.5. Raw published values, never precomputed ratios.
--
-- A stored ratio cannot be recomputed when a feature definition improves, and
-- the whole atlas has to be recomputable from what the papers reported (§18.5).
-- A ratio is also a claim about two measurements that a single number cannot
-- carry: which species, which matrix, whether either side was censored.
CREATE TABLE IF NOT EXISTS pattern_reference_observations (
  id                     SERIAL PRIMARY KEY,
  specimen_id            INTEGER NOT NULL
                           REFERENCES pattern_reference_specimens(id) ON DELETE CASCADE,
  drug_id                INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,

  -- Usually null, and that is the ordinary case rather than missing data: a
  -- published reference was not measured by one of this installation's
  -- methods. Which is why the measurand below is transcribed rather than
  -- inherited from a method row that does not exist (§18.5).
  analytical_method_id   INTEGER REFERENCES analytical_methods(id) ON DELETE SET NULL,

  -- Transcribed from the paper; 'unknown' where it is silent, which
  -- downgrades the reference rather than matching it (§7.2, §20).
  measurand_mode         VARCHAR(40) NOT NULL DEFAULT 'unknown',
  -- The species defining the paper's mass basis. A morphine concentration
  -- reported as morphine and one reported as morphine sulfate differ by a
  -- constant nobody applies twice.
  reported_as_drug_id    INTEGER REFERENCES drugs(id) ON DELETE RESTRICT,
  -- Prose. The structured fields above are what drives matching.
  hydrolysis_note        TEXT,

  value                  NUMERIC,
  unit                   VARCHAR(40),
  -- `PatternObservationQualifier`, and wide enough for it:
  -- 'detected_not_quantified' is 23 characters, so a VARCHAR(20) would have
  -- refused the ordinary censored state at import with a length error.
  -- NOT NULL: `resolveValue` falls to its default branch without one and
  -- returns indeterminate, so a row that does not say which state it is in
  -- carries a number nothing reads.
  qualifier              VARCHAR(40) NOT NULL,

  -- The source's own name for its limit (§9.1): "LOQ", "LOD", "cutoff" and
  -- "reporting limit" are not synonyms, and relabelling a paper's threshold
  -- to a house vocabulary misstates what it measured.
  limit_label            TEXT,
  limit_value            NUMERIC,
  limit_unit             VARCHAR(40),
  -- Only where the paper cites a second, lower limit.
  lower_limit_label      TEXT,
  lower_limit_value      NUMERIC,
  lower_limit_unit       VARCHAR(40),

  uncertainty_cv         NUMERIC,
  source_locator         TEXT NOT NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),

  -- A value with no unit is unusable, and a censored row with no limit is a
  -- "<" with nothing after it.
  CONSTRAINT pattern_reference_observations_value_unit CHECK (
    value IS NULL OR coalesce(unit, '') ~ '\S'
  ),
  -- Each threshold carries its own unit and they need not agree (§9.1): a
  -- paper can report a cutoff in ng/mL beside an LOD in nmol/L.
  -- Each threshold carries its own unit *and* its own name (§9.1). "LOD",
  -- "LOQ", "cutoff" and "reporting limit" are not synonyms: a value below an
  -- LOD and a value below an administrative cutoff say different things about
  -- what was in the sample, and a number with no name cannot be read back as
  -- either. There is always something to record — the paper's own phrase, if
  -- nothing shorter — and inventing a name is a curation decision somebody
  -- makes deliberately rather than a null nobody notices.
  CONSTRAINT pattern_reference_observations_limit_unit CHECK (
    limit_value IS NULL
    OR (coalesce(limit_unit, '') ~ '\S' AND coalesce(limit_label, '') ~ '\S')
  ),
  CONSTRAINT pattern_reference_observations_lower_limit_unit CHECK (
    lower_limit_value IS NULL
    OR (
      coalesce(lower_limit_unit, '') ~ '\S'
      AND coalesce(lower_limit_label, '') ~ '\S'
    )
  ),
  -- What a row must carry depends on which state it is in, because that is
  -- what `resolveValue` reads. A quantified result resolves from its value and
  -- ignores any limit; the four censored states resolve from the limit and
  -- ignore any value. So a 'quantified' row holding only a threshold, and a
  -- 'below_limit' row holding only an exact number, both resolve to
  -- indeterminate while looking on the page like complete observations.
  --
  -- A censored row carries no value: `resolveValue` reads the limit and
  -- ignores any number beside it, so one stored there is a measurement the
  -- screen never shows. A quantified row may carry a limit, and usually does —
  -- "12 nmol/L (LOQ 5)" is how a laboratory reports one, and `PatternLimitRef`
  -- exists to hold exactly that.
  CONSTRAINT pattern_reference_observations_content_by_qualifier CHECK (
    CASE qualifier
      WHEN 'quantified' THEN value IS NOT NULL
      ELSE value IS NULL AND limit_value IS NOT NULL
    END
  ),
  -- Zero is kept: §8.1 makes a quantified zero a real result. Below it is not
  -- a measurement, and `resolveValue` already reads one as indeterminate.
  CONSTRAINT pattern_reference_observations_value_non_negative CHECK (
    value IS NULL OR value >= 0
  ),
  CONSTRAINT pattern_reference_observations_locator_present CHECK (source_locator ~ '\S'),
  -- Units are looked up by string to convert a value into the case's basis.
  -- A padded one converts to nothing, which reads downstream as a value that
  -- could not be resolved rather than as a transcription slip.
  CONSTRAINT pattern_reference_observations_units_trimmed CHECK (
    (unit IS NULL OR unit !~ '^\s|\s$')
    AND (limit_unit IS NULL OR limit_unit !~ '^\s|\s$')
    AND (lower_limit_unit IS NULL OR lower_limit_unit !~ '^\s|\s$')
  ),
  CONSTRAINT pattern_reference_observations_finite CHECK (
      (value IS NULL OR value NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (limit_value IS NULL OR limit_value NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (lower_limit_value IS NULL OR lower_limit_value NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (uncertainty_cv IS NULL OR uncertainty_cv NOT IN ('NaN', 'Infinity', '-Infinity'))
    ),
  -- 'unknown' is the value for a paper that said nothing, and it downgrades
  -- the reference rather than matching. Blank is not that value; it is a mode
  -- outside the vocabulary that no rule in §20 is written about.
  -- The closed vocabulary matching is written against
  -- (`PatternMeasurandMode`). A mode outside it is not a stricter statement
  -- about the assay — it is one no rule in §20 covers, so the reference would
  -- drop out of compatible-reference matching without ever failing. 'unknown'
  -- is the value for a paper that said nothing, and it downgrades rather than
  -- matching.
  CONSTRAINT pattern_reference_observations_measurand_mode_vocabulary CHECK (
    measurand_mode IN (
      'direct', 'free', 'direct_conjugate', 'total_after_hydrolysis',
      'class_response', 'unknown'
    )
  ),
  -- Likewise `PatternObservationQualifier`. A transcribed '<' is not one of
  -- these: the atlas records the state, and the glyph is a rendering decision
  -- §9.1 makes at the screen.
  CONSTRAINT pattern_reference_observations_qualifier_vocabulary CHECK (
    qualifier IS NULL
    OR qualifier IN (
      'quantified', 'below_limit', 'above_limit', 'detected_not_quantified',
      'not_detected'
    )
  ),
  -- The lower threshold is below the primary one, where the two can be
  -- compared at all. Reversed, they reconstruct no interval: a
  -- detected-but-not-quantified result bounded below by a number above its own
  -- upper bound is not a reading of anything.
  --
  -- Only when both carry the same unit. §9.1 lets each threshold state its
  -- own — a cutoff in ng/mL beside an LOD in nmol/L is an ordinary pair — and
  -- converting between them needs the analyte's molecular weight, which is a
  -- fact about the catalog rather than about this row. That comparison belongs
  -- to the importer; this is the half the database can decide.
  CONSTRAINT pattern_reference_observations_lower_limit_below_limit CHECK (
    lower_limit_value IS NULL
    OR limit_value IS NULL
    OR lower_limit_unit IS DISTINCT FROM limit_unit
    OR lower_limit_value < limit_value
  ),
  -- A bound at or below zero states nothing, and `resolveValue` already reads
  -- one as indeterminate — so a row carrying it contributes no interval and
  -- looks like a censored result that should. Refused where it is written
  -- rather than discarded where it is read.
  -- A second, lower threshold is second to something. Alone, it is a bound
  -- the row cannot place: §9.1's two-threshold interval needs both ends, and
  -- `resolveValue` reads `limitRef` — nothing looks here on its own.
  CONSTRAINT pattern_reference_observations_lower_limit_is_second CHECK (
    lower_limit_value IS NULL OR limit_value IS NOT NULL
  ),
  CONSTRAINT pattern_reference_observations_limits_positive CHECK (
    (limit_value IS NULL OR limit_value > 0)
    AND (lower_limit_value IS NULL OR lower_limit_value > 0)
  ),
  CONSTRAINT pattern_reference_observations_uncertainty_non_negative CHECK (
    uncertainty_cv IS NULL OR uncertainty_cv >= 0
  ),

  -- A method and an analyte, not a method and any analyte. Checked
  -- separately, the two keys say only that both rows exist — so an
  -- observation could name a method that does not measure this substance, and
  -- that method's reporting limits and uncertainty would then be read as
  -- though they applied to it. The composite key is against the membership
  -- itself.
  --
  -- MATCH SIMPLE, which is the default and is what makes the usual case work:
  -- `analytical_method_id` is null for a published reference, and a partly
  -- null key is not checked. SET NULL names its column because `drug_id` is
  -- NOT NULL — dropping a method's component clears the method from the
  -- observation and leaves the analyte, which is the transcription, alone.
  CONSTRAINT pattern_reference_observations_method_component
    FOREIGN KEY (analytical_method_id, drug_id)
    REFERENCES analytical_method_components(method_id, drug_id)
    ON DELETE SET NULL (analytical_method_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_observations_specimen_idx
  ON pattern_reference_observations (specimen_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_observations_drug_idx
  ON pattern_reference_observations (drug_id);
--> statement-breakpoint

-- §18.6, Tier C. Studies reporting only summary statistics.
--
-- A separate table rather than a flag on the individual tables, because the
-- rules that keep this tier from leaking into individual-level claims are then
-- structural: no individual percentile can be computed from a row that is not
-- a row about an individual, and aggregates cannot pool with individuals in a
-- query that has to name one table or the other.
CREATE TABLE IF NOT EXISTS pattern_reference_aggregates (
  id                     SERIAL PRIMARY KEY,
  cohort_id              INTEGER NOT NULL
                           REFERENCES pattern_reference_cohorts(id) ON DELETE CASCADE,
  drug_id                INTEGER REFERENCES drugs(id) ON DELETE RESTRICT,
  matrix                 VARCHAR(40),

  -- The same transcribed measurand the individual observations carry. An
  -- envelope identified only by drug and matrix cannot be matched safely: a
  -- published total-after-hydrolysis range against a case's free concentration
  -- is invalid and looks entirely reasonable on screen (§18.6).
  measurand_mode         VARCHAR(40) NOT NULL DEFAULT 'unknown',
  reported_as_drug_id    INTEGER REFERENCES drugs(id) ON DELETE RESTRICT,
  hydrolysis_note        TEXT,

  -- 'concentration' | 'feature'
  statistic_of           VARCHAR(20) NOT NULL,
  -- Set when statistic_of = 'feature', and admissible only when the study
  -- itself reported that feature's statistics. A feature aggregate derived by
  -- dividing two concentration aggregates is a ratio of published means, which
  -- is not a mean of individual ratios (invariant 17) — this column records
  -- what a paper said, and nothing computes it.
  feature_id             TEXT,
  feature_version        TEXT,

  n                      INTEGER,
  -- What the study itself reports below its limit. "12 of 40 were below the
  -- limit" tells you something the median cannot, and it feeds the
  -- quantified-only estimand (§21.1).
  n_censored             INTEGER,
  mean                   NUMERIC,
  sd                     NUMERIC,
  median                 NUMERIC,
  p25                    NUMERIC,
  p75                    NUMERIC,
  min                    NUMERIC,
  max                    NUMERIC,
  geometric_mean         NUMERIC,
  unit                   VARCHAR(40),

  limit_label            TEXT,
  limit_value            NUMERIC,
  limit_unit             VARCHAR(40),
  population_note        TEXT,
  source_locator         TEXT NOT NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT pattern_reference_aggregates_statistic_of_vocabulary CHECK (
    statistic_of IN ('concentration', 'feature')
  ),
  -- Both directions. A feature row with no feature names no statistic, and a
  -- concentration row carrying one claims a feature it did not report.
  CONSTRAINT pattern_reference_aggregates_feature_id_presence CHECK (
    (statistic_of = 'feature') = (feature_id IS NOT NULL)
  ),
  -- And the definition it was reported against. A feature is a formula that
  -- changes; an envelope naming the feature but not the version cannot be
  -- checked against the active definition, so it would be matched or pooled
  -- with envelopes computed a different way and read as one population.
  CONSTRAINT pattern_reference_aggregates_feature_version_presence CHECK (
    (feature_id IS NOT NULL) = (coalesce(feature_version, '') ~ '\S')
  ),
  -- And the identifier itself has to name a feature. Blank, it names none,
  -- and the row can be checked against no definition at all.
  -- Stored trimmed, like the subject key and for the same reason: feature
  -- definitions are matched by exact id, so 'eddp_mtd_b ' names no feature
  -- while looking like one. The version is compared the same way.
  CONSTRAINT pattern_reference_aggregates_feature_id_present CHECK (
    feature_id IS NULL OR (feature_id ~ '\S' AND feature_id !~ '^\s|\s$')
  ),
  CONSTRAINT pattern_reference_aggregates_feature_version_trimmed CHECK (
    feature_version IS NULL OR feature_version !~ '^\s|\s$'
  ),
  -- Units are looked up by string to convert a magnitude. A padded one
  -- converts to nothing.
  CONSTRAINT pattern_reference_aggregates_units_trimmed CHECK (
    (unit IS NULL OR unit !~ '^\s|\s$')
    AND (limit_unit IS NULL OR limit_unit !~ '^\s|\s$')
  ),
  CONSTRAINT pattern_reference_aggregates_measurand_mode_vocabulary CHECK (
    measurand_mode IN (
      'direct', 'free', 'direct_conjugate', 'total_after_hydrolysis',
      'class_response', 'unknown'
    )
  ),
  CONSTRAINT pattern_reference_aggregates_limit_positive CHECK (
    limit_value IS NULL OR limit_value > 0
  ),
  -- A concentration envelope needs a substance and a matrix to be matched at
  -- all; a feature carries its own operands and needs neither.
  CONSTRAINT pattern_reference_aggregates_concentration_subject CHECK (
    statistic_of <> 'concentration'
    OR (drug_id IS NOT NULL AND matrix IS NOT NULL)
  ),
  -- The same vocabulary as the specimens it is compared against.
  CONSTRAINT pattern_reference_aggregates_matrix_vocabulary CHECK (
    matrix IS NULL
    OR matrix IN (
      'whole_blood', 'femoral_blood', 'cardiac_blood', 'serum', 'plasma',
      'urine', 'vitreous', 'other'
    )
  ),
  CONSTRAINT pattern_reference_aggregates_limit_unit CHECK (
    limit_value IS NULL
    OR (coalesce(limit_unit, '') ~ '\S' AND coalesce(limit_label, '') ~ '\S')
  ),
  -- A concentration envelope reporting magnitudes needs the unit they are in.
  -- It cannot otherwise be converted to the basis an observation is held in,
  -- and an envelope with a drug, a matrix and a bare number reads as though it
  -- were already canonical. A feature is dimensionless or carries its unit in
  -- its definition, so this asks only of concentrations.
  CONSTRAINT pattern_reference_aggregates_concentration_unit CHECK (
    statistic_of <> 'concentration'
    OR coalesce(mean, sd, median, p25, p75, min, max, geometric_mean) IS NULL
    OR coalesce(unit, '') ~ '\S'
  ),
  -- The censored count is part of the same n. A study cannot report more
  -- below its limit than it measured, and a negative count is a transcription
  -- error that would otherwise inflate the quantified denominator.
  -- And the total it is part of. "12 below the limit" out of nothing gives
  -- neither the quantified count nor the censoring fraction, which is the
  -- whole reason §21.1 asks studies for the censored count in the first place.
  CONSTRAINT pattern_reference_aggregates_censored_within_n CHECK (
    n_censored IS NULL OR (n_censored >= 0 AND n IS NOT NULL AND n_censored <= n)
  ),
  -- And n itself. Constraining the censored count against a negative n checks
  -- one number against another that is already nonsense — and this one is the
  -- denominator every eligibility threshold and every displayed count reads.
  -- Positive, not merely non-negative: n = 0 satisfies the has-content rule
  -- below while representing no subjects and providing no denominator, so it
  -- is an empty row wearing a number.
  CONSTRAINT pattern_reference_aggregates_n_positive CHECK (
    n IS NULL OR n > 0
  ),
  -- Summaries that are not summaries. A negative spread, a maximum below its
  -- own minimum, a third quartile below the first: each is a transcription
  -- error that reaches the screen as an envelope drawn backwards rather than
  -- as anything that looks wrong.
  CONSTRAINT pattern_reference_aggregates_sd_non_negative CHECK (sd IS NULL OR sd >= 0),
  -- Whatever the statistic is over. A feature can be signed — a log ratio is —
  -- but a geometric mean is the exponential of a mean of logarithms, so a
  -- negative one is not a summary of anything, and the concentration-only rule
  -- below leaves it to this.
  CONSTRAINT pattern_reference_aggregates_geometric_mean_non_negative CHECK (
    geometric_mean IS NULL OR geometric_mean >= 0
  ),
  -- The whole order, over whichever parts the paper reported: endpoints
  -- checked pairwise still accept min 10, p25 5, median 20, p75 15, max 30 —
  -- every pair sound in isolation and the envelope drawn backwards.
  CONSTRAINT pattern_reference_aggregates_summary_ordered CHECK (
    (min IS NULL OR p25 IS NULL OR p25 >= min)
    AND (min IS NULL OR median IS NULL OR median >= min)
    AND (min IS NULL OR p75 IS NULL OR p75 >= min)
    AND (min IS NULL OR max IS NULL OR max >= min)
    AND (p25 IS NULL OR median IS NULL OR median >= p25)
    AND (p25 IS NULL OR p75 IS NULL OR p75 >= p25)
    AND (p25 IS NULL OR max IS NULL OR max >= p25)
    AND (median IS NULL OR p75 IS NULL OR p75 >= median)
    AND (median IS NULL OR max IS NULL OR max >= median)
    AND (p75 IS NULL OR max IS NULL OR max >= p75)
    -- The means sit inside the extrema too. A sample mean outside its own
    -- observed range is not a summary of that sample, and left out of the
    -- chain it passes every comparison above.
    AND (min IS NULL OR mean IS NULL OR mean >= min)
    AND (max IS NULL OR mean IS NULL OR mean <= max)
    AND (min IS NULL OR geometric_mean IS NULL OR geometric_mean >= min)
    AND (max IS NULL OR geometric_mean IS NULL OR geometric_mean <= max)
  ),
  -- A concentration is a magnitude. A feature can legitimately be signed — a
  -- log ratio is — so this asks only of concentration envelopes, where a
  -- negative summary is a transcription error that later calculations would
  -- treat as a real published value.
  CONSTRAINT pattern_reference_aggregates_concentration_non_negative CHECK (
    statistic_of <> 'concentration'
    OR (
      (mean IS NULL OR mean >= 0)
      AND (median IS NULL OR median >= 0)
      AND (p25 IS NULL OR p25 >= 0)
      AND (p75 IS NULL OR p75 >= 0)
      AND (min IS NULL OR min >= 0)
      AND (max IS NULL OR max >= 0)
      AND (geometric_mean IS NULL OR geometric_mean >= 0)
    )
  ),
  -- And the row has to report something. A concentration row with a drug and
  -- a matrix and no numbers, or a feature row with only its identifier, backs
  -- no envelope and no count — but it is atlas data to everything that asks
  -- whether a cohort was imported, including the merge above.
  CONSTRAINT pattern_reference_aggregates_has_content CHECK (
    n IS NOT NULL
    OR n_censored IS NOT NULL
    OR limit_value IS NOT NULL
    OR coalesce(mean, sd, median, p25, p75, min, max, geometric_mean) IS NOT NULL
  ),
  CONSTRAINT pattern_reference_aggregates_locator_present CHECK (source_locator ~ '\S'),
  CONSTRAINT pattern_reference_aggregates_finite CHECK (
      (mean IS NULL OR mean NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (sd IS NULL OR sd NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (median IS NULL OR median NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (p25 IS NULL OR p25 NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (p75 IS NULL OR p75 NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (min IS NULL OR min NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (max IS NULL OR max NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (geometric_mean IS NULL OR geometric_mean NOT IN ('NaN', 'Infinity', '-Infinity'))
      AND (limit_value IS NULL OR limit_value NOT IN ('NaN', 'Infinity', '-Infinity'))
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pattern_reference_aggregates_cohort_idx
  ON pattern_reference_aggregates (cohort_id);
--> statement-breakpoint

-- §7.3's vocabulary on the cohort too. 0105 made the column NOT NULL, which
-- says a value is present and nothing about it being one the matcher reads.
ALTER TABLE pattern_reference_cohorts
  DROP CONSTRAINT IF EXISTS pattern_reference_cohorts_time_origin_vocabulary;
--> statement-breakpoint

ALTER TABLE pattern_reference_cohorts
  ADD CONSTRAINT pattern_reference_cohorts_time_origin_vocabulary CHECK (
    time_origin IN ('first_specimen_collection', 'declared_exposure', 'death', 'admission')
  );
--> statement-breakpoint

-- Raise from inside a statement, so a fold that cannot complete takes its own
-- writes down with it.
--
-- `repointReferenceCohorts` moves the atlas rows, records the fold and deletes
-- the folded cohort in one statement. Every data-modifying CTE in a statement
-- runs whether or not the final query consumes it, so a delete refused by its
-- own guard — another merge appended to the folded row's notes between the
-- snapshot and the write — would otherwise leave the move and the record
-- committed while the merge reported failure. There is no surrounding
-- transaction over the http driver to undo that afterwards, so the statement
-- has to fail rather than the caller.
CREATE OR REPLACE FUNCTION pattern_reference_fold_refused(reason TEXT)
RETURNS INTEGER AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = reason, ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
