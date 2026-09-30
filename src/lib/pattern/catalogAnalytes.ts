/**
 * Molecular weights, read from the catalog rather than copied beside it.
 *
 * A module names its analytes by PubChem CID and nothing else. Restating a
 * molecular weight in the registry would create a second copy of a value the
 * catalog already owns, and a later catalog correction would then silently move
 * every mass-to-molar result for that analyte while the registry sat unchanged —
 * the drift AGENTS.md's single-source rule exists to prevent.
 *
 * The consequence is deliberate and matches spec §16.5's own rule about identity:
 * a substance the catalog does not carry cannot be named by a feature. Where a
 * module needs one, it is added to the catalog first.
 */

import { embeddedComponents } from '../../../data/components.js';
import type { PatternDrugRef } from '../../types/patternCase.js';

const BY_CID = new Map<number, number>();
for (const component of embeddedComponents) {
  if (component.pubchemCid && component.molecularWeight) {
    BY_CID.set(component.pubchemCid, component.molecularWeight);
  }
}

export function catalogMolecularWeight(analyte: PatternDrugRef): number | undefined {
  return BY_CID.get(analyte.pubchemCid);
}

/** Every CID the catalog can supply a molecular weight for. */
export function catalogHasMolecularWeight(analyte: PatternDrugRef): boolean {
  return BY_CID.has(analyte.pubchemCid);
}
