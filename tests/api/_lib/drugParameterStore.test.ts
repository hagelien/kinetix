import { describe, expect, it } from 'vitest';
import {
  isStoredInDrugParameters,
  mergeDrugParametersIntoRow,
} from '../../../api/_lib/drugParameterStore.ts';

describe('isStoredInDrugParameters (#302 P2)', () => {
  it('routes the eight grouped parameters through the row table', () => {
    expect(isStoredInDrugParameters('halfLife')).toBe(true);
    expect(isStoredInDrugParameters('volumeOfDistribution')).toBe(true);
    expect(isStoredInDrugParameters('bioavailability')).toBe(true);
    expect(isStoredInDrugParameters('proteinBinding')).toBe(true);
    expect(isStoredInDrugParameters('bloodPlasmaRatio')).toBe(true);
    expect(isStoredInDrugParameters('tmax')).toBe(true);
    expect(isStoredInDrugParameters('pKa')).toBe(true);
    expect(isStoredInDrugParameters('molecularWeight')).toBe(true);
  });

  it('keeps drug-row metadata on `drugs` (group=null)', () => {
    expect(isStoredInDrugParameters('nameNb')).toBe(false);
    expect(isStoredInDrugParameters('nameEn')).toBe(false);
    expect(isStoredInDrugParameters('nameShort')).toBe(false);
    expect(isStoredInDrugParameters('aliases')).toBe(false);
    expect(isStoredInDrugParameters('pubchemCid')).toBe(false);
  });

  it('rejects unknown ids', () => {
    expect(isStoredInDrugParameters('cmax')).toBe(false);
    expect(isStoredInDrugParameters('not-a-real-param')).toBe(false);
    expect(isStoredInDrugParameters('')).toBe(false);
  });
});

describe('mergeDrugParametersIntoRow', () => {
  it('flattens parameter values onto the drug row (with null-fill for the rest)', () => {
    const row = { id: 1, slug: 'paracetamol' };
    const params = new Map<string, unknown>([
      ['molecularWeight', 151.16],
      ['halfLife', { min: 1.5, max: 3, unit: 'h' }],
    ]);
    const merged = mergeDrugParametersIntoRow(row, params);
    expect(merged.id).toBe(1);
    expect(merged.slug).toBe('paracetamol');
    expect(merged.molecularWeight).toBe(151.16);
    expect(merged.halfLife).toEqual({ min: 1.5, max: 3, unit: 'h' });
    // Migrated parameters absent from the map are null-filled to keep
    // the legacy `drug.<param>` response shape stable.
    expect(merged.volumeOfDistribution).toBeNull();
    expect(merged.bioavailability).toBeNull();
    expect(merged.proteinBinding).toBeNull();
    expect(merged.bloodPlasmaRatio).toBeNull();
    expect(merged.tmax).toBeNull();
    expect(merged.pKa).toBeNull();
  });

  it('null-fills migrated parameters absent from the param map', () => {
    const row = { id: 3, slug: 'lorazepam' };
    const merged = mergeDrugParametersIntoRow(row, new Map());
    // All eight migrated parameters appear as null on the response so
    // the legacy `drug.<param>` contract (required nullable) stays stable.
    expect(merged.halfLife).toBeNull();
    expect(merged.volumeOfDistribution).toBeNull();
    expect(merged.bioavailability).toBeNull();
    expect(merged.proteinBinding).toBeNull();
    expect(merged.bloodPlasmaRatio).toBeNull();
    expect(merged.tmax).toBeNull();
    expect(merged.pKa).toBeNull();
    expect(merged.molecularWeight).toBeNull();
  });

  it('preserves existing row values over the null-fill defaults', () => {
    // If the row already carries a value (e.g. cmax-style legacy column
    // still present on `drugs`), the null-fill must not stomp it.
    const row = { id: 4, halfLife: { min: 1, max: 3, unit: 'h' } };
    const merged = mergeDrugParametersIntoRow(row, new Map());
    expect(merged.halfLife).toEqual({ min: 1, max: 3, unit: 'h' });
  });

  it('returns a fresh object even when the param map is missing', () => {
    const row = { id: 2 };
    const merged = mergeDrugParametersIntoRow(row, undefined);
    expect(merged).not.toBe(row);
    // Migrated params still null-filled on the new copy.
    expect(merged.halfLife).toBeNull();
  });
});
