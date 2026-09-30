# Drug Parameter Research-to-SQL Plan

This file is the operating plan for LLM agents that add deeply sourced drug-parameter data to Kinetix through `agents/manual_runs/NEW_DRUG_PARAMETERS.SQL` only. It is intentionally cycle-based: one agent run should complete at most one `(drug, parameter)` pair, then stop so the work remains auditable within limited context windows.

## 1. Scope

### Target output

- Write proposed database changes only to `agents/manual_runs/NEW_DRUG_PARAMETERS.SQL`.
- Do not edit `data/components.ts` or live database rows directly during a research cycle.
- The SQL must contain everything needed to apply the parameter update, including citation inserts, parameter upsert, revision/audit inserts, and a verification-log row when applicable.
- If a relevant full text cannot be accessed, append the full reference to `agents/manual_runs/REFERENCES_NEEDED.md` and do not silently drop it from the evidence picture.

### Parameter scope

Only these parameters are in scope for this workflow, in this default order unless a human explicitly overrides the cycle. This order mirrors the live agent priority: first the core values needed for calculations and matrix interpretation across the whole drug table, then the remaining parameter gaps. `postmortemRedistribution` stays in scope, but it is forensic-context work rather than mandatory core coverage for every drug.

1. `molecularWeight`
2. `bloodPlasmaRatio`
3. `halfLife`
4. `volumeOfDistribution`
5. `bioavailability`
6. `tmax`
7. `proteinBinding`
8. `logPlogD`
9. `postmortemRedistribution`
10. `metabolites`

Current schema note: the implemented parameter registry includes all listed keys except `metabolites`. `postmortemRedistribution` is the existing registry key for the central:peripheral blood ratio (C/P ratio). If `metabolites` is still absent from `src/lib/drugParameters.ts` and `drug_parameters.parameter` conventions when selected, stop and record a blocker instead of inventing an ad-hoc key.

### Scientific target

The default inference target is **adult clinical pharmacokinetics**. Prefer adult human data for usual clinical formulations and clinically relevant routes. Keep pediatric, pregnancy, hepatic/renal impairment, overdose, postmortem, animal, and in vitro data separate unless no adult clinical evidence exists; such evidence may inform uncertainty but should not silently define the adult clinical value.

## 2. Default work selection

The default action is to work on the next empty drug parameter in descending `drugs.popularity_score`, so high-impact drugs are filled first. If there are manually flagged parameters in the live database, handle those first using the top-priority queue in `agents/drug-db-maintainer.md`; this manual plan is the fallback queue for ordinary coverage work. User-authored parameter-thread comments are handled by the discussion sweep, not by the top-priority parameter queue.

Use this query shape to identify the next target. Keep the parameter list synchronized with the scope above and with the live registry.
The default queue includes only parameters that are already implemented in `src/lib/drugParameters.ts`; keep `metabolites` out of this CTE until the registry supports it.

```sql
WITH wanted(parameter, priority) AS (
  VALUES
    ('molecularWeight', 1),
    ('bloodPlasmaRatio', 2),
    ('halfLife', 3),
    ('volumeOfDistribution', 4),
    ('bioavailability', 5),
    ('tmax', 6),
    ('proteinBinding', 7),
    ('logPlogD', 8),
    ('postmortemRedistribution', 9)
)
SELECT d.id AS drug_id,
       d.slug,
       d.names,
       d.aliases,
       d.pubchem_cid,
       d.popularity_score,
       w.parameter
FROM drugs d
CROSS JOIN wanted w
LEFT JOIN drug_parameters p
  ON p.drug_id = d.id
 AND p.parameter = w.parameter
WHERE p.drug_id IS NULL
ORDER BY d.popularity_score DESC, w.priority ASC, d.slug ASC
LIMIT 1;
```

Before committing a cycle to the target, also check for already proposed work in `agents/manual_runs/NEW_DRUG_PARAMETERS.SQL` and pending review tables if the agent has database access. If the same `(drug, parameter)` already has unapplied SQL or an open pending edit, skip it and choose the next row.

## 3. Cycle contract: one parameter only

Each cycle must handle exactly one `(drug, parameter)` pair:

1. Select the next empty target by popularity priority.
2. Build the substance identity layer.
3. Perform the required deep and wide search.
4. Obtain and read full text for every relevant source that can materially affect the value.
5. Record inaccessible but relevant sources in `agents/manual_runs/REFERENCES_NEEDED.md`.
6. Extract all candidate values into working notes during the cycle.
7. Judge the adult clinical PK consensus using the evidence protocol.
8. Append complete, idempotent SQL to `agents/manual_runs/NEW_DRUG_PARAMETERS.SQL`, or append a verification-log SQL block explaining why no value can be finalized.
9. Stop.

Do not continue to a second parameter merely because some context window remains.

## 4. Evidence protocol and mandatory search breadth

Follow `agents/source_selection_evidence_judgment_protocol.md` as the controlling protocol for source selection and evidence judgment. This workflow adds stricter parameter-specific requirements:

- Start with identity: INN/generic names, English/Norwegian names, aliases, brand names, salts, stereoisomers, PubChem CID, CAS if available, ATC, RxNorm, DrugBank, ChEMBL, and known metabolites.
- Search across biomedical indexes and discovery systems broad enough to avoid missing key data: PubMed/MEDLINE, PubMed Central, Europe PMC, Embase if available, Scopus or Web of Science if available, Google Scholar, Semantic Scholar, OpenAlex, and Crossref.
- For approved medicines, consult official regulator sources: DailyMed, Drugs@FDA/FDA labels, EMA EPAR/SmPC, and relevant national medicine-agency documents.
- Consult chemistry/drug databases when relevant to the selected parameter: PubChem, DrugBank, ChEMBL, IUPHAR/BPS, and authoritative product monographs.
- For `bloodPlasmaRatio`, include forensic and analytical-toxicology literature, but keep the final inference anchored to adult clinical matrix conversion unless the app-specific use requires a forensic caveat.
- For `logPlogD`, distinguish experimental logP, predicted logP, and pH-specific logD. Prefer experimentally measured logD at pH 7.4 when the final parameter is described as logP/logD pH 7.4; otherwise document the reason for selecting logP or a predicted value.

A cycle may not finalize a value after consulting only one or a few convenient references. It must search until additional search terms, citation chasing, and database/index sweeps stop yielding materially relevant new evidence, or until remaining inaccessible items are listed in `agents/manual_runs/REFERENCES_NEEDED.md` for human retrieval.

## 5. Full-text rule

For every relevant reference, peruse the full article or document before using it for the final decision. Reading only the abstract is insufficient.

Full-text review must include, when present:

- Methods and study design.
- Population demographics and health status.
- Route, dose, formulation, dosing duration, and sampling schedule.
- Biological matrix and assay method.
- Tables, figures, supplements, appendices, and footnotes containing PK values.
- Limitations, exclusions, and conflicts of interest.
- Reference lists that may reveal older definitive PK studies.

If full text is unavailable, add an entry to `agents/manual_runs/REFERENCES_NEEDED.md` with enough detail for a human to retrieve it later. Do not omit inaccessible but relevant studies from the rationale; state that finalization is blocked or downgraded if the inaccessible item could plausibly change the conclusion.

## 6. Extraction and judgment rules

For each usable source, extract at least:

- Drug and salt/formulation if relevant.
- Parameter and reported raw value/range.
- Original unit and canonical converted unit.
- Route, dose, formulation, study population, sample matrix, timing, `n`, and assay method.
- Whether the source is primary data, regulator summary, review, database entry, or prediction.
- DOI/PMID/URL and exact table, figure, page, or section.
- Applicability to adult clinical PK.
- Limitations and reasons for exclusion or down-weighting.

Consensus judgment should prefer, in order:

1. Adult human primary PK studies directly measuring the parameter in the relevant route/formulation/population.
2. Regulatory clinical pharmacology summaries that synthesize adult human studies.
3. High-quality systematic reviews or expert monographs that transparently cite primary data.
4. Curated databases only when they identify their primary source or when the parameter is chemical rather than clinical.
5. Case reports, overdose/postmortem studies, animal studies, in vitro studies, or predictions only as supporting or fallback evidence with explicit caveats.

When evidence conflicts, prefer the value/range that best represents adult clinical PK for usual formulations, while preserving clinically meaningful variability as `min`/`max` rather than forcing a single point estimate. Do not average incompatible routes, matrices, formulations, populations, or analytical definitions.

## 7. Value-shape rules

Use the live drug-parameter registry as the authority for valid JSON shape, unit, bounds, and whether min/max are required.

Default canonical shapes for scoped parameters:

- `molecularWeight`: a bare nullable number in g/mol, e.g. `194.19`; use `null` only to clear a known-bad value.
- `halfLife`: `{"min": number, "max": number, "unit": "h", "note"?: string}`.
- `volumeOfDistribution`: `{"min": number, "max": number, "unit": "L/kg", "note"?: string}`.
- `bloodPlasmaRatio`: `{"value": number, "unit": "ratio", "note"?: string}` or `{"min": number, "max": number, "unit": "ratio", "note"?: string}`.
- `bioavailability`: `{"min": number, "max": number, "unit": "fraction", "note"?: string}`.
- `tmax`: `{"value": number, "unit": "h", "note"?: string}` or `{"min": number, "max": number, "unit": "h", "note"?: string}`.
- `proteinBinding`: `{"min": number, "max": number, "unit": "fraction", "note"?: string}`.
- `logPlogD`: `{"value": number, "note"?: string}` or `{"min": number, "max": number, "note"?: string}`; specify in `note` whether it is experimental logD pH 7.4, experimental logP, or predicted.
- `postmortemRedistribution`: `{"value": number, "unit": "ratio", "note"?: string}` or `{"min": number, "max": number, "unit": "ratio", "note"?: string}` for central:peripheral blood ratio; select this only when the evidence is genuinely postmortem/forensic and record matrix/site details in `note`.
- `metabolites`: blocked until the parameter exists in the registry; once implemented, follow its schema exactly.

Convert percentages to fractions for fraction parameters. Preserve important qualifiers in `note`, but keep notes concise enough to fit the app's parameter schema.

## 8. `agents/manual_runs/REFERENCES_NEEDED.md` format

Append one line per inaccessible relevant source:

```md
- YYYY-MM-DD | drug=<slug> | parameter=<parameter> | reason=<paywall|dead_url|no_institutional_access|missing_supplement|other> | PMID=<pmid or n/a> | DOI=<doi or n/a> | citation=<authors. title. journal. year;volume(issue):pages> | url=<url if known> | why_needed=<specific value/question it may affect>
```

If the source may materially change the final value, do not finalize the SQL update until a human supplies it. Instead append a verification-log SQL block with `concordance='absent'` or `concordance='weak'` and `outcome='flagged'`, explaining the blocker.

## 9. `agents/manual_runs/NEW_DRUG_PARAMETERS.SQL` requirements

Each appended block must be self-contained, idempotent, and reviewable.

Minimum contents:

1. A comment header with date, drug slug, drug id if known, parameter, final value, evidence grade, and one-paragraph rationale.
2. A transaction boundary.
3. Assert exactly one target drug and one accountable actor before any write CTE can run.
4. Citation upserts into `citations` for every source supporting the value, using `type` and `identifier` uniqueness.
5. The `drug_parameters` upsert for the selected parameter.
6. A guarded parent `drugs.updated_at` refresh when, and only when, the parameter write actually applies.
7. A `drug_parameter_revisions` insert linking the change to the primary citation and all supporting citation IDs; `created_by` is required, so each real block must identify the curator/agent user that owns the SQL.
8. A `verification_log` insert recording source count, concordance, outcome, and concise notes.
9. No unreviewed live execution side effects outside the SQL file.

Prefer slug-based drug lookup inside SQL rather than hardcoded numeric IDs where practical. Use `ON CONFLICT` so the SQL can be rerun safely.
Do not use an unconditional `ON CONFLICT DO UPDATE` for `drug_parameters`; generated blocks that fill empty parameters must skip when a row already exists, and intentional replacements must assert the expected old value before updating. Revision and verification-log inserts must also use `WHERE NOT EXISTS` guards so rerunning a reviewed block does not duplicate audit rows.

Template:

```sql
-- YYYY-MM-DD drug=<slug> parameter=<parameter>
-- Final value: <human-readable value>
-- Evidence grade: <strong|moderate|weak>; adult clinical PK target.
-- Rationale: <short consensus rationale; mention major exclusions/caveats>.
BEGIN;

WITH target_drug AS (
  SELECT id FROM drugs WHERE slug = '<slug>'
), actor AS (
  SELECT id FROM users WHERE username = '<curator-or-agent-username>'
), assert_target_drug AS (
  SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS ok
  FROM target_drug
), assert_actor AS (
  SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS ok
  FROM actor
), citation_1 AS (
  INSERT INTO citations (drug_id, type, identifier, metadata, created_by)
  SELECT target_drug.id,
         '<pmid|doi|url|freetext>',
         '<identifier>',
         '{"title":"...","authors":["..."],"journal":"...","year":2026,"pages":"...","accessed":"YYYY-MM-DD","fullTextReviewed":true,"parameter":"<parameter>"}'::jsonb,
         actor.id
  FROM target_drug
  CROSS JOIN actor
  CROSS JOIN assert_target_drug
  CROSS JOIN assert_actor
  ON CONFLICT (type, identifier) DO UPDATE
    SET metadata = COALESCE(citations.metadata, '{}'::jsonb) || EXCLUDED.metadata
  RETURNING id
), all_citations AS (
  SELECT id FROM citation_1
  -- UNION ALL SELECT id FROM citation_2
), primary_citation AS (
  SELECT id FROM citation_1
), upsert_parameter AS (
  INSERT INTO drug_parameters AS dp (drug_id, parameter, value, updated_by, updated_at)
  SELECT target_drug.id,
         '<parameter>',
         '<json value>'::jsonb,
         actor.id,
         now()
  FROM target_drug
  CROSS JOIN actor
  CROSS JOIN assert_target_drug
  CROSS JOIN assert_actor
  WHERE NOT EXISTS (
    SELECT 1
    FROM drug_parameters existing
    WHERE existing.drug_id = target_drug.id
      AND existing.parameter = '<parameter>'
  )
  ON CONFLICT (drug_id, parameter) DO NOTHING
  RETURNING drug_id, parameter, value
), touch_drug AS (
  UPDATE drugs
     SET updated_at = now()
  FROM upsert_parameter u
  WHERE drugs.id = u.drug_id
  RETURNING drugs.id
), revision AS (
  INSERT INTO drug_parameter_revisions (
    drug_id,
    parameter,
    old_value,
    new_value,
    edit_summary,
    reference_id,
    reference_ids,
    created_by
  )
  SELECT u.drug_id,
         u.parameter,
         NULL,
         u.value,
         '<concise scientific summary>',
         (SELECT id FROM primary_citation),
         ARRAY(SELECT id FROM all_citations ORDER BY id),
         actor.id
  FROM upsert_parameter u
  CROSS JOIN actor
  WHERE NOT EXISTS (
    SELECT 1
    FROM drug_parameter_revisions existing
    WHERE existing.drug_id = u.drug_id
      AND existing.parameter = u.parameter
      AND existing.new_value = u.value
      AND existing.edit_summary IS NOT DISTINCT FROM '<concise scientific summary>'
      AND existing.created_by = actor.id
  )
  RETURNING id
)
INSERT INTO verification_log (
  target_type,
  target_id,
  parameter,
  verified_at,
  agent_notes,
  sources_consulted_count,
  concordance,
  outcome,
  created_by
)
SELECT 'parameter',
       touch_drug.id,
       '<parameter>',
       now(),
       '<databases searched; full-text status; consensus rationale>',
       <number>,
       '<strong|moderate|weak|absent>',
       '<submitted_pending|flagged|commented_only|no_change>',
       actor.id
FROM touch_drug
CROSS JOIN actor
WHERE NOT EXISTS (
    SELECT 1
    FROM verification_log existing
    WHERE existing.target_type = 'parameter'
      AND existing.target_id = touch_drug.id
      AND existing.parameter = '<parameter>'
      AND existing.agent_notes IS NOT DISTINCT FROM '<databases searched; full-text status; consensus rationale>'
      AND existing.sources_consulted_count = <number>
      AND existing.concordance IS NOT DISTINCT FROM '<strong|moderate|weak|absent>'
      AND existing.outcome = '<submitted_pending|flagged|commented_only|no_change>'
      AND existing.created_by IS NOT DISTINCT FROM actor.id
  );

COMMIT;
```

Each real SQL block must replace `<curator-or-agent-username>` with an existing accountable user. If no such user exists, stop and create a blocker entry rather than emitting SQL that cannot satisfy `drug_parameter_revisions.created_by`.

## 10. Stop conditions

Stop without writing a final parameter value if any of the following occur:

- A likely decisive full text is inaccessible and has been recorded in `agents/manual_runs/REFERENCES_NEEDED.md`.
- The selected parameter is not implemented in the live parameter registry.
- The available literature is too conflicting to support an adult clinical PK consensus.
- The value cannot be represented using the current parameter schema without losing essential route, formulation, or population distinctions.
- The agent cannot verify enough full texts to satisfy the evidence protocol.

In these cases, append only a blocker/verification SQL block and the needed references, then stop.
