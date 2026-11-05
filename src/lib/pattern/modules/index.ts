/**
 * Every substance module the app ships.
 *
 * Adding a drug family is a data change (§4.1), and this is the one list that
 * has to know about it. The graph endpoint reads it server-side to turn a
 * module id into the substances whose metabolism neighbourhood a case needs —
 * which is why the modules are plain data with no browser dependencies.
 */

import { BENZODIAZEPINE_MODULE } from './benzodiazepines.js';
import { COCAINE_MODULE } from './cocaine.js';
import { METHADONE_MODULE } from './methadone.js';
import { CODEINE, MORPHINE, MORPHINE_CODEINE_MODULE } from './morphineCodeine.js';
import type { PatternSubstanceModule } from '../substanceModules.js';
import type { PatternMatrix } from '../../../types/patternCase.js';

export const PATTERN_MODULES: readonly PatternSubstanceModule[] = [
  BENZODIAZEPINE_MODULE,
  COCAINE_MODULE,
  METHADONE_MODULE,
  MORPHINE_CODEINE_MODULE,
];

/** Entry shortcuts, with labels resolved from the same module analytes. */
export const featuredPatternSubstances = [
  BENZODIAZEPINE_MODULE.assumedParent,
  MORPHINE,
  CODEINE,
] as const;

/**
 * Routine entry panels are presentation defaults, not analytical exclusions.
 * Existing observations outside the panel must remain available to the editor.
 */
export function guidedPatternAnalytes(selectedCid: number, matrix?: PatternMatrix): readonly number[] | undefined {
  if (matrix === 'urine' && BENZODIAZEPINE_MODULE.analytes.some((item) => item.analyte.pubchemCid === selectedCid)) {
    return BENZODIAZEPINE_MODULE.analytes
      .filter((item) => item.analyte.pubchemCid !== BENZODIAZEPINE_MODULE.assumedParent.pubchemCid)
      .map((item) => item.analyte.pubchemCid);
  }
  return undefined;
}

export function patternModuleById(id: string): PatternSubstanceModule | undefined {
  return PATTERN_MODULES.find((module) => module.id === id);
}

/**
 * Every substance a module names, by PubChem CID: its assumed parent and its
 * analytes. Identity is the CID and never the slug (spec §16.5) — a slug is a
 * localised label and two catalogs disagree about it.
 */
export function moduleSubstanceCids(module: PatternSubstanceModule): number[] {
  return [
    ...new Set([
      module.assumedParent.pubchemCid,
      ...module.analytes.map((analyte) => analyte.analyte.pubchemCid),
    ]),
  ];
}
