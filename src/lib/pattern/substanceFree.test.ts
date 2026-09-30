/**
 * §4.1's first acceptance test: the substance-free component test.
 *
 * No substance name, analyte abbreviation, ratio formula or numeric threshold
 * may appear anywhere under `src/components/modeling/pattern/` or in
 * `profileModel.ts`. This is the mechanical half of the generalisation contract
 * — the half a reviewer cannot forget to check.
 *
 * It reads the files from disk rather than importing them, because what is being
 * asserted is a property of the source text, not of the exported values.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const COMPONENT_DIR = 'src/components/modeling/pattern';
const MODEL_FILE = 'src/lib/pattern/profileModel.ts';

/**
 * The diazepam family by name and abbreviation, plus the two families Phase 2
 * adds. Matching is case-insensitive and word-bounded so an unrelated
 * substring — "cocaine" inside a comment about "cocaineModule" would be caught,
 * which is intended — cannot slip through on casing alone.
 */
const SUBSTANCE_NAMES = [
  'diazepam',
  'nordazepam',
  'desmetyldiazepam',
  'desmethyldiazepam',
  'temazepam',
  'oxazepam',
  'cocaine',
  'kokain',
  'benzoylecgonin',
  'methadone',
  'metadon',
  'eddp',
  'codeine',
  'kodein',
  'morphine',
  'morfin',
  'heroin',
];

/**
 * Literals that would mean a threshold or a convention had been hard-coded into
 * the view: the pinned axis bounds, the creatinine reference in either
 * convention, and the prototype's inline ratio formula.
 */
const FORBIDDEN_LITERALS = ['0.03', '8.84', '8.4', '10 / ', '1.45', '1,45'];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    // Test files are excluded deliberately. A test of this view asserts on the
    // Norwegian a reader sees, which necessarily names substances; what §4.1
    // forbids is substance knowledge in the code that *renders*, since that is
    // what a second module would have to change.
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the view carries no substance knowledge (§4.1)', () => {
  const files = [...sourceFiles(COMPONENT_DIR), MODEL_FILE].filter((f) => existsSync(f));

  it('has files to check', () => {
    // Guards against the test passing vacuously if the paths are ever moved:
    // profileModel.ts alone must always be present.
    expect(files).toContain(MODEL_FILE);
  });

  it.each(SUBSTANCE_NAMES)('names no substance: %s', (name) => {
    const pattern = new RegExp(`\\b${name}`, 'i');
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(pattern.test(source), `${file} names "${name}"`).toBe(false);
    }
  });

  it.each(FORBIDDEN_LITERALS)('hard-codes no threshold: %s', (literal) => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes(literal), `${file} contains the literal "${literal}"`).toBe(false);
    }
  });
});
