import { describe, expect, it } from 'vitest';
import {
  buildDrugComponentId,
  keyComponentByLookupId,
  parseInternalDrugComponentId,
  simulatorDrugKeyCandidates,
} from './drugComponentId';

describe('buildDrugComponentId', () => {
  it('keys a CID-bearing drug by its bare CID, unchanged from before #1256', () => {
    expect(buildDrugComponentId({ id: 42, pubchemCid: 2118 })).toBe('2118');
  });

  it('keys a CID-less drug by its internal id under an explicit prefix', () => {
    expect(buildDrugComponentId({ id: 803, pubchemCid: null })).toBe('drug:803');
  });

  it('treats a missing pubchemCid field the same as null', () => {
    expect(buildDrugComponentId({ id: 803 })).toBe('drug:803');
  });
});

describe('parseInternalDrugComponentId', () => {
  it('extracts the internal id from a prefixed key', () => {
    expect(parseInternalDrugComponentId('drug:803')).toBe(803);
  });

  it('returns null for a bare numeric key (a CID, or a pre-#1256 CID-less id)', () => {
    expect(parseInternalDrugComponentId('2118')).toBeNull();
  });

  it('returns null for a slug', () => {
    expect(parseInternalDrugComponentId('alprazolam')).toBeNull();
  });

  it('returns null for a malformed prefixed key', () => {
    expect(parseInternalDrugComponentId('drug:')).toBeNull();
    expect(parseInternalDrugComponentId('drug:abc')).toBeNull();
    expect(parseInternalDrugComponentId('drug:-1')).toBeNull();
    expect(parseInternalDrugComponentId('drug:0')).toBeNull();
  });
});

describe('simulatorDrugKeyCandidates', () => {
  it('returns only the CID for a CID-bearing drug', () => {
    expect(simulatorDrugKeyCandidates({ id: 42, pubchemCid: 2118 })).toEqual([
      '2118',
    ]);
  });

  it('returns both the legacy bare id and the prefixed key for a CID-less drug', () => {
    expect(simulatorDrugKeyCandidates({ id: 803, pubchemCid: null })).toEqual([
      '803',
      'drug:803',
    ]);
  });
});

describe('keyComponentByLookupId', () => {
  it('leaves a component untouched when its id already matches the lookup key', () => {
    const component = { id: '2118', name: 'Alprazolam' };
    expect(keyComponentByLookupId(component, '2118')).toBe(component);
  });

  it('rekeys a component whose canonical id diverges from a pre-#1256 legacy lookup key', () => {
    // `fetchDrugComponentById` was reached via the bare-numeric fallback for
    // a CID-less drug, so `drugRowToComponent` mints 'drug:803' — but the
    // caller (a saved case predating #1256) looked it up as '803'.
    const component = { id: 'drug:803', name: 'Some CID-less drug' };
    const rekeyed = keyComponentByLookupId(component, '803');
    expect(rekeyed).toEqual({ id: '803', name: 'Some CID-less drug' });
    expect(rekeyed).not.toBe(component);
  });

  it('rekeys a component whose drug was retargeted onto a different CID since the key was saved', () => {
    const component = { id: '9999', name: 'Retargeted drug' };
    const rekeyed = keyComponentByLookupId(component, '1234');
    expect(rekeyed.id).toBe('1234');
  });
});
