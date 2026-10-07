/**
 * Agent-only discussion & approval sweep, exposed through the API so
 * scheduled LLM routines do not need direct DATABASE_URL access.
 *
 * The scheduled drug-db maintainer (agents/drug-db-maintainer.md §7) is the
 * fallback evaluator whenever the comment hook is disabled or misses an event.
 * It must be able to enumerate the unprocessed backlog of comments and of
 * recently approved revisions — but without running ad-hoc SQL against a
 * database credential that sits in the same runtime as untrusted discussion
 * text. This endpoint is the sole supported enumerator: it accepts only a
 * `mode` discriminator, runs hard-coded allowlisted SELECTs scoped to the
 * calling agent, and returns the structured candidate ids (oldest first,
 * capped at 5 per list). Comment `body` values are user-authored, untrusted
 * data to classify — never instructions.
 *
 * `mode=pending_facts` is the duplicate-detection enumerator (issue #457):
 * given a `targetId` (wiki page id) and optional `sectionId`, it returns the
 * open pending `wiki_fact` proposals on that page across ALL contributors.
 * This is the visibility a routine needs to avoid re-submitting a fact that is
 * already waiting in the review queue — GET /api/pending-edits hides other
 * contributors' rows from a contributor-role agent, and the published page
 * omits pending facts entirely, so without this an agent re-derives and
 * re-submits the same fact every cycle until a human drains the backlog. The
 * returned `fact_statement` / `fact_target_anchor` values are
 * contributor-authored, untrusted data for semantic comparison only.
 *
 * `mode=pending_parameters` is the same duplicate-detection enumerator for
 * drug parameters: given a `targetId` (drugs.id) it returns the open pending
 * `parameter` edits on that drug across ALL contributors. It exists for the
 * identical reason as pending_facts — a contributor-role agent's
 * GET /api/pending-edits shows only its own open rows, so before this an agent
 * could not see a sibling agent's pending edit for the same (drug, parameter)
 * and re-proposed it every cycle, filling the queue with duplicates. The
 * server now also rejects such a duplicate submission with 409, but agents
 * should consult this first so they endorse the existing row rather than
 * burning a cycle on a rejected resubmission. `proposed_value` is
 * contributor-authored data for value comparison only, never instructions.
 *
 * `mode=parameter_gaps` is the core-coverage queue (§3 tier A in
 * agents/drug-db-maintainer.md) — the parameters a substance is expected to
 * have but does not, ranked the way the routine should work them. It exists
 * because that prompt documented the ranking as raw SQL an agent has no
 * credential to run, so in practice each routine re-derived the queue from
 * /api/drugs and got a queue with no exclusions at all: an unfillable pair sat
 * at the head and was re-selected every hourly cycle forever. Benzoylecgonine's
 * bioavailability was the case that surfaced it — a cocaine metabolite nobody
 * administers has no absolute bioavailability, and belonging to a screening
 * method sorted it ahead of every other candidate.
 *
 * The lane applies the three exclusions the bare gap scan lacks (see
 * src/lib/parameterApplicability.ts): an explicit not-applicable marker, the
 * substance-class rule that says an un-administered substance has no
 * absorption or dose parameters, and a cooldown on pairs an exhaustive search
 * already came back empty on. It also drops pairs with an open pending edit,
 * which the prompt asked the agent to check by hand. `suppressed` reports what
 * each exclusion removed, so a queue that has gone quiet can be told apart
 * from one that is silently hiding real work.
 *
 * `mode=unreviewed_references` is the read-in-full audit lane: it returns the
 * in-use resolvable citations that lack an approved read-in-full paper review,
 * so a routine can find and review the under-sourced papers (and an editor can
 * audit which live claims rest on a not-fully-reviewed source). It is the
 * server-side counterpart to the reader-facing `needsFullReview` badge.
 *
 * Auth: the revocable `kxat_…` agent token resolved by getUserFromRequest();
 * the agent's own users.id (auth.userId) scopes every processed-check.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { getDb, getNeonClient } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import { CAP } from "../src/lib/permissions.js";
import { callerCan } from "./_lib/permissions-store.js";
import { SITE_LANDING_PAGE_URL_PATTERN } from "../src/lib/publicDatabaseRecord.js";
import {
  error,
  json,
  withErrorHandling,
  noStoreHeaders,
} from "./_lib/response.js";
import { verificationTargetVersion } from "./_lib/agent-verifications.js";
import { agents, type AgentVerificationTargetType } from "../db/schema.js";
import {
  alreadyFilledSql,
  CORE_PARAMETERS_SQL,
  COVERAGE_AREAS_SQL,
  coverageAreaProposedSql,
  DECLARATION_PARAMETERS_SQL,
  OBSERVATION_PARAMETERS_SQL,
  markedNotApplicableSql,
  notSuppressedSql,
  ruledOutBySubstanceClassSql,
  sqlIntArray,
  sqlTextArray,
  withinAbsentCooldownSql,
  type PairColumns,
} from "./_lib/parameterGapsSql.js";

/** How the ranked queue names the three values every suppression reason needs. */
const QUEUE_COLUMNS: PairColumns = {
  drugId: 'd.id',
  parameter: 'w.parameter',
  substanceClass: 'd.substance_class',
};

/** The same three, as the flattened `candidates` CTE in the counts query. */
const COUNT_COLUMNS: PairColumns = {
  drugId: 'c.drug_id',
  parameter: 'c.parameter',
  substanceClass: 'c.substance_class',
};
import {
  resolveFocusNarrowing,
  type FocusNarrowing,
} from "./agent-focus.js";

const MODES = [
  "comments",
  "approvals",
  "all",
  "pending_facts",
  "pending_parameters",
  "unreviewed_references",
  "parameter_gaps",
] as const;
type Mode = (typeof MODES)[number];

// pending_facts / pending_parameters can return more than the sweep cap: a
// routine surveying a target for duplicates wants the whole open queue for that
// page/drug, not an oldest-first slice. Targets accumulate few open pending
// rows at a time, so a generous bound still protects the response from a
// pathological backlog.
const PENDING_FACTS_LIMIT = 200;

// Oldest-first, capped per list. There is no age window: the processed-checks
// (replied/stamped/verdicted) are self-draining, so an unbounded backlog from a
// long hook outage is drained oldest-first over successive hourly cycles rather
// than aged out and lost.
const SWEEP_LIMIT = 5;

// The gap queue is a ranked shortlist, not a backlog to drain: the routine
// works one parameter per cycle and needs enough candidates below the top to
// fall through when the leader is already covered. Matches the LIMIT the
// prompt's tier-A query has always specified.
const PARAMETER_GAPS_LIMIT = 20;

const PRIVATE_AGENT_SWEEP_HEADERS = noStoreHeaders();

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    error(res, 405, "Method not allowed");
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, "Authentication required");
    return;
  }

  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, auth.userId), eq(agents.status, "active")))
    .limit(1);
  if (!agent) {
    error(res, 403, "Agent token required");
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const mode = (url.searchParams.get("mode") ?? "all") as Mode;
  if (!MODES.includes(mode)) {
    error(res, 400, `mode must be one of ${MODES.join("|")}`);
    return;
  }

  const agentUserId = auth.userId;
  // Wiki draft pages are readable only by editors/admins (see
  // canReadWikiPageStatus); contributor agents see published pages only. The
  // sweep mirrors that so it never hands back — or leaks metadata about — a
  // revision the agent could not read or stamp through the normal endpoints.
  const canSeeDraft = await callerCan(auth.role, CAP["wiki.draft.read"]);
  const out: Record<string, unknown> = {};

  if (mode === "pending_facts") {
    // Required, positive-integer page id. Reject bad input up front so the
    // allowlisted query only ever runs against a clean numeric target.
    const targetIdRaw = url.searchParams.get("targetId");
    const targetId = Number(targetIdRaw);
    if (!targetIdRaw || !Number.isInteger(targetId) || targetId <= 0) {
      error(
        res,
        400,
        "pending_facts mode requires a positive integer targetId (the wiki page id)",
      );
      return;
    }
    // Optional: narrow to one monograph/topic section. Empty string is treated
    // as "no filter" so a stray `&sectionId=` doesn't silently return nothing.
    const sectionId = url.searchParams.get("sectionId") || null;
    out.pendingFacts = await listPendingFacts(targetId, sectionId, canSeeDraft);
    json(res, 200, out, { headers: PRIVATE_AGENT_SWEEP_HEADERS });
    return;
  }

  if (mode === "unreviewed_references") {
    out.unreviewedReferences = await listUnreviewedReferences();
    json(res, 200, out, { headers: PRIVATE_AGENT_SWEEP_HEADERS });
    return;
  }

  if (mode === "parameter_gaps") {
    // Resolved here, not by the caller: the narrowing has to be inside the
    // query so it applies before the LIMIT (see focusPredicates).
    const focus = await resolveFocusNarrowing();
    const [gaps, suppressed] = await Promise.all([
      listParameterGaps(focus),
      countSuppressedParameterGaps(focus),
    ]);
    out.parameterGaps = gaps;
    out.suppressed = suppressed;
    // Echoed so the routine can see the scope it was served under — an empty
    // queue under a narrow focus means something different from an empty queue
    // over the whole catalog, and the agent's cycle log should say which.
    out.focus = focus;
    json(res, 200, out, { headers: PRIVATE_AGENT_SWEEP_HEADERS });
    return;
  }

  if (mode === "pending_parameters") {
    // Required, positive-integer drug id. Reject bad input up front so the
    // allowlisted query only ever runs against a clean numeric target.
    const targetIdRaw = url.searchParams.get("targetId");
    const targetId = Number(targetIdRaw);
    if (!targetIdRaw || !Number.isInteger(targetId) || targetId <= 0) {
      error(
        res,
        400,
        "pending_parameters mode requires a positive integer targetId (the drug id)",
      );
      return;
    }
    out.pendingParameters = await listPendingParameters(targetId);
    json(res, 200, out, { headers: PRIVATE_AGENT_SWEEP_HEADERS });
    return;
  }

  if (mode === "comments" || mode === "all") {
    out.comments = await listComments(agentUserId);
  }
  if (mode === "approvals" || mode === "all") {
    out.approvals = await listApprovals(agentUserId, agent.id, canSeeDraft);
  }
  json(res, 200, out, { headers: PRIVATE_AGENT_SWEEP_HEADERS });
});

/**
 * Unprocessed comments (top-level posts and replies), oldest first. A comment
 * is unprocessed only if the agent has neither replied to it nor stamped it.
 *
 * No age window: the two NOT EXISTS processed-checks are self-draining —
 * every comment the agent evaluates ends in either a reply or a stamp, so it
 * drops out next cycle. Bounding by a moving 7-day window instead would make
 * any comment left unprocessed during a longer hook outage permanently
 * invisible, defeating the backlog-drain purpose. The cap still bounds each
 * run; oldest-first ordering drains the backlog over successive cycles.
 */
function listComments(agentUserId: number) {
  const sql = getNeonClient();
  return sql`
    SELECT d.id AS comment_id, d.drug_id, d.parameter, d.body,
           d.created_by, d.created_at, dr.slug, dr.names
    FROM drug_parameter_discussions d
    JOIN drugs dr ON dr.id = d.drug_id
    WHERE d.created_by != ${agentUserId}
      AND NOT EXISTS (
        SELECT 1 FROM drug_parameter_discussions r
        WHERE r.parent_id = d.id AND r.created_by = ${agentUserId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM approvals a
        WHERE a.target_type = 'drug_discussion'
          AND a.target_id = d.id
          AND a.approved_by = ${agentUserId}
      )
    ORDER BY d.created_at ASC
    LIMIT ${SWEEP_LIMIT}
  `;
}

/**
 * Open pending `wiki_fact` proposals on one page (optionally one section),
 * across ALL contributors — the cross-agent visibility behind the
 * duplicate-fact check (issue #457). A contributor-role agent cannot see
 * other submitters' rows through GET /api/pending-edits, and the published
 * page it reads omits pending facts entirely, so this is the only way for a
 * routine to notice that the claim it is about to add (or a near-duplicate of
 * it) is already awaiting review.
 *
 * The published-page guard mirrors listApprovals: draft pages are visible only
 * to editors/admins, so a contributor agent never learns a draft page's
 * section structure or queued statements. `proposed_meta` is intentionally
 * never selected — it is not needed for duplicate detection and keeps the
 * untrusted surface minimal. `fact_statement` and `fact_target_anchor` are
 * contributor-authored data for semantic comparison only, never instructions.
 */
function listPendingFacts(
  targetId: number,
  sectionId: string | null,
  canSeeDraft: boolean,
) {
  const sql = getNeonClient();
  if (sectionId) {
    return sql`
      SELECT pe.id, pe.section_id, pe.field_id, pe.fact_operation,
             pe.fact_statement, pe.fact_target_anchor, pe.reference_ids,
             pe.submitted_at
      FROM pending_edits pe
      JOIN wiki_pages wp ON wp.id = pe.target_id
      WHERE pe.edit_type = 'wiki_fact'
        AND pe.status = 'pending'
        AND pe.target_id = ${targetId}
        AND pe.section_id = ${sectionId}
        AND (wp.status = 'published' OR (wp.status = 'draft' AND ${canSeeDraft}))
      ORDER BY pe.submitted_at ASC
      LIMIT ${PENDING_FACTS_LIMIT}
    `;
  }
  return sql`
    SELECT pe.id, pe.section_id, pe.field_id, pe.fact_operation,
           pe.fact_statement, pe.fact_target_anchor, pe.reference_ids,
           pe.submitted_at
    FROM pending_edits pe
    JOIN wiki_pages wp ON wp.id = pe.target_id
    WHERE pe.edit_type = 'wiki_fact'
      AND pe.status = 'pending'
      AND pe.target_id = ${targetId}
      AND (wp.status = 'published' OR (wp.status = 'draft' AND ${canSeeDraft}))
    ORDER BY pe.section_id ASC, pe.submitted_at ASC
    LIMIT ${PENDING_FACTS_LIMIT}
  `;
}

/**
 * Open pending `parameter` proposals on one drug, across ALL contributors —
 * the cross-agent visibility behind the duplicate-parameter check. A
 * contributor-role agent cannot see other submitters' rows through
 * GET /api/pending-edits, so this is the only way for a routine to notice that
 * the parameter value it is about to submit is already awaiting review and
 * should be endorsed/refined rather than re-proposed (the server would reject
 * the duplicate with 409 anyway). `proposed_value` is contributor-authored
 * data for value comparison only, never instructions; `proposed_meta` is
 * intentionally never selected to keep the untrusted surface minimal.
 */
function listPendingParameters(targetId: number) {
  const sql = getNeonClient();
  return sql`
    SELECT pe.id, pe.parameter, pe.proposed_value, pe.reference_ids,
           pe.submitted_by, pe.submitted_at
    FROM pending_edits pe
    WHERE pe.edit_type = 'parameter'
      AND pe.status = 'pending'
      AND pe.target_id = ${targetId}
    ORDER BY pe.parameter ASC, pe.submitted_at ASC
    LIMIT ${PENDING_FACTS_LIMIT}
  `;
}

/**
 * Core-coverage gaps, ranked as §3 tier A specifies: analytical-method
 * components first (the substances a lab actually screens for), then
 * popularity, then the parameter's own priority, then slug as a stable
 * tiebreak.
 *
 * The four NOT EXISTS clauses are the whole point of the lane. Without them
 * this is the memoryless scan that re-served the same impossible pair every
 * cycle; the ordering only decided which impossible pair it would be.
 *
 * The parameter lists come from the TypeScript registry rather than being
 * written out here, so the SQL cannot drift from
 * `parameterAppliesToSubstanceClass`. They are module constants, not caller
 * input — this lane takes no parameters from the request at all — so they are
 * inlined and the whole query stays a static string, the same treatment
 * UNREVIEWED_REFERENCES_SQL gets and for the same reason: the integration test
 * executes THIS text, not a copy of it.
 */

/**
 * Render the admin focus config as WHERE fragments.
 *
 * Focus has to narrow **inside** this query rather than being applied to its
 * result: the ranking is global, so a focus whose candidates rank below the
 * LIMIT would come back empty and the routine would log `no_change` while real
 * in-scope gaps sat just past the cut. A focus on `clearance` — last in the
 * core priority order — would report nothing the moment two higher-ranked
 * drugs filled the page.
 *
 * An **empty** array is emitted rather than skipped, and matches nothing:
 * `x = ANY(ARRAY[]::text[])` is false for every row. That is the point — an
 * admin who scoped the parameter action to no parameters, or to pages that
 * resolve to no drug monographs, has scoped it to the empty set, and §3 says
 * the routine logs `no_change` rather than reaching outside the focus set.
 * Only `null` (mode 'all', or no config row) means unrestricted.
 *
 * The values are admin-set config, not caller input, and are validated on the
 * way in (`isDrugParameterId`, integer drug ids) before being inlined by the
 * same guarded helpers the registry constants use.
 */
function focusPredicates(
  focus: FocusNarrowing,
  drug: string,
  param: string,
): string {
  const clauses: string[] = [];
  if (focus.parameters !== null) {
    clauses.push(`${param} = ANY(${sqlTextArray(focus.parameters)})`);
  }
  if (focus.drugIds !== null) {
    clauses.push(`${drug}.id = ANY(${sqlIntArray(focus.drugIds)})`);
  }
  return clauses.length ? `\n      AND ${clauses.join('\n      AND ')}` : '';
}

export function buildParameterGapsSql(
  focus: FocusNarrowing = { parameters: null, drugIds: null },
): string {
  return `
    WITH wanted AS (
      -- Four lanes, one ranking. They differ only in how "already filled" is
      -- answered (see alreadyFilledSql) and in where they sort: every model
      -- family needs the measured numbers too, so the declarations rank behind
      -- the whole core set rather than interleaving with it, and the coverage
      -- areas — metabolism and pharmacodynamics, which are graphs of
      -- relationship rows rather than values — rank behind both, because a
      -- drug with no half-life gains less from a receptor list than from the
      -- number. The dose-context observations (Cmax) come last: each reading is
      -- one cohort under one dose, which nothing else in the monograph depends
      -- on, so an unfocused cycle should not spend itself there while a core
      -- value is missing. An admin who wants a lane first says so with a
      -- parameter focus, which composes with a method focus; a moderator says
      -- it for one drug with a priority flag.
      SELECT parameter, priority, 'value'::text AS fill_kind
      FROM unnest(${CORE_PARAMETERS_SQL}) WITH ORDINALITY AS t(parameter, priority)
      UNION ALL
      SELECT parameter,
             cardinality(${CORE_PARAMETERS_SQL}) + priority,
             'declaration'::text
      FROM unnest(${DECLARATION_PARAMETERS_SQL}) WITH ORDINALITY AS t(parameter, priority)
      UNION ALL
      SELECT parameter,
             cardinality(${CORE_PARAMETERS_SQL})
               + cardinality(${DECLARATION_PARAMETERS_SQL})
               + priority,
             'relation'::text
      FROM unnest(${COVERAGE_AREAS_SQL}) WITH ORDINALITY AS t(parameter, priority)
      UNION ALL
      SELECT parameter,
             cardinality(${CORE_PARAMETERS_SQL})
               + cardinality(${DECLARATION_PARAMETERS_SQL})
               + cardinality(${COVERAGE_AREAS_SQL})
               + priority,
             'observation'::text
      FROM unnest(${OBSERVATION_PARAMETERS_SQL}) WITH ORDINALITY AS t(parameter, priority)
    )
    SELECT d.id AS drug_id,
           d.slug,
           d.names,
           d.popularity_score,
           d.substance_class,
           w.parameter,
           -- Which payload closes this gap: a source value, a cited
           -- categorical/route-scoped declaration, the relationship rows of a
           -- coverage area (metabolism routes and metabolite edges,
           -- receptor-target mechanisms), or a source value carrying its
           -- structured dose context (Cmax). Surfaced so the routine picks the
           -- right write without re-deriving the set from the registries.
           w.fill_kind,
           EXISTS (
             SELECT 1 FROM analytical_method_components amc
             WHERE amc.drug_id = d.id
           ) AS in_method
    FROM drugs d
    CROSS JOIN wanted w
    WHERE NOT ${alreadyFilledSql(QUEUE_COLUMNS, 'w.fill_kind')}
      AND ${notSuppressedSql(QUEUE_COLUMNS)}
      AND NOT EXISTS (
        SELECT 1 FROM pending_edits pe
        WHERE pe.status = 'pending'
          AND (
            (
              pe.target_id = d.id
              AND pe.parameter = w.parameter
              -- ...and it has to be proposing a VALUE. A clear is queued as an
              -- ordinary parameter edit with a JSON null, and molecularWeight
              -- accepts one (its spec is nullable, and it is the only
              -- core-coverage parameter that is). Approving it deletes a row
              -- that is already absent, so the gap survives — but a pending
              -- one hid it for the edit's whole lifetime. Same mistake as the
              -- monograph bag one round ago: a pending row is not the same
              -- thing as a proposed value.
              AND jsonb_typeof(pe.proposed_value) <> 'null'
              AND (
                pe.edit_type = 'parameter'
                -- A pending param_entry CREATE is a proposal for this same
                -- pair: until it is approved there is no drug_parameters row,
                -- so without this the queue re-serves a gap someone is already
                -- researching. Only creates: an entry update/delete carries the
                -- ENTRY id in target_id, so matching those against d.id would
                -- compare two different id spaces and suppress an unrelated
                -- drug's gap.
                OR (
                  pe.edit_type = 'param_entry'
                  AND pe.proposed_value->>'op' = 'create'
                )
              )
            )
            -- The coverage lane's proposal path. Both relationship routes
            -- queue a full replacement on target_id = drugs.id with no
            -- parameter at all, so the equality above cannot match one:
            -- without this branch a metabolism or mechanisms proposal awaiting
            -- review suppresses nothing, the routine files another full
            -- replacement every cycle, and approving a stale one overwrites the
            -- relationships an earlier one added. The predicate is inert on the
            -- other lanes (see coverageAreaProposedSql), so it needs no
            -- fill_kind guard.
            OR ${coverageAreaProposedSql(QUEUE_COLUMNS, 'pe')}
            -- The third proposal path, and the one that does not look like the
            -- other two: a monograph submitted for review against an existing
            -- drug carries its initial parameter bag in proposed_meta and
            -- leaves target_id and parameter NULL, so the equality above can
            -- never match it. Those parameters are as much a live proposal as a
            -- pending parameter edit.
            --
            -- drugCid is an internal drugs.id here despite the name — the
            -- create payload feeds it straight to applyInitialParameters as a
            -- drugId (see api/wiki/pages.ts). Compared as text so a malformed
            -- or absent value is simply no match rather than a cast error.
            -- A newDrug proposal has no drugCid and needs no exclusion: the
            -- drug does not exist yet, so it is serving no gaps.
            --
            -- The key has to carry an actual value. proposed_meta stores the
            -- bag as submitted, and the UI sends untouched rows as null or
            -- empty objects; validateParameterBag drops both at approval, so those
            -- keys propose nothing. Testing for key *presence* would let a
            -- long-lived monograph draft hide gaps it never intends to fill —
            -- suppressing real work, which is the failure this lane exists to
            -- prevent. The two exclusions below mirror that helper's two skips
            -- exactly. The CASE keeps it total: a missing or non-object
            -- parameters value is an empty bag, not an error.
            OR (
              pe.edit_type = 'wiki_new'
              AND pe.proposed_meta->>'drugCid' = d.id::text
              AND EXISTS (
                SELECT 1
                FROM jsonb_each(
                  CASE
                    WHEN jsonb_typeof(pe.proposed_meta->'parameters') = 'object'
                    THEN pe.proposed_meta->'parameters'
                    ELSE '{}'::jsonb
                  END
                ) AS proposed(key, value)
                WHERE proposed.key = w.parameter
                  AND proposed.value <> 'null'::jsonb
                  AND proposed.value <> '{}'::jsonb
              )
            )
          )
      )${focusPredicates(focus, 'd', 'w.parameter')}
    ORDER BY in_method DESC, d.popularity_score DESC, w.priority ASC, d.slug ASC
    LIMIT ${PARAMETER_GAPS_LIMIT}
  `;
}

function listParameterGaps(focus: FocusNarrowing) {
  return getNeonClient().query(buildParameterGapsSql(focus));
}

/**
 * How many otherwise-open pairs each exclusion is holding back.
 *
 * Reported alongside the queue so the exclusions stay auditable: a suppression
 * layer nobody can see is how the original bug survived so long — the routine
 * kept reporting the same unfillable parameter and nothing in the system said
 * why it kept coming back. These counts answer the inverse question ("what am
 * I not being shown, and is that deliberate?") before it can become a mystery
 * in the other direction.
 *
 * Counted over the same candidate space as the queue — pairs with no stored
 * value — and the reasons are mutually exclusive, ranked exactly as
 * `gapSuppressionReason` ranks them: the durable reasons win over a cooldown
 * that would expire. The pending-edit filter is deliberately not counted here;
 * it is ordinary queue hygiene, not a claim that the gap is unfillable.
 */
export function buildSuppressedParameterGapsSql(
  focus: FocusNarrowing = { parameters: null, drugIds: null },
): string {
  return `
    WITH wanted AS (
      SELECT parameter, 'value'::text AS fill_kind
      FROM unnest(${CORE_PARAMETERS_SQL}) AS t(parameter)
      UNION ALL
      SELECT parameter, 'declaration'::text
      FROM unnest(${DECLARATION_PARAMETERS_SQL}) AS t(parameter)
      UNION ALL
      SELECT parameter, 'relation'::text
      FROM unnest(${COVERAGE_AREAS_SQL}) AS t(parameter)
      UNION ALL
      SELECT parameter, 'observation'::text
      FROM unnest(${OBSERVATION_PARAMETERS_SQL}) AS t(parameter)
    ),
    candidates AS (
      -- The same candidate space as the queue, built from the same four lanes
      -- and the same fill tests. When this drifted from the queue before, a
      -- pair came back open in one half of the response and suppressed in the
      -- other; the shared helpers exist so that cannot be written twice.
      SELECT d.id AS drug_id, d.substance_class, w.parameter
      FROM drugs d
      CROSS JOIN wanted w
      WHERE NOT ${alreadyFilledSql(QUEUE_COLUMNS, 'w.fill_kind')}${focusPredicates(focus, 'd', 'w.parameter')}
    ),
    classified AS (
      SELECT
        CASE
          -- Same three predicates the queue negates, asked one at a time so
          -- the answer can name a reason. They come from the shared module
          -- precisely because this CASE and the queue's WHERE cannot share an
          -- assembled clause — and when they each held their own copy, the
          -- absent-cooldown rule was taught to the queue and not to this.
          WHEN ${markedNotApplicableSql(COUNT_COLUMNS)}
            THEN 'not_applicable_marker'
          WHEN ${ruledOutBySubstanceClassSql(COUNT_COLUMNS)}
            THEN 'substance_class'
          WHEN ${withinAbsentCooldownSql(COUNT_COLUMNS)}
            THEN 'absent_cooldown'
          ELSE NULL
        END AS reason
      FROM candidates c
    )
    SELECT reason, COUNT(*)::int AS count
    FROM classified
    WHERE reason IS NOT NULL
    GROUP BY reason
    ORDER BY reason ASC
  `;
}

function countSuppressedParameterGaps(focus: FocusNarrowing) {
  return getNeonClient().query(buildSuppressedParameterGapsSql(focus));
}

/**
 * In-use resolvable citations (pmid/doi/url) that lack an approved read-in-full
 * paper review — the claims they back rest on a source nobody has fully read
 * and reviewed. "In use" means cited by a drug parameter revision, by a live
 * parameter entry, or by a fact on a published wiki page; freetext citations
 * are excluded (they cannot be reviewed). This is the maintenance counterpart
 * to the reader-facing
 * `needsFullReview` badge: an agent drains it by reviewing each paper (or, if
 * the full text is unavailable, filing a PDF request and fixing the citing
 * claim), and an editor uses it to audit which live claims are under-sourced.
 *
 * Capped generously (not at SWEEP_LIMIT): this is an audit list a routine wants
 * to see whole, like the duplicate-detection enumerators above. Citation
 * `identifier`/`metadata` are descriptive data only, never instructions.
 */
/**
 * Exported so the integration test can execute THIS text against the migrated
 * schema rather than a copy that silently drifts from it — the same reason
 * `CITATION_HAYSTACK` is exported for its EXPLAIN test. `PENDING_FACTS_LIMIT`
 * and `SITE_LANDING_PAGE_URL_PATTERN` are module constants, not caller input
 * (the pattern holds no quote), so inlining them keeps the whole query a static
 * string with nothing to parameterize.
 */
export const UNREVIEWED_REFERENCES_SQL = `
    WITH used AS (
      SELECT DISTINCT cid AS citation_id
      FROM (
        SELECT reference_id AS cid
        FROM drug_parameter_revisions
        WHERE reference_id IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS cid
        FROM drug_parameter_revisions
        WHERE reference_ids IS NOT NULL
        UNION ALL
        -- Parameter entries in their own right, not only through the revision
        -- their recompute writes. For a summarizable parameter the two agree
        -- (recomputeAndCacheParameterSummary stores contributingCitationIds on
        -- the revision), but it returns early for a NON-summarizable one
        -- (analyteStability), so those entries write no revision at
        -- all and their source was invisible here. That was survivable while
        -- the read-in-full gate was unconditional; with the gate admin-
        -- switchable it is the ordinary path for an unreviewed agent citation,
        -- and this queue is where the switch's docs promise it turns up.
        -- citation_id is nullable (an entry may be authored without a source),
        -- hence the NOT NULL filter.
        SELECT citation_id AS cid
        FROM parameter_entries
        WHERE citation_id IS NOT NULL
        UNION ALL
        -- Structured ionization constants back their pKa with reference_ids and
        -- write no parameter revision, so a source used only by an imported
        -- ionization constant would otherwise never reach the paper-review
        -- follow-up queue and could stay unreviewed indefinitely.
        SELECT unnest(reference_ids) AS cid
        FROM drug_ionization_constants
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT (v #>> '{}')::int AS cid
        FROM wiki_pages,
             LATERAL jsonb_path_query(content, '$.**.referenceIds[*]') v
        WHERE status = 'published' AND content IS NOT NULL
          AND jsonb_typeof(v) = 'number'
        UNION ALL
        SELECT (v #>> '{}')::int AS cid
        FROM wiki_pages,
             LATERAL jsonb_path_query(content, '$.**.referenceId') v
        WHERE status = 'published' AND content IS NOT NULL
          AND jsonb_typeof(v) = 'number'
      ) s
      WHERE cid > 0
    )
    SELECT c.id AS citation_id, c.type, c.identifier, c.metadata, c.created_at
    FROM used u
    JOIN citations c ON c.id = u.citation_id
    LEFT JOIN paper_reviews pr
      ON pr.citation_id = c.id AND pr.read_in_full = true
    WHERE c.type <> 'freetext'
      AND (
        pr.id IS NULL
        -- A front-page citation stays in the lane even when reviewed: it names
        -- no specific source, so the claim resting on it needs re-citing.
        OR (c.type = 'url' AND btrim(c.identifier) ~* '${SITE_LANDING_PAGE_URL_PATTERN}')
      )
    ORDER BY c.id ASC
    LIMIT ${PENDING_FACTS_LIMIT}
  `;

function listUnreviewedReferences() {
  return getNeonClient().query(UNREVIEWED_REFERENCES_SQL);
}

/**
 * Approved revisions this agent has not yet processed, oldest first.
 * `pending_edits` has no `revision_id` column; revisions live in
 * `drug_parameter_revisions` and `wiki_revisions`, each with a
 * `pending_edit_id` back-reference. A single `wiki_new` pending edit can
 * produce both a wiki revision AND one or more parameter revisions, so each
 * source contributes its own row with its own per-revision processed check.
 * Paper reviews have no `pending_edit_id` back-ref; the link is via the
 * pending edit's `target_id` (= citation id), since paper_reviews upserts on
 * citation_id at approval time.
 *
 * "Processed by this agent" = this agent stamped it (approvals) OR posted a
 * peer-verification verdict on it (agent_verifications). The verdict check is
 * what lets us drop the age window safely: when the agent raises a substantive
 * concern it deliberately leaves the revision unstamped, but it still posts a
 * `dispute` verdict (§7.B), so the verdict check retires it from THIS agent's
 * sweep while leaving it visible to other agents — without it, such rows would
 * sit at the head of the oldest-first queue forever and starve the cap.
 */
async function listApprovals(
  agentUserId: number,
  agentId: number,
  canSeeDraft: boolean,
) {
  const sql = getNeonClient();
  const rows = (await sql`
    SELECT *
    FROM (
      -- wiki revisions
      SELECT pe.id    AS pending_edit_id,
             pe.edit_type, pe.target_id, pe.parameter,
             pe.section_id, pe.fact_statement, pe.reviewed_at,
             wr.id    AS revision_id,
             'wiki_revision' AS revision_type,
             wr.page_id AS wiki_page_id,
             d_wiki.id AS wiki_drug_id
      FROM pending_edits pe
      JOIN wiki_revisions wr ON wr.pending_edit_id = pe.id
      JOIN wiki_pages wp ON wp.id = wr.page_id
      -- drug_cid normally holds the internal drugs.id, but legacy rows may
      -- carry a PubChem CID. Resolve the internal id first and only fall back
      -- to a PubChem match, so a low serial id that collides with another
      -- drug's pubchem_cid cannot duplicate the revision under a wrong drug.
      LEFT JOIN LATERAL (
        SELECT d.id
        FROM drugs d
        WHERE d.id = wp.drug_cid OR d.pubchem_cid = wp.drug_cid
        ORDER BY (d.id = wp.drug_cid) DESC
        LIMIT 1
      ) d_wiki ON true
      WHERE pe.status = 'approved'
        -- Only surface revisions on pages the agent can actually read/stamp;
        -- otherwise the endpoint leaks hidden-page metadata and hands back
        -- items the wiki/approval APIs would 404.
        AND (wp.status = 'published' OR (wp.status = 'draft' AND ${canSeeDraft}))
        AND pe.submitted_by != ${agentUserId}
        AND NOT EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.target_type = 'wiki_revision'
            AND a.target_id = wr.id
            AND a.approved_by = ${agentUserId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_verifications av
          WHERE av.target_type = 'wiki_revision'
            AND av.target_id = wr.id
            AND av.agent_id = ${agentId}
        )

      UNION ALL

      -- parameter revisions
      -- Use dpr.drug_id / dpr.parameter, not pe.target_id / pe.parameter:
      -- for wiki_new edits the pending_edit has no drug or parameter set.
      SELECT pe.id       AS pending_edit_id,
             pe.edit_type,
             dpr.drug_id AS target_id,
             dpr.parameter,
             pe.section_id, pe.fact_statement, pe.reviewed_at,
             dpr.id      AS revision_id,
             'drug_parameter_revision' AS revision_type,
             NULL::integer AS wiki_page_id,
             NULL::integer AS wiki_drug_id
      FROM pending_edits pe
      JOIN drug_parameter_revisions dpr ON dpr.pending_edit_id = pe.id
      WHERE pe.status = 'approved'
        AND pe.submitted_by != ${agentUserId}
        AND NOT EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.target_type = 'drug_parameter_revision'
            AND a.target_id = dpr.id
            AND a.approved_by = ${agentUserId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_verifications av
          WHERE av.target_type = 'drug_parameter_revision'
            AND av.target_id = dpr.id
            AND av.agent_id = ${agentId}
        )

      UNION ALL

      -- paper reviews: at most one row per current review. approvals upsert
      -- paper_reviews by citation_id, so multiple approved paper_review
      -- pending edits on the same citation all resolve to one pr.id; keep only
      -- the latest approved edit per review so the cap is not consumed by — and
      -- the routine does not stamp/peer-verify — duplicate candidates for a
      -- single target carrying stale pending-edit metadata. Self-authorship is
      -- judged on the current review's pr.created_by (refreshed on every
      -- approval upsert), not the joined edit's submitter, so the agent's own
      -- re-review is excluded even when an older edit by someone else still
      -- joins to it.
      (
        SELECT DISTINCT ON (pr.id)
               pe.id         AS pending_edit_id,
               pe.edit_type,
               pr.citation_id AS target_id,
               NULL           AS parameter,
               NULL::varchar  AS section_id,
               NULL::text     AS fact_statement,
               pe.reviewed_at,
               pr.id          AS revision_id,
               'paper_review' AS revision_type,
               NULL::integer  AS wiki_page_id,
               NULL::integer  AS wiki_drug_id
        FROM pending_edits pe
        JOIN paper_reviews pr ON pr.citation_id = pe.target_id
        WHERE pe.status = 'approved'
          AND pe.edit_type = 'paper_review'
          AND pr.created_by IS DISTINCT FROM ${agentUserId}
          AND NOT EXISTS (
            SELECT 1 FROM approvals a
            WHERE a.target_type = 'paper_review'
              AND a.target_id = pr.id
              AND a.approved_by = ${agentUserId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_verifications av
            WHERE av.target_type = 'paper_review'
              AND av.target_id = pr.id
              AND av.agent_id = ${agentId}
          )
        ORDER BY pr.id, pe.reviewed_at DESC
      )
    ) candidates
    ORDER BY reviewed_at ASC
    LIMIT ${SWEEP_LIMIT}
  `) as Array<Record<string, unknown>>;

  // The peer-verification verdict the routine posts for each revision
  // (§7.B / agents/peer-verification-protocol.md) requires a `targetVersion`
  // that byte-matches the target row's own version token. The sweep rows only
  // expose the pending edit's `reviewed_at`, which is NOT that token, so we
  // attach `target_version` here using the exact same source of truth the
  // /api/agent-verifications validator uses (createdAt for revisions,
  // updatedAt for paper reviews). Capped at SWEEP_LIMIT rows, so ≤5 lookups.
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      target_version: await verificationTargetVersion({
        targetType: row.revision_type as AgentVerificationTargetType,
        targetId: Number(row.revision_id),
      }),
    })),
  );
}
