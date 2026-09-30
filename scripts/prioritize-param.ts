import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import {
  CORE_PARAMETERS_SQL,
  notSuppressedSql,
} from '../api/_lib/parameterGapsSql.js';

const sql = neon(process.env.DATABASE_URL!);

// A0: manually flagged parameters
const flagged = await sql`
  SELECT f.id, f.drug_id, f.parameter, f.note, d.slug, d.names
  FROM parameter_priority_flags f
  JOIN drugs d ON d.id = f.drug_id
  WHERE f.status = 'active'
  ORDER BY f.created_at ASC
  LIMIT 5
`;
console.log("A0_FLAGS:" + JSON.stringify(flagged));

// A: missing core PK/chemistry data (most popular drugs).
//
// "Core" is CORE_COVERAGE_PARAMETERS — the one ordered list shared with
// GET /api/agent-sweep?mode=parameter_gaps and with §3 tier A of the agent
// prompt. It used to be spelled out here as a separate array, which let this
// script and the prompt disagree about what counts as a gap.
//
// The suppression clause is now *imported*, not mirrored. This file used to
// restate the three reasons and claimed to "mirror the API lane exactly"; when
// the absent cooldown learned to be superseded by newer evidence, the API
// learned it and this did not, so the dev view kept hiding a pair the queue
// had reopened. A copy that promises to track another copy is the promise that
// keeps breaking here.
//
// Without these clauses this is a memoryless scan: a parameter that is
// undefined for the substance, or that an exhaustive search already came back
// empty on, stays "missing" forever and is re-served every cycle. That is the
// failure that had the hourly routine reporting benzoylecgonine's
// bioavailability on every run.
//
// Sent through `sql.query` rather than the tagged template because the shared
// helpers return SQL text: the registry lists arrive already inlined (and
// guarded on the way in), and there is nothing left to bind.
const missing = await sql.query(`
  SELECT d.id, d.slug, d.names, d.popularity_score, d.substance_class,
         missing.missing_count, missing.missing_parameters
  FROM drugs d
  JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE open) AS missing_count,
      array_agg(core ORDER BY core) FILTER (WHERE open) AS missing_parameters
    FROM (
      SELECT core,
        NOT EXISTS (
          SELECT 1 FROM drug_parameters dp
          WHERE dp.drug_id = d.id AND dp.parameter = core
        )
        AND ${notSuppressedSql({
          drugId: 'd.id',
          parameter: 'core',
          substanceClass: 'd.substance_class',
        })} AS open
      FROM unnest(${CORE_PARAMETERS_SQL}) AS core
    ) scored
  ) missing ON true
  WHERE missing.missing_count > 0
  ORDER BY d.popularity_score DESC
  LIMIT 20
`);
console.log("A_MISSING:" + JSON.stringify(missing));

// B: stalest verified (drug, parameter) pair that has a non-null value.
// DISTINCT ON picks the oldest row per pair; the outer ORDER BY then sorts
// those representatives by verified_at so LIMIT 10 returns the globally
// stale pairs rather than the lowest-ID ones.
const stalest = await sql`
  SELECT drug_id, parameter, verified_at, slug, names
  FROM (
    SELECT DISTINCT ON (vl.target_id, vl.parameter)
      vl.target_id AS drug_id, vl.parameter, vl.verified_at,
      d.slug, d.names
    FROM verification_log vl
    JOIN drugs d ON d.id = vl.target_id
    WHERE vl.target_type = 'parameter'
      AND vl.parameter IS NOT NULL
      AND vl.concordance IS DISTINCT FROM 'absent'
    ORDER BY vl.target_id, vl.parameter, vl.verified_at ASC
  ) oldest_per_pair
  ORDER BY verified_at ASC
  LIMIT 10
`;
console.log("B_STALEST:" + JSON.stringify(stalest));

// C: parameters challenged by a non-agent discussion comment in the last 7 days
const challenged = await sql`
  SELECT DISTINCT dpd.drug_id, dpd.parameter,
    d.slug, d.names
  FROM drug_parameter_discussions dpd
  JOIN drugs d ON d.id = dpd.drug_id
  WHERE dpd.parameter IS NOT NULL
    AND dpd.created_at > NOW() - INTERVAL '7 days'
    AND dpd.created_by != ${Number(process.env.AGENT_USER_ID)}
  LIMIT 10
`;
console.log("C_CHALLENGED:" + JSON.stringify(challenged));
