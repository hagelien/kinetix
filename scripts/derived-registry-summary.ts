/**
 * Summarise what a derived-registry refresh changed, as Markdown for the refresh pull request.
 *
 *   npx tsx scripts/derived-registry-summary.ts <before.ts> <after.ts>
 *
 * Both arguments are copies of `src/lib/kinetics-core/generated-registry.ts`. The artifact is read
 * as data — the object literal between `=` and `as const` — rather than imported, so a copy can sit
 * anywhere. The report is written for whoever merges the refresh: how many drugs gained or lost a
 * model, how the grades moved, and which drugs changed.
 */
import { readFileSync } from 'node:fs';
import { assessDerivedModel } from '../src/lib/kinetics-core/derived-model-grade';
import type { DerivedModelGrade } from '../src/lib/kinetics-core/derived-grade';
import { evaluateGradePolicy } from '../src/lib/kinetics-core/grade-policy';
import type { DrugModelDefinition } from '../src/lib/kinetics-core/types';

interface Artifact {
  checksum: string;
  derivedDefinitions: DrugModelDefinition[];
  derivedGrades: DerivedModelGrade[];
  notModelable: { slug: string }[];
}

/** Parse a committed artifact file's object literal. */
function readArtifact(path: string): Artifact {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('= {');
  const end = text.lastIndexOf('} as const');
  if (start < 0 || end < 0) throw new Error(`${path} is not a generated registry artifact`);
  return JSON.parse(text.slice(start + 2, end + 1)) as Artifact;
}

/** The overall §5.1 grade of each derived route, keyed `analyte/route`. */
function routeGrades(artifact: Artifact): Map<string, string> {
  const out = new Map<string, string>();
  for (const grade of artifact.derivedGrades) {
    const definition = artifact.derivedDefinitions.find((d) => d.analyte === grade.analyte);
    if (!definition) continue;
    for (const route of grade.routes) {
      const result = evaluateGradePolicy(assessDerivedModel(definition, route));
      out.set(`${grade.analyte}/${route.route}`, result.grade ?? 'none');
    }
  }
  return out;
}

const tally = (grades: Map<string, string>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const grade of grades.values()) counts[grade] = (counts[grade] ?? 0) + 1;
  return counts;
};

const list = (items: readonly string[], limit = 25): string =>
  items.length === 0
    ? 'none'
    : items.slice(0, limit).join(', ') + (items.length > limit ? `, and ${items.length - limit} more` : '');

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: derived-registry-summary.ts <before.ts> <after.ts>');
  process.exit(2);
}
const before = readArtifact(beforePath);
const after = readArtifact(afterPath);

const beforeDefs = new Map(before.derivedDefinitions.map((d) => [d.analyte, JSON.stringify(d)]));
const afterDefs = new Map(after.derivedDefinitions.map((d) => [d.analyte, JSON.stringify(d)]));
const added = [...afterDefs.keys()].filter((a) => !beforeDefs.has(a)).sort();
const removed = [...beforeDefs.keys()].filter((a) => !afterDefs.has(a)).sort();
const changed = [...afterDefs.keys()]
  .filter((a) => beforeDefs.has(a) && beforeDefs.get(a) !== afterDefs.get(a))
  .sort();

const beforeGrades = routeGrades(before);
const afterGrades = routeGrades(after);
const gradeMoves = [...afterGrades.entries()]
  .filter(([key, grade]) => beforeGrades.has(key) && beforeGrades.get(key) !== grade)
  .map(([key, grade]) => `${key} ${beforeGrades.get(key)} → ${grade}`)
  .sort();
const gradeLine = (counts: Record<string, number>) =>
  ['A', 'B', 'C', 'D']
    .filter((g) => counts[g])
    .map((g) => `${g}: ${counts[g]}`)
    .join(', ') || 'none';

console.log(`## What the catalog changed

| | Before | After |
| --- | --- | --- |
| Drugs with a model | ${before.derivedDefinitions.length} | ${after.derivedDefinitions.length} |
| Drugs with no model yet | ${before.notModelable.length} | ${after.notModelable.length} |
| Route grades | ${gradeLine(tally(beforeGrades))} | ${gradeLine(tally(afterGrades))} |
| Checksum | \`${before.checksum}\` | \`${after.checksum}\` |

- **New models:** ${list(added)}
- **Models no longer built:** ${list(removed)}
- **Models with changed values:** ${list(changed)}
- **Grade changes:** ${list(gradeMoves)}`);
