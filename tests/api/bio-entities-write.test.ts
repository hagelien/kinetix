import { describe, it, expect } from 'vitest';
import {
  bioEntityCreateSchema,
  bioEntityUpdateSchema,
  bioEntityCreateRequestSchema,
  bioEntityUpdateRequestSchema,
  bioEntityEditSchema,
} from '../../api/_lib/schemas';

describe('bioEntityCreateSchema', () => {
  it('accepts a full entity with functions, rank and external ids', () => {
    const parsed = bioEntityCreateSchema.parse({
      symbol: 'CYP3A4',
      name: 'Cytokrom P450 3A4',
      nameEn: 'Cytochrome P450 3A4',
      organism: 'Homo sapiens',
      rank: 'gene',
      parentId: 12,
      entityClass: 'CYP',
      externalIds: { uniprot: 'P08684', ec: '1.14.14.1' },
      functions: ['metabolic_enzyme', 'drug_target'],
    });
    expect(parsed.symbol).toBe('CYP3A4');
    expect(parsed.functions).toEqual(['metabolic_enzyme', 'drug_target']);
  });

  it('requires a non-empty symbol and name', () => {
    expect(() => bioEntityCreateSchema.parse({ symbol: '', name: 'x' })).toThrow();
    expect(() => bioEntityCreateSchema.parse({ symbol: 'x', name: '' })).toThrow();
    expect(() => bioEntityCreateSchema.parse({ symbol: 'x' })).toThrow();
  });

  it('rejects unknown function and rank values', () => {
    expect(() =>
      bioEntityCreateSchema.parse({
        symbol: 'X',
        name: 'X',
        functions: ['enzyme'],
      }),
    ).toThrow();
    expect(() =>
      bioEntityCreateSchema.parse({ symbol: 'X', name: 'X', rank: 'kingdom' }),
    ).toThrow();
  });

  it('trims and allows omitting optional fields', () => {
    const parsed = bioEntityCreateSchema.parse({
      symbol: '  ADH  ',
      name: '  Alcohol dehydrogenase  ',
    });
    expect(parsed.symbol).toBe('ADH');
    expect(parsed.name).toBe('Alcohol dehydrogenase');
    expect(parsed.functions).toBeUndefined();
  });
});

describe('bioEntityUpdateSchema', () => {
  it('accepts a partial patch', () => {
    expect(bioEntityUpdateSchema.parse({ entityClass: 'GPCR' })).toEqual({
      entityClass: 'GPCR',
    });
    expect(
      bioEntityUpdateSchema.parse({ functions: ['drug_target'] }).functions,
    ).toEqual(['drug_target']);
  });

  it('rejects an empty patch', () => {
    expect(() => bioEntityUpdateSchema.parse({})).toThrow();
  });
});

describe('bio-entity write requests (review flow)', () => {
  it('create request accepts entity fields plus review extras', () => {
    const parsed = bioEntityCreateRequestSchema.parse({
      symbol: 'MAOA',
      name: 'Monoaminoksidase A',
      editSummary: 'add MAO-A',
      submitForReview: true,
    });
    expect(parsed.symbol).toBe('MAOA');
    expect(parsed.editSummary).toBe('add MAO-A');
    expect(parsed.submitForReview).toBe(true);
  });

  it('update request requires at least one entity field, not just extras', () => {
    expect(() =>
      bioEntityUpdateRequestSchema.parse({ editSummary: 'note only' }),
    ).toThrow();
    const ok = bioEntityUpdateRequestSchema.parse({
      entityClass: 'GPCR',
      editSummary: 'reclassify',
    });
    expect(ok.entityClass).toBe('GPCR');
  });
});

describe('bioEntityEditSchema (queued payload)', () => {
  it('accepts a create op carrying a full entity', () => {
    const parsed = bioEntityEditSchema.parse({
      op: 'create',
      entity: { symbol: 'SERT', name: 'Serotonintransportør' },
    });
    expect(parsed.op).toBe('create');
  });

  it('accepts an update op carrying a partial patch', () => {
    const parsed = bioEntityEditSchema.parse({
      op: 'update',
      patch: { functions: ['drug_target'] },
    });
    expect(parsed.op).toBe('update');
  });

  it('rejects an unknown op and a create without an entity', () => {
    expect(() =>
      bioEntityEditSchema.parse({ op: 'delete', entity: {} }),
    ).toThrow();
    expect(() => bioEntityEditSchema.parse({ op: 'create' })).toThrow();
  });
});
