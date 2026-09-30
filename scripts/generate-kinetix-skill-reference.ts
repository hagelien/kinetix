/**
 * Skill reference generator + drift gate.
 *
 *   npx tsx scripts/generate-kinetix-skill-reference.ts          # (re)write the reference
 *   npx tsx scripts/generate-kinetix-skill-reference.ts --check  # fail when stale
 *
 * The `kinetix` skill runs in a chat window with no connection to this codebase,
 * so it cannot look up which parameter ids exist, what units they take, or which
 * monograph sections are real. Left guessing, a model invents plausible ones
 * (`morphineCodeineRatio`, `forensic_toxicology`) and the bundle fails at the
 * boundary. This writes the closed vocabularies into the skill folder so the
 * model authors against the same registry the app enforces.
 *
 * `--check` is the drift gate: the registry is edited far more often than the
 * skill, and a silently stale reference is worse than none, because it reads as
 * authoritative. Run it in the same place as `catalog:check`.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_ONLY_PARAMETER_IDS,
  SUMMARIZED_PARAMETER_IDS,
  getRangeSpec,
  parameterIsMatrixRelevant,
  parameterIsScenarioRelevant,
  type DrugParameterId,
} from '../src/lib/drugParameters.js';
import { entryUnitsForParameter } from '../src/lib/parameterUnits.js';
import { MONOGRAPH_SECTIONS } from '../src/lib/monographSections.js';
import {
  REFERENCE_MATRICES,
  REFERENCE_SCENARIOS,
} from '../src/lib/referenceConcentrations.js';
import { QUALIFIER_OPERATORS } from '../src/types/index.js';
import { DERIVATION_KINDS } from '../src/lib/conversationIngestion.js';
import {
  CENTRAL_STATISTICS,
  COADMINISTRATION_STATES,
  DOSE_BASES,
  DOSE_CONTEXT_DOSE_UNITS,
  DOSE_REGIMENS,
  INTERVAL_KINDS,
  IV_INPUT_MODES,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  PRANDIAL_STATES,
  RELEASE_PROFILES,
  VALUE_BASES,
} from '../src/lib/entryDoseContext.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(
  here,
  '..',
  '.claude',
  'skills',
  'kinetix',
  'reference',
  'vocabularies.md',
);

function fmtBound(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return Number.isInteger(n) ? String(n) : String(n);
}

function units(id: DrugParameterId): string {
  const list = entryUnitsForParameter(id);
  if (list.length === 0) return '—';
  if (list.length === 1) return `\`${list[0] || '(none)'}\``;
  // The concentration parameters all share one long unit family; naming it once
  // keeps the table readable instead of repeating 18 units per row.
  if (list.length > 6) return `any concentration unit (see below)`;
  return list.map((u) => `\`${u || '(none)'}\``).join(', ');
}

function build(): string {
  const lines: string[] = [];

  lines.push('# Kinetix closed vocabularies');
  lines.push('');
  lines.push(
    '**Generated file — do not edit by hand.** Regenerate with `npm run skill:reference`;',
  );
  lines.push(
    '`npm run skill:reference:check` fails when it has drifted from the code.',
  );
  lines.push('');
  lines.push(
    'Every identifier below is closed: a value outside these lists is rejected by',
  );
  lines.push(
    '`parseConversationIngestion`. If the thing you need is not here, it is not a',
  );
  lines.push('missing entry to invent — it is a `blockedCandidate`.');
  lines.push('');

  // ── Parameters ──
  lines.push('## Parameter ids');
  lines.push('');
  lines.push(
    'The only parameters that accept a per-source observation. Metadata (names,',
  );
  lines.push(
    'aliases, molecular weight, PubChem CID) and analyte stability are',
  );
  lines.push(
    'deliberately absent — they are not poolable across sources. LOQ and LOD are',
  );
  lines.push(
    'absent for a different reason: they are not parameters at all. An analytical',
  );
  lines.push(
    'limit belongs to a validated method in a laboratory, not to the substance,',
  );
  lines.push('and Kinetix records it per analyte per analytical method.');
  lines.push('');
  lines.push('| id | unit | range | matrix | scenario | low & high |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const id of SUMMARIZED_PARAMETER_IDS) {
    const spec = getRangeSpec(id);
    const canonical = spec.canonicalUnit || 'dimensionless';
    lines.push(
      `| \`${id}\` | ${units(id)} | ${fmtBound(spec.bounds.min)}–${fmtBound(spec.bounds.max)} ${canonical} | ${
        parameterIsMatrixRelevant(id) ? '**required**' : 'forbidden'
      } | ${parameterIsScenarioRelevant(id) ? '**required**' : 'forbidden'} | ${
        spec.requiresMinMax ? '**both required**' : 'optional'
      } |`,
    );
  }
  lines.push('');
  lines.push(
    'Bounds are checked in the canonical unit, so a value in a denser unit is',
  );
  lines.push('converted before the check — 1e6 µg/mL does not sneak past mg/L.');
  lines.push('');
  lines.push(
    'A parameter marked **both required** under "low & high" rejects an entry',
  );
  lines.push(
    'backed by only a `median`: report the range the source gives, not a',
  );
  lines.push(
    'single reading. Never invent bounds by setting `low = high = median` —',
  );
  lines.push('that asserts a zero-width range the source never reported.');
  lines.push('');

  const concentrationUnits = entryUnitsForParameter(
    'therapeuticConcentration' as DrugParameterId,
  );
  lines.push('### Concentration units');
  lines.push('');
  lines.push(concentrationUnits.map((u) => `\`${u}\``).join(', '));
  lines.push('');
  lines.push(
    'Report the unit the source used. Do not convert to make a value look',
  );
  lines.push('comparable — the aggregation pipeline converts, and it records that it did.');
  lines.push('');

  // ── Dose-context parameters (Cmax dose-context RFC) ──
  lines.push('## Dose-context parameters');
  lines.push('');
  lines.push(
    'Entry-only parameters whose readings carry structured `doseContext` (see',
  );
  lines.push('SKILL.md, "Cmax: structured dose context"). A `valueBasis` is required.');
  lines.push('');
  lines.push(
    'Every other numeric parameter takes only the reported-statistic fields of',
  );
  lines.push(
    '`doseContext` — `centralValue`, `centralStatistic`, `intervalKind` — optionally',
  );
  lines.push('(see SKILL.md, "What the number is"); every dose field is refused there.');
  lines.push('');
  for (const id of ENTRY_ONLY_PARAMETER_IDS) {
    const spec = getRangeSpec(id);
    lines.push(
      `- \`${id}\` — matrix ${parameterIsMatrixRelevant(id) ? '**required**' : 'forbidden'}; ` +
        `concentration units as above for \`valueBasis: "concentration"\`; ` +
        `a concentration-per-dose unit (e.g. \`µmol/L/mg\`, \`ng/mL/(mg/kg)\`) for ` +
        `\`"dose_normalized"\`; range ${fmtBound(spec.bounds.min)}–${fmtBound(spec.bounds.max)}.`,
    );
  }
  lines.push('');
  const vocab: Array<[string, readonly string[]]> = [
    ['valueBasis', VALUE_BASES],
    ['centralStatistic', CENTRAL_STATISTICS],
    ['intervalKind', INTERVAL_KINDS],
    ['doseUnit', DOSE_CONTEXT_DOSE_UNITS],
    ['doseBasis', DOSE_BASES],
    ['doseRegimen', DOSE_REGIMENS],
    ['ivInputMode', IV_INPUT_MODES],
    ['releaseProfile', RELEASE_PROFILES],
    ['physicalForm', PHYSICAL_FORMS],
    ['prandialState', PRANDIAL_STATES],
    ['coadministrationState', COADMINISTRATION_STATES],
    ['pkPopulation', PK_POPULATIONS],
  ];
  lines.push('| doseContext field | values |');
  lines.push('| --- | --- |');
  for (const [field, values] of vocab) {
    lines.push(`| \`${field}\` | ${values.map((v) => `\`${v}\``).join(', ')} |`);
  }
  lines.push('');

  // ── Matrices / scenarios ──
  lines.push('## Matrices');
  lines.push('');
  lines.push(REFERENCE_MATRICES.map((m) => `\`${m}\``).join(', '));
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push(REFERENCE_SCENARIOS.map((s) => `\`${s}\``).join(', '));
  lines.push('');
  lines.push(
    'A scenario is the interpretive reading a concentration belongs to, not the',
  );
  lines.push(
    'study design. A half-life has no scenario; its study context goes in',
  );
  lines.push('`context`.');
  lines.push('');

  // ── Qualifiers / derivation ──
  lines.push('## Qualifiers');
  lines.push('');
  lines.push(QUALIFIER_OPERATORS.map((q) => `\`${q}\``).join(', '));
  lines.push('');
  lines.push(
    'A qualifier marks ONE censored threshold (`< LOQ`), so a qualified',
  );
  lines.push(
    'observation carries a single value — never a low..high range.',
  );
  lines.push('');
  lines.push('## Derivation kinds');
  lines.push('');
  lines.push(DERIVATION_KINDS.map((d) => `\`${d}\``).join(', '));
  lines.push('');
  lines.push(
    'Only `reported` means the number is printed in the source. Anything else',
  );
  lines.push('needs `context.derivation.assumptions`.');
  lines.push('');

  // ── Monograph sections ──
  lines.push('## Monograph section ids');
  lines.push('');
  lines.push(
    'Use the id, never a translated title. Every drug already has a monograph;',
  );
  lines.push('never propose a new page for a drug that exists.');
  lines.push('');
  lines.push('| id | Norwegian | English |');
  lines.push('| --- | --- | --- |');
  for (const section of MONOGRAPH_SECTIONS) {
    lines.push(
      `| \`${section.id}\` | ${section.titleNb} | ${section.titleEn} |`,
    );
  }
  lines.push('');
  lines.push('## Source types');
  lines.push('');
  lines.push('`pmid`, `doi`, `url`');
  lines.push('');
  lines.push(
    'There is no `freetext`: a paper review requires a resolvable citation, and',
  );
  lines.push(
    'every committed item depends on one. A textbook with no DOI backs a',
  );
  lines.push('`blockedCandidate`, not an item.');
  lines.push('');

  return lines.join('\n');
}

const markdown = build();
const check = process.argv.includes('--check');

if (check) {
  let existing = '';
  try {
    existing = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(
      `✗ ${OUT_PATH} is missing. Run: npm run skill:reference`,
    );
    process.exit(1);
  }
  if (existing !== markdown) {
    console.error(
      '✗ .claude/skills/kinetix/reference/vocabularies.md is stale — the registry or\n' +
        '  monograph sections changed without regenerating it. Run: npm run skill:reference',
    );
    process.exit(1);
  }
  console.log('✓ Kinetix skill reference is up to date.');
  process.exit(0);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, markdown);
console.log(`✓ Wrote ${OUT_PATH}`);
