import { describe, expect, it } from 'vitest';
import { buildSimulatorUrl, resolveSimulatorModeForDrug } from './simulatorRouting';

describe('resolveSimulatorModeForDrug', () => {
  it('routes CID 702 to workbook-ethanol mode', () => {
    expect(resolveSimulatorModeForDrug({ id: '702', pubchemCid: 702 })).toBe('workbook-ethanol');
  });

  it('prefers CID over fallback id checks', () => {
    expect(resolveSimulatorModeForDrug({ id: '702', pubchemCid: 111 })).toBe('standard');
  });

  it('uses defensive id fallback only for explicitly CID-prefixed identifiers', () => {
    expect(resolveSimulatorModeForDrug({ id: 'CID:702' })).toBe('workbook-ethanol');
    expect(resolveSimulatorModeForDrug({ id: 'pubchem:702' })).toBe('workbook-ethanol');
  });

  it('routes non-ethanol drugs to standard mode', () => {
    expect(resolveSimulatorModeForDrug({ id: '149', pubchemCid: 149 })).toBe('standard');
  });

  it('does not route bare id "702" to ethanol when CID is missing (could be a DB serial)', () => {
    expect(resolveSimulatorModeForDrug({ id: '702', pubchemCid: null })).toBe('standard');
    expect(resolveSimulatorModeForDrug({ id: 702 })).toBe('standard');
    expect(resolveSimulatorModeForDrug({ id: '702', dbId: 702, pubchemCid: null })).toBe('standard');
  });
});

describe('buildSimulatorUrl', () => {
  it('routes ethanol to /modeling?mode=ethanol', () => {
    expect(buildSimulatorUrl({ id: '702', pubchemCid: 702 })).toBe(
      '/modeling?mode=ethanol&drugId=702',
    );
  });

  it('routes non-ethanol drugs to /modeling?mode=simulator', () => {
    expect(buildSimulatorUrl({ id: '149', pubchemCid: 149 })).toBe(
      '/modeling?mode=simulator&drugId=149',
    );
  });

  it('adds concentration payload when provided', () => {
    expect(
      buildSimulatorUrl(
        { id: '702', pubchemCid: 702 },
        { concentration: 1.25, concentrationUnit: 'mg/L' },
      ),
    ).toBe('/modeling?mode=ethanol&drugId=702&conc=1.25&concUnit=mg%2FL');
  });
});
