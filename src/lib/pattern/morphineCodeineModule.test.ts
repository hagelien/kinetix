import { describe, expect, it } from 'vitest';

import { embeddedComponents } from '../../../data/components.js';
import { patternCaseDataSchema } from '../patternCases.js';
import type { PatternCaseData } from '../../types/patternCase.js';
import { buildProfileFromCase } from './buildProfile.js';
import { catalogMolecularWeight } from './catalogAnalytes.js';
import {
  featuredPatternSubstances,
  moduleSubstanceCids,
  patternModuleById,
} from './modules/index.js';
import { MORPHINE_CODEINE_MODULE } from './modules/morphineCodeine.js';
import { resolveObservations } from './resolveObservations.js';
import { assertModuleWellFormed, molecularWeightLookup } from './substanceModules.js';

const EXPECTED_CIDS = [5288826, 5284371, 5484731, 5360621, 5489029];

function exampleCase(): PatternCaseData {
  return {
    kind: 'pattern-case',
    schemaVersion: 1,
    moduleIds: [MORPHINE_CODEINE_MODULE.id],
    normalization: { creatinineReferenceMmolL: 8.84 },
    context: { postmortem: false, timeOrigin: 'first_specimen_collection', fields: {} },
    specimens: [{ id: 'urine-1', matrix: 'urine', urine: { creatinineMmolL: 4.42 } }],
    observations: MORPHINE_CODEINE_MODULE.analytes.map(({ analyte }, index) => ({
      id: `result-${index + 1}`,
      specimenId: 'urine-1',
      analyte,
      // One µmol/L of each distinct chemical species in its own mass units.
      value: catalogMolecularWeight(analyte)!,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: index < 2 ? 'free' : 'direct_conjugate' },
    })),
  };
}

describe('morphine/codeine entry module', () => {
  it('resolves all five analytes through the canonical module and catalog identities', () => {
    expect(patternModuleById('morphine-codeine')).toBe(MORPHINE_CODEINE_MODULE);
    expect(() => assertModuleWellFormed(MORPHINE_CODEINE_MODULE)).not.toThrow();
    expect(new Set(moduleSubstanceCids(MORPHINE_CODEINE_MODULE))).toEqual(new Set(EXPECTED_CIDS));
    for (const cid of EXPECTED_CIDS) {
      expect(embeddedComponents.filter((entry) => entry.pubchemCid === cid)).toHaveLength(1);
    }
    expect(featuredPatternSubstances.map((entry) => entry.pubchemCid)).toEqual([
      3016, 5288826, 5284371,
    ]);
  });

  it('round-trips mass-reported glucuronides and resolves with their own molecular weights', () => {
    const original = exampleCase();
    const reopened = patternCaseDataSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(reopened).toEqual(original);
    const resolved = resolveObservations(reopened, { molecularWeightOf: molecularWeightLookup() });
    expect(resolved.map((entry) => entry.measurandMode)).toEqual([
      'free', 'free', 'direct_conjugate', 'direct_conjugate', 'direct_conjugate',
    ]);
    for (const result of resolved) {
      expect(result.status).toBe('point');
      expect(result.micromolarPerL.low).toBeCloseTo(1, 10);
      expect(result.micromolarPerL.high).toBeCloseTo(1, 10);
    }
  });

  it('keeps glucuronide identity separate from a result reported on the parent mass basis', () => {
    const caseData = exampleCase();
    caseData.observations[2] = {
      ...caseData.observations[2]!,
      value: 285.34,
      assay: { measurandMode: 'direct_conjugate', reportedAsDrugId: 5288826 },
    };
    const result = resolveObservations(caseData, { molecularWeightOf: molecularWeightLookup() })[2]!;
    expect(result.analyte.pubchemCid).toBe(5484731);
    expect(result.micromolarPerL.low).toBeCloseTo(1, 10);
  });

  it('shows measurements without manufacturing empirical reference bands or interpretations', () => {
    const profile = buildProfileFromCase({
      caseData: exampleCase(),
      modules: [MORPHINE_CODEINE_MODULE],
      graph: { nodes: [], edges: [] },
      locale: 'nb-NO',
    });
    expect(profile.observations).toHaveLength(5);
    expect(profile.ratioGroups).toEqual([]);
    expect(profile.provisional.totalBands).toBe(0);
    expect(MORPHINE_CODEINE_MODULE.signals).toEqual([]);
  });
});
