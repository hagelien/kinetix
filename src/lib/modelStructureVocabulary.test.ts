/**
 * CV-1b — the model-structure axis vocabularies must agree in three places:
 *   1. kinetics-core (`DISPOSITION_KINDS` / `ELIMINATION_KINDS` / `ABSORPTION_KINDS`) — the engine,
 *   2. the drug-parameter registry (`DRUG_PARAMETERS[axis].allowedValues`) — the app,
 *   3. the `0109_model_structure_axes` migration's CHECK function — the database.
 *
 * A value admissible in one and not another would let a declaration be stored that the engine
 * cannot compose, or a valid engine value be rejected at write time. This test holds all three
 * in step, the way `citationWorkKind` holds its SQL and TS vocabularies together.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DISPOSITION_KINDS,
  ELIMINATION_KINDS,
  ABSORPTION_KINDS,
  ROUTE_IDS,
} from './kinetics-core/index.js';
import { DRUG_PARAMETERS } from './drugParameters.js';

const MIGRATION = readFileSync('drizzle/0109_model_structure_axes.sql', 'utf8');
const ROUTE_MIGRATION = readFileSync('drizzle/0111_route_scoped_parameter_entries.sql', 'utf8');

/** Extract the `p_value IN ('a', 'b', …)` list the migration's CHECK function uses for one axis. */
function sqlVocabularyFor(parameter: string): string[] {
  const re = new RegExp(`WHEN '${parameter}' THEN\\s*p_value IN \\(([^)]*)\\)`);
  const m = MIGRATION.match(re);
  if (!m) throw new Error(`no SQL vocabulary found for ${parameter}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!);
}

const AXES = [
  { parameter: 'dispositionModel', engine: DISPOSITION_KINDS },
  { parameter: 'eliminationModel', engine: ELIMINATION_KINDS },
  { parameter: 'absorptionModel', engine: ABSORPTION_KINDS },
] as const;

describe('CV-1b — model-structure axis vocabularies agree across engine / registry / DB', () => {
  for (const { parameter, engine } of AXES) {
    it(`${parameter}: registry allowedValues == kinetics-core vocabulary`, () => {
      const spec = DRUG_PARAMETERS[parameter as keyof typeof DRUG_PARAMETERS];
      expect(spec.kind).toBe('enum');
      // The registry reuses the engine arrays by reference, but assert VALUE equality so the
      // guarantee survives a future refactor that stops sharing the array.
      expect([...(spec as { allowedValues: readonly string[] }).allowedValues].sort()).toEqual(
        [...engine].sort(),
      );
    });

    it(`${parameter}: 0109 migration CHECK vocabulary == kinetics-core vocabulary`, () => {
      expect(sqlVocabularyFor(parameter).sort()).toEqual([...engine].sort());
    });
  }
});

describe('CV-2c — route vocabulary agrees across engine and DB', () => {
  it('0111 migration route CHECK vocabulary == kinetics-core ROUTE_IDS', () => {
    // The route CHECK is `"route" IN ('oral', 'intranasal', …)`; extract that list.
    const m = ROUTE_MIGRATION.match(/"route" IN \(([^)]*)\)/);
    if (!m) throw new Error('no route vocabulary found in 0111 migration');
    const sqlRoutes = [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!);
    expect(sqlRoutes.sort()).toEqual([...ROUTE_IDS].sort());
  });
});
