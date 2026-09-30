import { describe, it, expect } from 'vitest';
import {
  parseResearchOutput,
  citationFromSource,
  normalizeParameterValue,
  recountSourceValueCoverage,
  thinlySourcedParameters,
  DEEP_RESEARCH_SCHEMA_VERSION,
  MIN_SOURCES_PER_PARAMETER,
  SOURCE_VALUE_COVERAGE_PREFIX,
} from './deepResearchImport.js';

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    drugIdentity: { names: { nb: 'Kokain', en: 'Cocaine' }, pubchemCid: 446220 },
    kinetixParameterValues: [],
    sources: [],
    ...overrides,
  };
}

describe('parseResearchOutput — envelope', () => {
  it('rejects when no drug name is present', () => {
    const res = parseResearchOutput({ drugIdentity: {} });
    expect(res.ok).toBe(false);
  });

  it('accepts minimal identity and reports version mismatch as a warning', () => {
    const res = parseResearchOutput({
      schemaVersion: 'something-else',
      drugIdentity: { names: { nb: 'Kokain' } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.drug.nameNb).toBe('Kokain');
    expect(res.data.warnings.some((w) => w.includes('schemaVersion'))).toBe(true);
  });

  it('falls back to preferredName for the English name', () => {
    const res = parseResearchOutput({ drugIdentity: { preferredName: 'Cocaine' } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.drug.nameEn).toBe('Cocaine');
  });
});

describe('parseResearchOutput — parameters', () => {
  it('validates a finalized halfLife (requiresMinMax) against the registry', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, median: 1.2, unit: 'h', note: 'adult plasma' },
            sourceIds: ['S1'],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(1);
    expect(res.data.parameters[0]!.parameter).toBe('halfLife');
    expect(res.data.parameters[0]!.sourceIds).toEqual(['S1']);
  });

  it('skips a not_finalized value', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'halfLife', status: 'not_finalized', value: { min: 1, max: 2, unit: 'h' } },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.parameters).toHaveLength(0);
  });

  it('skips a model-structure axis — it is entry-backed, not seeded here', () => {
    // A finalized dispositionModel value must never be written to drug_parameters
    // by the importer: the axis is a cited parameter_entries declaration, and the
    // model-structure UI reads only those, so a seeded value would be unreviewed
    // and invisible. It is dropped with a warning that names the reason.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'dispositionModel',
            status: 'finalized',
            value: 'two-compartment',
            sourceIds: ['S1'],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(0);
    expect(
      res.data.warnings.some(
        (w) => w.includes('dispositionModel') && /model structure/i.test(w),
      ),
    ).toBe(true);
  });

  it('skips an unknown parameter id with a warning', () => {
    const res = parseResearchOutput(
      baseDoc({ kinetixParameterValues: [{ parameter: 'cmin', value: { min: 1, max: 2 } }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('cmin'))).toBe(true);
  });

  // Release C: the importer carries a Cmax reading with its dose context.
  // The document cannot name internal drug ids, so the reading is recorded
  // self-administered (the store writes the drug's own id); a synthesized
  // value has nowhere to go and is ignored with a warning.
  it('imports cmax source values with their dose context, and ignores a synthesized value', () => {
    const reading = {
      sourceId: 'S1',
      centralValue: 84,
      centralStatistic: 'arithmetic_mean',
      low: 70,
      high: 98,
      intervalKind: 'sd',
      unit: 'ng/mL',
      matrix: 'plasma',
      valueBasis: 'concentration',
      doseValue: 2,
      doseUnit: 'mg',
      doseRegimen: 'single',
      prandialState: 'fasted',
      administeredDrugId: 999,
    };
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'cmax', value: { min: 1, max: 2 }, sourceValues: [reading] },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [param] = res.data.parameters;
    expect(param!.parameter).toBe('cmax');
    expect(param!.value).toBeUndefined();
    const [sv] = param!.sourceValues;
    expect(sv).toMatchObject({
      centralValue: 84,
      centralStatistic: 'arithmetic_mean',
      doseValue: 2,
      doseUnit: 'mg',
      valueBasis: 'concentration',
      prandialState: 'fasted',
    });
    // A document-supplied drug id is never trusted.
    expect(sv!.administeredDrugId).toBeUndefined();
    expect(res.data.warnings.some((w) => w.includes('synthesized value is ignored'))).toBe(true);
  });

  it('drops an ill-formed cmax reading with the validator\'s reason', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'cmax',
            sourceValues: [
              { sourceId: 'S1', centralValue: 84, centralStatistic: 'arithmetic_mean', unit: 'ng/mL', matrix: 'plasma' },
            ],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('valueBasis is required'))).toBe(true);
  });

  it('skips a halfLife missing the required max bound', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'halfLife', value: { min: 1.2, unit: 'h' } },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('halfLife'))).toBe(true);
  });

  it('strips a stray unit from a dimensionless scalar (pKa)', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'pKa', value: { median: 8.6, unit: 'unitless' } },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(1);
    expect(res.data.parameters[0]!.value).toEqual({ median: 8.6 });
  });

  it('drops a sourceId that has no matching source with a warning', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'halfLife', value: { min: 1, max: 2, unit: 'h' }, sourceIds: ['S9'] },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters[0]!.sourceIds).toEqual([]);
    expect(res.data.warnings.some((w) => w.includes('S9'))).toBe(true);
  });

  it('keeps only the first of duplicate finalized entries', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          { parameter: 'tmax', value: { min: 0.5, max: 1, unit: 'h' } },
          { parameter: 'tmax', value: { min: 2, max: 3, unit: 'h' } },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters).toHaveLength(1);
    expect(res.data.parameters[0]!.value).toMatchObject({ min: 0.5, max: 1 });
  });
});

describe('citationFromSource', () => {
  it('prefers PMID over DOI and URL', () => {
    const r = citationFromSource(
      { pmid: '123', doi: '10.1/x', url: 'http://e.com', title: 'T', authors: ['A B'], journalOrSource: 'J', year: 2019 },
      0,
    );
    expect('source' in r).toBe(true);
    if ('source' in r) {
      expect(r.source.type).toBe('pmid');
      expect(r.source.identifier).toBe('123');
      expect(r.source.metadata).toMatchObject({ title: 'T', authors: ['A B'], journal: 'J', year: 2019 });
    }
  });

  it('normalizes a DOI to bare lowercase', () => {
    const r = citationFromSource({ doi: 'https://doi.org/10.1093/JAT/BKY007' }, 0);
    if ('source' in r) {
      expect(r.source.type).toBe('doi');
      expect(r.source.identifier).toBe('10.1093/jat/bky007');
    } else {
      throw new Error('expected a source');
    }
  });

  it('rejects non-http URL source identifiers', () => {
    const r = citationFromSource(
      { sourceId: 'S1', citationType: 'url', identifier: 'javascript:alert(1)' },
      0,
    );
    expect(r).toEqual({
      warning: 'Source S1: URL identifier must be an absolute http(s) URL; skipped.',
    });
  });

  it('rejects malformed PMID and DOI source identifiers', () => {
    expect(citationFromSource({ sourceId: 'S1', pmid: 'abc123' }, 0)).toEqual({
      warning: 'Source S1: PubMed ID must be a positive integer up to 8 digits; skipped.',
    });
    expect(citationFromSource({ sourceId: 'S2', doi: 'not-a-doi' }, 1)).toEqual({
      warning: 'Source S2: DOI must start with "10." and include a suffix; skipped.',
    });
  });

  it('drops invalid source identifiers before resolving parameter references', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceIds: ['S1'],
          },
        ],
        sources: [
          {
            sourceId: 'S1',
            citationType: 'url',
            identifier: 'file:///etc/passwd',
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sources).toEqual([]);
    expect(res.data.parameters[0]!.sourceIds).toEqual([]);
    expect(res.data.warnings).toContain(
      'Source S1: URL identifier must be an absolute http(s) URL; skipped.',
    );
    expect(
      res.data.warnings.some((warning) =>
        warning.includes('sourceId "S1" not found'),
      ),
    ).toBe(true);
  });

  it('warns when a source has no usable identifier', () => {
    const r = citationFromSource({ authors: ['x'] }, 4);
    expect('warning' in r).toBe(true);
  });

  it('assigns a default sourceId when absent', () => {
    const r = citationFromSource({ pmid: '99' }, 2);
    if ('source' in r) expect(r.source.sourceId).toBe('S3');
  });
});

describe('parseResearchOutput — ionization constants', () => {
  it('normalizes an amphoteric profile and keeps distinct transitions separate', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          {
            pKa: 9.2,
            protonatedCharge: 1,
            deprotonatedCharge: 0,
            evidenceType: 'experimental',
            sourceIds: ['S1'],
          },
          {
            pKa: 4.1,
            protonatedCharge: 0,
            deprotonatedCharge: -1,
            evidenceType: 'experimental',
            sourceIds: ['S1'],
          },
        ],
        sources: [{ sourceId: 'S1', pmid: '1' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(2);
    const basic = res.data.ionizationConstants.find(
      (c) => c.protonatedCharge === 1 && c.deprotonatedCharge === 0,
    )!;
    expect(basic.pKa).toBe(9.2);
    expect(basic.type).toBe('macroscopic');
    expect(basic.sourceIds).toEqual(['S1']);
  });

  it('infers the missing side of the charge pair', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [{ pKa: 8.4, protonatedCharge: 1, evidenceType: 'experimental' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants[0]!.deprotonatedCharge).toBe(0);
  });

  it('records an unstated evidenceType as predicted (never claims experimental)', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [{ pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0 }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants[0]!.evidenceType).toBe('predicted');
    expect(res.data.warnings.some((w) => w.includes('evidenceType'))).toBe(true);
  });

  it('skips a non-adjacent charge transition with a warning', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 2, deprotonatedCharge: 0, evidenceType: 'experimental' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('single-proton'))).toBe(true);
  });

  it('skips a pKa outside the physical band', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 99, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(0);
  });

  it('aggregates repeated readings of one measurement identity into a single row', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', sourceIds: ['S1'] },
          { pKa: 8.5, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', sourceIds: ['S2'] },
        ],
        sources: [
          { sourceId: 'S1', pmid: '1' },
          { sourceId: 'S2', pmid: '2' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // One row for the shared identity: the median value with both sources pooled,
    // not the first reading with the second dropped.
    expect(res.data.ionizationConstants).toHaveLength(1);
    expect(res.data.ionizationConstants[0]!.pKa).toBe(8.45);
    expect(res.data.ionizationConstants[0]!.sourceIds).toEqual(['S1', 'S2']);
  });

  it('keeps two experimental constants of one transition measured in different media', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', medium: 'water' },
          { pKa: 8.1, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', medium: 'methanol/water 1:1' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(2);
  });

  it('keeps two microscopic constants of one transition at different sites', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', type: 'microscopic', siteLabel: 'piperidine N' },
          { pKa: 8.1, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', type: 'microscopic', siteLabel: 'aniline N' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(2);
  });

  it('rounds pKa to the storage precision (3 decimals) so re-imports compare equal', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.1234, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants[0]!.pKa).toBe(8.123);
  });

  it('rounds temperature to the storage precision (2 decimals) for a stable identity', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', temperatureC: 25.125 },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants[0]!.temperatureC).toBe(25.13);
  });

  it('merges constants whose temperatures round to the same stored value', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', temperatureC: 25.13 },
          { pKa: 8.5, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', temperatureC: 25.125 },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(1);
    expect(res.data.ionizationConstants[0]!.pKa).toBe(8.45);
  });

  it('drops an out-of-range temperature but keeps the constant', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', temperatureC: 5000 },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(1);
    expect(res.data.ionizationConstants[0]!.temperatureC).toBeNull();
    expect(res.data.warnings.some((w) => w.includes('out of range'))).toBe(true);
  });

  it('skips a constant with an unrecognized explicit type instead of coercing to macroscopic', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', type: 'microsopic' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('unrecognized type'))).toBe(true);
  });

  it('combines distinct caveats when aggregating same-identity readings', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', note: 'free base' },
          { pKa: 8.6, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', note: 'ionic strength 0.1 M' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(1);
    expect(res.data.ionizationConstants[0]!.note).toBe('free base; ionic strength 0.1 M');
  });

  it('carries an imported note through normalization', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental', note: 'free base, 25°C' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants[0]!.note).toBe('free base, 25°C');
  });

  it('keeps experimental and predicted values of the same transition as separate rows', () => {
    const res = parseResearchOutput(
      baseDoc({
        ionizationConstants: [
          { pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' },
          { pKa: 8.7, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'predicted' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ionizationConstants).toHaveLength(2);
  });
});

describe('parseResearchOutput — PD targets & metabolism', () => {
  it('normalizes a PD target and drops empty measurement objects', () => {
    const res = parseResearchOutput(
      baseDoc({
        pharmacodynamicTargets: [
          {
            targetSymbol: 'SLC6A3',
            targetName: 'Dopamine transporter',
            interactionType: 'inhibitor',
            tier: 'primary',
            ki: { median: 0.64, unit: 'µM' },
            ic50: {},
            sourceIds: ['S1'],
          },
        ],
        sources: [{ sourceId: 'S1', pmid: '1' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const t = res.data.pharmacodynamicTargets[0]!;
    expect(t.symbol).toBe('SLC6A3');
    expect(t.tier).toBe('primary');
    expect(t.ki).toEqual({ median: 0.64, unit: 'µM' });
    expect(t.ic50).toBeNull();
    // Not stated by the agent → null, which means "unstated" rather than human.
    expect(t.assaySpecies).toBeNull();
  });

  // #1017: species is a property of the measurement, so it survives the parse
  // as its own field instead of being buried in evidenceNote prose.
  it('carries the assay species through, trimmed and length-capped', () => {
    const res = parseResearchOutput(
      baseDoc({
        pharmacodynamicTargets: [
          {
            targetSymbol: 'SLC6A3',
            targetName: 'Dopamine transporter',
            interactionType: 'inhibitor',
            assaySpecies: '  Rattus norvegicus  ',
            sourceIds: [],
          },
          {
            targetSymbol: 'HTR2A',
            targetName: '5-HT2A',
            interactionType: 'antagonist',
            assaySpecies: 'x'.repeat(200),
            sourceIds: [],
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.pharmacodynamicTargets[0]!.assaySpecies).toBe(
      'Rattus norvegicus',
    );
    expect(res.data.pharmacodynamicTargets[1]!.assaySpecies).toHaveLength(80);
  });

  it('normalizes metabolism routes, metabolites and enzyme interactions', () => {
    const res = parseResearchOutput(
      baseDoc({
        metabolism: {
          profileEvidenceNote: 'Hydrolysed by esterases.',
          eliminationRoutes: [
            { kind: 'enzyme', enzymeOrEntitySymbol: 'CES1', fraction: 0.4 },
            { kind: 'renal_unchanged', label: 'renal', fraction: 0.05 },
          ],
          metabolites: [
            { metaboliteName: 'Benzoylecgonine', activity: 'inactive', conversionFraction: 0.35 },
          ],
          enzymeInteractions: [{ enzymeOrEntitySymbol: 'CYP3A4', role: 'substrate', strength: 'moderate' }],
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.metabolism.eliminationRoutes).toHaveLength(2);
    expect(res.data.metabolism.eliminationRoutes[0]!).toMatchObject({ kind: 'enzyme', label: 'CES1', fraction: 0.4 });
    expect(res.data.metabolism.metabolites[0]!).toMatchObject({ name: 'Benzoylecgonine', activity: 'inactive' });
    expect(res.data.metabolism.enzymeInteractions[0]!).toMatchObject({ enzymeSymbol: 'CYP3A4', role: 'substrate', strength: 'moderate' });
  });

  it('rejects an out-of-range conversion fraction (kept null)', () => {
    const res = parseResearchOutput(
      baseDoc({
        metabolism: { metabolites: [{ metaboliteName: 'X', conversionFraction: 1.5 }] },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.metabolism.metabolites[0]!.conversionFraction).toBeNull();
  });

  it('skips an enzyme interaction with an invalid role', () => {
    const res = parseResearchOutput(
      baseDoc({
        metabolism: { enzymeInteractions: [{ enzymeOrEntitySymbol: 'CYP2D6', role: 'bogus' }] },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.metabolism.enzymeInteractions).toHaveLength(0);
    expect(res.data.warnings.some((w) => w.includes('CYP2D6'))).toBe(true);
  });
});

describe('normalizeParameterValue', () => {
  it('passes number kinds through unchanged', () => {
    expect(normalizeParameterValue('molecularWeight', 303.35)).toBe(303.35);
  });
  it('returns undefined for null', () => {
    expect(normalizeParameterValue('halfLife', null)).toBeUndefined();
  });
  it('keeps unit for a unit-bearing range', () => {
    expect(normalizeParameterValue('halfLife', { min: 1, max: 2, unit: 'h', extra: 9 })).toEqual({
      min: 1,
      max: 2,
      unit: 'h',
    });
  });
});

describe('parseResearchOutput — source values (kildeverdier)', () => {
  const withSourceValues = (sourceValues: unknown[], extra: Record<string, unknown> = {}) =>
    parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, median: 1.2, unit: 'h' },
            sourceIds: ['S1'],
            sourceValues,
            ...extra,
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          { sourceId: 'S2', citationType: 'pmid', pmid: '31150569' },
        ],
      }),
    );

  it('keeps one reading per source alongside the synthesized value', () => {
    const res = withSourceValues([
      { sourceId: 'S1', low: 0.7, high: 1.3, median: 1, unit: 'h', n: 12 },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h', comments: 'chronic users' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const param = res.data.parameters[0]!;
    expect(param.sourceValues).toEqual([
      { sourceId: 'S1', low: 0.7, high: 1.3, median: 1, unit: 'h', n: 12 },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h', comments: 'chronic users' },
    ]);
  });

  // The verbatim quote travels with the reading it belongs to, normalized by
  // the shared entry schema so an import and a hand-written entry record the
  // same sentence the same way. It is the one field that stays in the source's
  // own language rather than being written in Norwegian.
  it('carries a reading’s source quote through, normalized', () => {
    // halfLife is a requiresMinMax parameter, so a reading has to carry low and
    // high to survive validateEntryForParameter. Only the quote is under test.
    const res = withSourceValues([
      {
        sourceId: 'S1',
        low: 0.7,
        high: 1.3,
        median: 1,
        unit: 'h',
        quote: '  The mean terminal\n  half-life was 1.0 h.  ',
      },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h', quote: '   ' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [first, second] = res.data.parameters[0]!.sourceValues;
    expect(first!.quote).toBe('The mean terminal half-life was 1.0 h.');
    // Whitespace-only is a quote of nothing, so it normalizes to an explicit
    // null — the document stating there is none — rather than to `undefined`,
    // which is reserved for a document that never mentioned the field. The
    // importer preserves a stored quote on the second and clears it on the
    // first, so the two must not collapse.
    expect(second!.quote).toBeNull();
  });

  it('leaves an unmentioned quote absent rather than nulling it', () => {
    const res = withSourceValues([
      { sourceId: 'S1', low: 0.7, high: 1.3, median: 1, unit: 'h' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Absent, not null: this is what every document written before the field
    // existed looks like, and a re-import must not read it as "delete".
    expect(res.data.parameters[0]!.sourceValues[0]!.quote).toBeUndefined();
    expect('quote' in res.data.parameters[0]!.sourceValues[0]!).toBe(false);
  });

  // #1289: `observationContext` (dose, population, formulation, ...) follows
  // the same three-state rule as `quote`, for the same reason — it is new, so
  // a document silent about it must not be read as clearing what a re-import
  // target already stores.
  it('carries a reading’s observation context through, normalized', () => {
    const res = withSourceValues([
      {
        sourceId: 'S1',
        low: 0.7,
        high: 1.3,
        median: 1,
        unit: 'h',
        observationContext: '  Adult postoperative patients, single dose.  ',
      },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h', observationContext: '   ' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [first, second] = res.data.parameters[0]!.sourceValues;
    expect(first!.observationContext).toBe(
      'Adult postoperative patients, single dose.',
    );
    // Whitespace-only states there is no context, so it normalizes to an
    // explicit null rather than to `undefined` (reserved for a document that
    // never mentioned the field).
    expect(second!.observationContext).toBeNull();
  });

  it('leaves an unmentioned observation context absent rather than nulling it', () => {
    const res = withSourceValues([
      { sourceId: 'S1', low: 0.7, high: 1.3, median: 1, unit: 'h' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      res.data.parameters[0]!.sourceValues[0]!.observationContext,
    ).toBeUndefined();
    expect(
      'observationContext' in res.data.parameters[0]!.sourceValues[0]!,
    ).toBe(false);
  });

  it('drops a reading whose sourceId is not in sources[]', () => {
    const res = withSourceValues([{ sourceId: 'S9', median: 1, unit: 'h' }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters[0]!.sourceValues).toEqual([]);
    expect(res.data.warnings.some((w) => w.includes('"S9" not found'))).toBe(true);
  });

  it('applies the entry registry rules — a unit the parameter does not allow is dropped', () => {
    const res = withSourceValues([{ sourceId: 'S1', median: 1, unit: 'furlongs' }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters[0]!.sourceValues).toEqual([]);
    expect(res.data.warnings.some((w) => w.includes('furlongs'))).toBe(true);
  });

  it('rejects a median outside its own reported interval', () => {
    const res = withSourceValues([
      { sourceId: 'S1', low: 1, high: 2, median: 5, unit: 'h' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters[0]!.sourceValues).toEqual([]);
    expect(
      res.data.warnings.some((w) => w.includes('median must lie within')),
    ).toBe(true);
  });

  it('drops sourceValues on a parameter that is not entry-backed', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'molecularWeight',
            status: 'finalized',
            value: 303.35,
            sourceValues: [{ sourceId: 'S1', median: 303.35, unit: 'g/mol' }],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.parameters[0]!.sourceValues).toEqual([]);
    expect(
      res.data.warnings.some((w) => w.includes('not a source-entry-backed')),
    ).toBe(true);
  });

  it('accepts a parameter carrying only source values (no synthesized value)', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            sourceValues: [{ sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' }],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const param = res.data.parameters[0]!;
    expect(param.value).toBeUndefined();
    expect(param.sourceValues).toHaveLength(1);
  });

  it('keeps the source values when the synthesized value fails validation', () => {
    // halfLife requires min AND max; a lone median is rejected. The papers are
    // still good evidence, and the aggregate can be computed from them.
    const res = withSourceValues(
      [{ sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' }],
      { value: { median: 1.2, unit: 'h' } },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const param = res.data.parameters[0]!;
    expect(param.value).toBeUndefined();
    expect(param.sourceValues).toHaveLength(1);
    expect(
      res.data.warnings.some((w) => w.includes('kept 1 source value')),
    ).toBe(true);
  });
});

describe('parseResearchOutput — source-value coverage', () => {
  const coverageWarning = (res: ReturnType<typeof parseResearchOutput>) =>
    res.ok ? res.data.warnings.find((w) => w.startsWith('Source-value coverage:')) : undefined;

  const docWith = (sourceValues: unknown[], parameter = 'halfLife') =>
    parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter,
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceIds: ['S1'],
            sourceValues,
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          { sourceId: 'S2', citationType: 'pmid', pmid: '31150569' },
        ],
      }),
    );

  it('expects at least two independent sources per parameter', () => {
    expect(MIN_SOURCES_PER_PARAMETER).toBe(2);
  });

  it('says nothing when two sources back the parameter', () => {
    const res = docWith([
      { sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h' },
    ]);
    expect(coverageWarning(res)).toBeUndefined();
  });

  it('reports a parameter backed by a single source', () => {
    const res = docWith([{ sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' }]);
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('counts sources, not readings — two readings from one paper are one source', () => {
    const res = docWith([
      { sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h', comments: 'healthy adults' },
      { sourceId: 'S1', low: 1.8, high: 2.4, median: 2.1, unit: 'h', comments: 'hepatic impairment' },
    ]);
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('reports a finalized parameter that carries no readings at all', () => {
    const res = docWith([]);
    expect(coverageWarning(res)).toContain('halfLife (0)');
  });

  it('counts papers, not sourceIds — two ids for one paper are one source', () => {
    // S1 and S2 are the same article declared twice, under its PMID and under
    // its DOI. `resolveCitation` files them in one citations row, so the
    // parameter really is single-sourced and must still be reported.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' },
              { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364', doi: '10.1093/jat/bky007' },
          { sourceId: 'S2', citationType: 'doi', doi: '10.1093/JAT/BKY007' },
        ],
      }),
    );
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('folds two handles into one paper transitively', () => {
    // S1 knows only the PMID and S2 only the DOI; S3 declares both, which is
    // what links them — the same fold `resolveCitation` performs at write time.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
              { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h' },
              { sourceId: 'S3', low: 1.0, high: 1.4, median: 1.2, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          { sourceId: 'S2', citationType: 'doi', doi: '10.1093/jat/bky007' },
          { sourceId: 'S3', citationType: 'pmid', pmid: '29462364', doi: '10.1093/jat/bky007' },
        ],
      }),
    );
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('unwraps a resolver URL before comparing handles', () => {
    // S2 is the DOI of S1 wearing a doi.org URL. Nothing has unwrapped it at
    // parse time — the crosswalk does that later, and the preview never gets
    // there — so the fold has to.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
              { sourceId: 'S2', low: 1.2, high: 1.6, median: 1.4, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'doi', doi: '10.1093/jat/bky007' },
          { sourceId: 'S2', citationType: 'url', url: 'https://doi.org/10.1093/JAT/BKY007' },
        ],
      }),
    );
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('unwraps a PubMed article URL to its PMID', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
              { sourceId: 'S2', low: 1.2, high: 1.6, median: 1.4, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          {
            sourceId: 'S2',
            citationType: 'url',
            url: 'https://pubmed.ncbi.nlm.nih.gov/29462364/',
          },
        ],
      }),
    );
    expect(coverageWarning(res)).toContain('halfLife (1)');
  });

  it('leaves a URL that wraps nothing as its own paper', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
              { sourceId: 'S2', low: 1.2, high: 1.6, median: 1.4, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          { sourceId: 'S2', citationType: 'url', url: 'https://example.org/label.pdf' },
        ],
      }),
    );
    expect(coverageWarning(res)).toBeUndefined();
  });

  it('keeps genuinely different papers apart', () => {
    const res = docWith([
      { sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' },
      { sourceId: 'S2', low: 1.3, high: 1.9, median: 1.6, unit: 'h' },
    ]);
    expect(coverageWarning(res)).toBeUndefined();
  });

  it('exempts parameters that are not entry-backed', () => {
    // analyteStability is matrix-specific and deliberately unpooled — it takes
    // no source values, so it cannot be thinly sourced.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'analyteStability',
            status: 'finalized',
            value: { median: 48, unit: 'h' },
            sourceIds: ['S1'],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(coverageWarning(res)).toBeUndefined();
  });

  it('lists every thin parameter in one warning rather than one warning each', () => {
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [{ sourceId: 'S1', low: 0.7, high: 1.3, unit: 'h' }],
          },
          {
            parameter: 'tmax',
            status: 'finalized',
            value: { median: 1, unit: 'h' },
            sourceValues: [{ sourceId: 'S1', median: 1, unit: 'h' }],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const coverage = res.data.warnings.filter((w) => w.startsWith('Source-value coverage:'));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toContain('halfLife (1)');
    expect(coverage[0]).toContain('tmax (1)');
  });

  it('recounts against a resolved crosswalk and replaces the parse-time line', () => {
    // Neither source names the other's handle, so parsing alone sees two
    // papers. NCBI's converter says they are one article — the write paths hold
    // that answer before runImport, so what they report is the real count.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [
              { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
              { sourceId: 'S2', low: 1.2, high: 1.6, median: 1.4, unit: 'h' },
            ],
          },
        ],
        sources: [
          { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
          { sourceId: 'S2', citationType: 'doi', doi: '10.1093/jat/bky007' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(coverageWarning(res)).toBeUndefined();

    const recounted = recountSourceValueCoverage(
      res.data,
      new Map([['S1', { pmid: '29462364', doi: '10.1093/jat/bky007' }]]),
    );
    const coverage = recounted.filter((w) => w.startsWith(SOURCE_VALUE_COVERAGE_PREFIX));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toContain('halfLife (1)');
  });

  it('drops the parse-time line when the crosswalk clears the shortfall', () => {
    // The reverse case cannot happen through folding — a crosswalk only ever
    // merges papers — but the recount must not leave a stale line behind when
    // the parameters it named are gone.
    const res = parseResearchOutput(
      baseDoc({
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [{ sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' }],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(coverageWarning(res)).toContain('halfLife (1)');

    const stripped = { ...res.data, parameters: [] };
    expect(
      recountSourceValueCoverage(stripped, new Map()).filter((w) =>
        w.startsWith(SOURCE_VALUE_COVERAGE_PREFIX),
      ),
    ).toEqual([]);
  });

  it('leaves every other warning untouched when recounting', () => {
    const res = parseResearchOutput(
      baseDoc({
        schemaVersion: 'something-else',
        kinetixParameterValues: [
          {
            parameter: 'halfLife',
            status: 'finalized',
            value: { min: 0.7, max: 1.7, unit: 'h' },
            sourceValues: [{ sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' }],
          },
        ],
        sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recounted = recountSourceValueCoverage(res.data, new Map());
    expect(recounted.some((w) => w.includes('schemaVersion'))).toBe(true);
    expect(recounted.filter((w) => w.startsWith(SOURCE_VALUE_COVERAGE_PREFIX))).toHaveLength(1);
  });

  it('thinlySourcedParameters reports the distinct-paper count per parameter', () => {
    expect(
      thinlySourcedParameters([
        {
          parameter: 'halfLife',
          sourceIds: ['S1', 'S2'],
          sourceValues: [
            { sourceId: 'S1', unit: 'h', median: 1 },
            { sourceId: 'S2', unit: 'h', median: 2 },
          ],
        },
        { parameter: 'tmax', sourceIds: [], sourceValues: [{ sourceId: 'S1', unit: 'h', median: 1 }] },
      ]),
    ).toEqual([{ parameter: 'tmax', sources: 1 }]);
  });
});
