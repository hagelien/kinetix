import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRUG_PARAMETER_IDS,
  DRUG_PARAMETERS,
  ENTRY_ONLY_PARAMETER_IDS,
  METADATA_PARAMETER_IDS,
  MODEL_STRUCTURE_PARAMETER_IDS,
  ROUTE_SCOPED_PARAMETER_IDS,
  isRangeSpec,
  parameterIsMatrixRelevant,
  parameterIsScenarioRelevant,
  parameterIsSummarizable,
  type DrugParameterId,
} from '../src/lib/drugParameters';
import { MIN_SOURCES_PER_PARAMETER } from '../src/lib/deepResearchImport';

/**
 * The deep-research seeding prompt must not drift from the parameter registry.
 *
 * `agents/deep-research-drug-seeding.md` is the prompt a research agent gets
 * when seeding a whole new drug monograph, and its registry tables are the only
 * place that agent learns which parameters exist. The importer
 * (`src/lib/deepResearchImport.ts`) validates whatever comes back against
 * `DRUG_PARAMETERS`, so an ID missing from the prompt is never rejected — it is
 * simply never researched, and the new drug page silently ships without it.
 * That is how `pmAmRatio` stayed unseeded after it was added to the registry.
 *
 * The assertions therefore run in both directions: every registry ID must be
 * documented, and every ID the prompt documents must still exist.
 */

const PROMPT_PATH = resolve(process.cwd(), 'agents/deep-research-drug-seeding.md');
const prompt = readFileSync(PROMPT_PATH, 'utf8');

interface MarkdownTable {
  header: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Every GitHub-flavoured markdown table in the document, header + body rows. */
function parseTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split('\n');
  const tables: MarkdownTable[] = [];
  const isRow = (line: string | undefined) => !!line?.trim().startsWith('|');
  let i = 0;
  while (i < lines.length) {
    // A table is a header row followed by a `| --- | --- |` delimiter row.
    if (isRow(lines[i]) && isRow(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      tables.push({ header, rows });
      continue;
    }
    i += 1;
  }
  return tables;
}

/** The `` `foo` `` spans in a cell, in order — parameter IDs and units are code spans. */
function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

function columnIndex(table: MarkdownTable, label: string): number {
  const index = table.header.findIndex((cell) => cell.includes(label));
  expect(
    index,
    `column "${label}" in table with header ${table.header.join(' | ')}`,
  ).toBeGreaterThanOrEqual(0);
  return index;
}

const tables = parseTables(prompt);
const identityTable = tables.find(
  (t) => t.header[0] === 'Parameter ID' && t.header.some((c) => c.includes('Constraint')),
);
const measuredTable = tables.find(
  (t) =>
    t.header.some((c) => c.includes('Parameter ID')) &&
    t.header.some((c) => c.includes('Allowed range')),
);

/**
 * The parameters this seeding prompt covers. The model-structure axes
 * (`dispositionModel` / `eliminationModel` / `absorptionModel`, CV-1b) are a
 * third registry category alongside identity metadata and measured numeric
 * parameters: categorical PK model-shape declarations with no unit, range, or
 * cross-source aggregate. A research agent does not seed them through the
 * numeric `kinetixParameterValues[]` contract — they are asserted as cited
 * `parameter_entries` via the drug editor / parameter-entries write path (or
 * derived from the numeric PK params). So the prompt neither documents them in
 * its measured table nor counts them in its "N IDs" total; this set is the
 * registry minus that axis category.
 */
const SEEDED_PARAMETER_IDS = DRUG_PARAMETER_IDS.filter(
  (id) =>
    !MODEL_STRUCTURE_PARAMETER_IDS.includes(id) &&
    // Route-scoped parameters (CV-2c, e.g. `ka`) are a fourth category the agent
    // does not seed through the numeric `kinetixParameterValues[]` contract: they
    // have no drug-level value and are reviewer-authored per administration route
    // via the parameter-entries write path, exactly like the model-structure axes.
    !ROUTE_SCOPED_PARAMETER_IDS.includes(id) &&
    // Entry-only parameters (Cmax) are a fifth: dose-contextualized source
    // entries with no drug-level value, whose authoring is gated until the
    // dose-context writers ship (the importer skips them). Documenting them to
    // a seeding agent now would invite values it cannot submit.
    !ENTRY_ONLY_PARAMETER_IDS.includes(id),
);

const MEASURED_PARAMETER_IDS = SEEDED_PARAMETER_IDS.filter(
  (id) => !METADATA_PARAMETER_IDS.includes(id),
);

/** Parameter IDs listed in a table's "Parameter ID" column; a cell may hold several. */
function documentedIds(table: MarkdownTable): string[] {
  const idColumn = columnIndex(table, 'Parameter ID');
  return table.rows.flatMap((row) => codeSpans(row[idColumn] ?? ''));
}

describe('deep-research seeding prompt vs parameter registry', () => {
  it('documents both registry tables', () => {
    expect(identityTable, 'identity/metadata table in the prompt').toBeDefined();
    expect(measuredTable, 'measured-parameter table in the prompt').toBeDefined();
  });

  it('lists exactly the metadata parameters as identity fields', () => {
    expect(documentedIds(identityTable!).sort()).toEqual([...METADATA_PARAMETER_IDS].sort());
  });

  it('lists exactly the measured parameters, no more and no fewer', () => {
    expect(documentedIds(measuredTable!).sort()).toEqual([...MEASURED_PARAMETER_IDS].sort());
  });

  it('states the current parameter counts in its prose', () => {
    // A stale count reads as authoritative to the agent, and drifts exactly as
    // the tables do: "33 IDs" in the intro, "The 27 measured parameters" above
    // the second table.
    expect(prompt).toContain(`${SEEDED_PARAMETER_IDS.length} IDs`);
    expect(prompt).toContain(`The ${MEASURED_PARAMETER_IDS.length} measured parameters`);
  });

  it('gives each measured parameter its registry canonical unit', () => {
    const idColumn = columnIndex(measuredTable!, 'Parameter ID');
    const unitColumn = columnIndex(measuredTable!, 'Canonical');

    for (const row of measuredTable!.rows) {
      const unitCell = row[unitColumn] ?? '';
      for (const id of codeSpans(row[idColumn] ?? '') as DrugParameterId[]) {
        const spec = DRUG_PARAMETERS[id];
        if (!isRangeSpec(spec)) continue;
        if (spec.canonicalUnit === '') {
          // A dimensionless scalar must carry no unit at all — the registry's
          // zod rejects a unit string outright, so the prompt says "omit unit".
          expect(unitCell.toLowerCase(), `${id} unit cell`).toContain('omit unit');
        } else {
          // First code span is the canonical unit; the rest are its family.
          expect(codeSpans(unitCell)[0], `${id} canonical unit`).toBe(spec.canonicalUnit);
        }
      }
    }
  });

  it('enumerates a parameter’s full accepted-unit family where it lists one', () => {
    // The alternates in parentheses are the only place the agent learns which
    // units besides the canonical one it may report in, and an omission here
    // fails in the quietest possible direction: the agent researches a value,
    // states it in the unit its source used, and the importer drops that
    // sourceValue with a warning nobody reads back into the prompt. A clearance
    // in `L/min` — how the literature states a rapidly cleared drug — was lost
    // that way. A cell may still name just the canonical unit and defer to
    // another row ("concentration family, as above"); once it starts listing
    // alternates the list has to be the registry's, exactly.
    const idColumn = columnIndex(measuredTable!, 'Parameter ID');
    const unitColumn = columnIndex(measuredTable!, 'Canonical');

    for (const row of measuredTable!.rows) {
      const listed = codeSpans(row[unitColumn] ?? '');
      if (listed.length < 2) continue;
      for (const id of codeSpans(row[idColumn] ?? '') as DrugParameterId[]) {
        const spec = DRUG_PARAMETERS[id];
        if (!isRangeSpec(spec) || spec.allowedUnits.length === 0) continue;
        expect([...listed].sort(), `${id} accepted units`).toEqual(
          [...spec.allowedUnits].sort(),
        );
      }
    }
  });

  it('flags exactly the parameters that require both min and max', () => {
    const idColumn = columnIndex(measuredTable!, 'Parameter ID');

    for (const row of measuredTable!.rows) {
      const idCell = row[idColumn] ?? '';
      const flagged = /needs min & max/i.test(idCell);
      for (const id of codeSpans(idCell) as DrugParameterId[]) {
        const spec = DRUG_PARAMETERS[id];
        if (!isRangeSpec(spec)) continue;
        expect(flagged, `"needs min & max" annotation for ${id}`).toBe(spec.requiresMinMax);
      }
    }
  });

  it('footnotes exactly the parameters that need matrix and scenario context', () => {
    // The "Value kind" column carries two footnote markers, and they are the
    // only thing telling the agent to put a matrix and an interpretive scenario
    // in `note` — the sole field that survives a v1 import. Dropping a marker
    // leaves every other assertion here passing while the seeded value silently
    // loses the context that makes it mean anything.
    //
    //   ¹ — scenario-relevant (and matrix-relevant): the interpretive
    //       concentrations, whose value means nothing without both.
    //   ² — not summarizable: matrix-specific analytical properties with no
    //       valid cross-matrix pool (`SUMMARIZED_PARAMETER_IDS` excludes them).
    //   ⁴ — matrix-relevant only: a pooled concentration-scale quantity
    //       (Vmax, Km) whose matrix must be named but which has no scenario.
    const idColumn = columnIndex(measuredTable!, 'Parameter ID');
    const kindColumn = columnIndex(measuredTable!, 'Value kind');

    for (const row of measuredTable!.rows) {
      const kindCell = row[kindColumn] ?? '';
      for (const id of codeSpans(row[idColumn] ?? '') as DrugParameterId[]) {
        expect(kindCell.includes('¹'), `¹ (matrix + scenario) marker on ${id}`).toBe(
          parameterIsScenarioRelevant(id),
        );
        expect(kindCell.includes('²'), `² (not cross-matrix aggregatable) marker on ${id}`).toBe(
          !parameterIsSummarizable(id),
        );
        expect(kindCell.includes('⁴'), `⁴ (matrix only) marker on ${id}`).toBe(
          parameterIsMatrixRelevant(id) &&
            parameterIsSummarizable(id) &&
            !parameterIsScenarioRelevant(id),
        );
        if (parameterIsMatrixRelevant(id)) {
          // Every matrix-relevant parameter must carry one marker; which one
          // depends on whether it is scenario-relevant and pools across sources.
          expect(/[¹²⁴]/.test(kindCell), `a footnote marker on matrix-relevant ${id}`).toBe(true);
        }
      }
    }
  });

  it('gives each measured parameter its registry bounds', () => {
    const idColumn = columnIndex(measuredTable!, 'Parameter ID');
    const rangeColumn = columnIndex(measuredTable!, 'Allowed range');

    // The column is typeset for humans: spaces group the digits, an en dash
    // separates the two bounds and U+2212 is the minus sign. Normalise those
    // back to plain numbers before comparing against the registry.
    const parseBounds = (cell: string): { min: number; max: number } | null => {
      const [minRaw, maxRaw, ...rest] = cell
        .replace(/−/g, '-')
        .replace(/\s/g, '')
        .split('–');
      if (rest.length || maxRaw === undefined) return null;
      const min = Number(minRaw);
      const max = Number(maxRaw);
      return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    };

    for (const row of measuredTable!.rows) {
      const bounds = parseBounds(row[rangeColumn] ?? '');
      for (const id of codeSpans(row[idColumn] ?? '') as DrugParameterId[]) {
        const spec = DRUG_PARAMETERS[id];
        if (!isRangeSpec(spec)) continue;
        expect(bounds, `parsable "min – max" range for ${id}`).not.toBeNull();
        expect(bounds, `${id} bounds`).toEqual(spec.bounds);
      }
    }
  });
});

describe('deep-research seeding prompt vs source-value expectations', () => {
  it('asks for at least two independent sources per parameter', () => {
    // The importer reports a parameter pooled from fewer sources than this
    // (`thinlySourcedParameters`), but only the prompt can make the agent go
    // looking for the second paper. Raising the constant means rewording the
    // prompt — the number is spelled out in words there, for an agent to read.
    expect(MIN_SOURCES_PER_PARAMETER).toBe(2);
    expect(prompt).toMatch(/at least two independent sources/i);
  });

  it('tells the agent that two readings from one paper are one source', () => {
    // Without this the "two sources" rule is satisfiable by splitting a single
    // study's subgroups, which pools one measurement twice.
    expect(prompt).toMatch(/Independent means different papers/i);
  });

  it('makes the two-source ask part of the search plan, not just the output shape', () => {
    // Stated only as a property of the finished JSON, the rule reads as "report
    // a second source if you have one" and leaves the agent planning one search
    // per parameter. It has to reach the agent before it starts searching —
    // "Before you start" is where the run is budgeted.
    const beforeYouStart = prompt.slice(
      prompt.indexOf('## Before you start'),
      prompt.indexOf('## Output format'),
    );
    expect(beforeYouStart).toMatch(/two independent papers/i);
  });

  it('asks for a sweep of the thin parameters before emitting', () => {
    // The check that distinguishes "the literature has one paper" from "the
    // search stopped at the first hit" — indistinguishable in the output, so
    // only the agent can make it, and only before it emits.
    expect(prompt).toMatch(/thin-parameter sweep/i);
    // Scoped the way `thinlySourcedParameters` counts: a finalized parameter
    // with a synthesized value and no readings at all is reported as 0 papers,
    // so the sweep has to cover it too, not just the one-reading case.
    expect(prompt).toMatch(/fewer\s*\n?\s*than two distinct papers/i);
  });
});
