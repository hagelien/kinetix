import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORGANISM,
  normalizeBioEntityKey,
  normalizeOrganismKey,
  findMatchingEntity,
  mergeExternalIds,
  uniprotKey,
  deriveCypLineage,
  cypLineageRank,
  type BioEntityMatchCandidate,
} from './bioEntities';

describe('normalizeBioEntityKey', () => {
  it('collapses cosmetic spelling differences to one key', () => {
    expect(normalizeBioEntityKey('MAO-A')).toBe('MAOA');
    expect(normalizeBioEntityKey('MAOA')).toBe('MAOA');
    expect(normalizeBioEntityKey('mao a')).toBe('MAOA');
    expect(normalizeBioEntityKey(' MAO_A ')).toBe('MAOA');
  });

  it('keeps genuinely distinct isoforms apart', () => {
    expect(normalizeBioEntityKey('CYP3A4')).not.toBe(
      normalizeBioEntityKey('CYP3A5'),
    );
    expect(normalizeBioEntityKey('CYP2D6')).not.toBe(
      normalizeBioEntityKey('CYP2C9'),
    );
  });
});

describe('findMatchingEntity (dedup decision)', () => {
  // Stand-ins for the seeded enzymes that are ALSO drug targets. When a curator
  // (or the backfill) brings these in from the receptor-target side, they must
  // fold into the existing enzyme entity rather than fork a duplicate.
  const enzymes: BioEntityMatchCandidate[] = [
    { id: 1, symbol: 'AChE', externalIds: {} },
    { id: 2, symbol: 'BChE', externalIds: {} },
    { id: 3, symbol: 'MAO-A', externalIds: {} },
    { id: 4, symbol: 'MAO-B', externalIds: {} },
    { id: 5, symbol: 'XO', externalIds: {} },
    { id: 6, symbol: 'DPYD', externalIds: { uniprot: 'Q12882' } },
    { id: 7, symbol: 'CYP3A4', externalIds: {} },
  ];

  it.each([
    ['Acetylcholinesterase target spelled AChE', 'AChE', 1],
    ['MAO-A target spelled MAOA', 'MAOA', 3],
    ['MAO-B target spelled mao-b', 'mao-b', 4],
    ['BChE target', 'BCHE', 2],
    ['Xanthine oxidase target', 'XO', 5],
  ])('%s collapses onto the enzyme entity', (_label, symbol, expectedId) => {
    expect(findMatchingEntity({ symbol }, enzymes)).toBe(expectedId);
  });

  it('matches by shared UniProt id when symbols differ cosmetically', () => {
    expect(
      findMatchingEntity(
        { symbol: 'DPD', externalIds: { uniprot: 'Q12882' } },
        enzymes,
      ),
    ).toBe(6);
  });

  it('returns null for a genuinely new target (no duplicate)', () => {
    expect(findMatchingEntity({ symbol: 'SERT' }, enzymes)).toBeNull();
    expect(findMatchingEntity({ symbol: 'CYP3A5' }, enzymes)).toBeNull();
  });

  // #1017: the catalog can hold a human and a rat SLC6A3 as separate rows
  // (`symbol` is indexed, not unique — `slug` is the unique key), and the
  // matcher used to bind whichever one it found first. A mislabelled bind is
  // not contained to the drug being imported: every other drug pointing at the
  // entity inherits it.
  describe('organism scope', () => {
    const transporters: BioEntityMatchCandidate[] = [
      { id: 10, symbol: 'SLC6A3', organism: 'Homo sapiens', externalIds: {} },
      {
        id: 11,
        symbol: 'SLC6A3',
        organism: 'Rattus norvegicus',
        externalIds: {},
      },
    ];

    it('binds each species to its own row', () => {
      expect(findMatchingEntity({ symbol: 'SLC6A3' }, transporters)).toBe(10);
      expect(
        findMatchingEntity(
          { symbol: 'SLC6A3', organism: 'Rattus norvegicus' },
          transporters,
        ),
      ).toBe(11);
    });

    it('treats an absent organism on either side as Homo sapiens', () => {
      expect(
        findMatchingEntity({ symbol: 'SLC6A3', organism: null }, [
          { id: 20, symbol: 'SLC6A3', externalIds: {} },
        ]),
      ).toBe(20);
      expect(
        findMatchingEntity({ symbol: 'SLC6A3', organism: '  homo  sapiens ' }, [
          { id: 21, symbol: 'SLC6A3', organism: 'Homo sapiens' },
        ]),
      ).toBe(21);
    });

    it('does not fall back across species on a shared UniProt id', () => {
      expect(
        findMatchingEntity(
          {
            symbol: 'DAT',
            organism: 'Rattus norvegicus',
            externalIds: { uniprot: 'Q01959' },
          },
          [
            {
              id: 30,
              symbol: 'SLC6A3',
              organism: 'Homo sapiens',
              externalIds: { uniprot: 'Q01959' },
            },
          ],
        ),
      ).toBeNull();
    });
  });
});

describe('normalizeOrganismKey', () => {
  it('is case-, whitespace- and default-insensitive', () => {
    expect(normalizeOrganismKey('  Rattus   norvegicus ')).toBe(
      'rattus norvegicus',
    );
    expect(normalizeOrganismKey(null)).toBe('homo sapiens');
    expect(normalizeOrganismKey('   ')).toBe('homo sapiens');
    expect(normalizeOrganismKey(DEFAULT_ORGANISM)).toBe('homo sapiens');
  });
});

describe('mergeExternalIds', () => {
  it('keeps the existing entity values and adds only missing ids', () => {
    expect(
      mergeExternalIds(
        { uniprot: 'P22303', chembl: 'CHEMBL220' },
        { uniprot: 'WRONG', hgnc: '108' },
      ),
    ).toEqual({ uniprot: 'P22303', chembl: 'CHEMBL220', hgnc: '108' });
  });

  it('tolerates null/undefined on either side', () => {
    expect(mergeExternalIds(null, { ec: '3.1.1.7' })).toEqual({
      ec: '3.1.1.7',
    });
    expect(mergeExternalIds({ ec: '3.1.1.7' }, null)).toEqual({
      ec: '3.1.1.7',
    });
    expect(mergeExternalIds(null, null)).toEqual({});
  });
});

describe('deriveCypLineage', () => {
  it('builds the root-first ancestor chain for a CYP gene', () => {
    expect(deriveCypLineage('CYP3A4')).toEqual(['CYP', 'CYP3', 'CYP3A']);
    expect(deriveCypLineage('CYP2D6')).toEqual(['CYP', 'CYP2', 'CYP2D']);
    expect(deriveCypLineage('cyp1a2')).toEqual(['CYP', 'CYP1', 'CYP1A']);
  });

  it('returns nothing for non-CYP-gene symbols', () => {
    expect(deriveCypLineage('ADH')).toEqual([]);
    expect(deriveCypLineage('SERT')).toEqual([]);
    expect(deriveCypLineage('CYP3A')).toEqual([]); // a subfamily, not a gene
    expect(deriveCypLineage('CYP3')).toEqual([]); // a family, not a gene
    expect(deriveCypLineage('UGT1A1')).toEqual([]);
  });

  it('assigns the right rank to each lineage symbol', () => {
    expect(cypLineageRank('CYP')).toBe('superfamily');
    expect(cypLineageRank('CYP3')).toBe('family');
    expect(cypLineageRank('CYP3A')).toBe('subfamily');
  });
});

describe('uniprotKey', () => {
  it('lower-cases and trims, or returns null', () => {
    expect(uniprotKey({ uniprot: ' P22303 ' })).toBe('p22303');
    expect(uniprotKey({})).toBeNull();
    expect(uniprotKey(null)).toBeNull();
    expect(uniprotKey({ uniprot: 123 as unknown as string })).toBeNull();
  });
});
