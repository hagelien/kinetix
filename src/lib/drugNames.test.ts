import { describe, it, expect } from 'vitest';
import {
  buildDrugSearchSubtitle,
  capitalizeGenericDrugName,
  collectDrugAkaTerms,
  formatGenericDrugName,
} from './drugNames';

describe('collectDrugAkaTerms', () => {
  it('returns the shortname and aliases, trimmed and de-duplicated', () => {
    expect(
      collectDrugAkaTerms(
        { nameShort: ' THC ', aliases: ['Cannabis', 'weed', 'weed', 'Cannabis'] },
        'Tetrahydrocannabinol',
      ),
    ).toEqual({ shortName: 'THC', aliases: ['Cannabis', 'weed'] });
  });

  it('drops terms equal to the primary name (case-insensitive)', () => {
    expect(
      collectDrugAkaTerms(
        { nameShort: 'morfin', aliases: ['Morfin', 'MS Contin'] },
        'Morfin',
      ),
    ).toEqual({ shortName: null, aliases: ['MS Contin'] });
  });

  it('handles a drug with no shortname or aliases', () => {
    expect(collectDrugAkaTerms({}, 'Etanol')).toEqual({
      shortName: null,
      aliases: [],
    });
    expect(
      collectDrugAkaTerms({ nameShort: null, aliases: null }, 'Etanol'),
    ).toEqual({ shortName: null, aliases: [] });
  });

  it('keeps brand/street alias capitalisation verbatim', () => {
    expect(
      collectDrugAkaTerms(
        { nameShort: null, aliases: ['Ritalin', 'Concerta'] },
        'Metylfenidat',
      ),
    ).toEqual({ shortName: null, aliases: ['Ritalin', 'Concerta'] });
  });
});

describe('formatGenericDrugName', () => {
  it('lower-cases the leading letter of plain generic names', () => {
    expect(formatGenericDrugName('Diazepam')).toBe('diazepam');
    expect(formatGenericDrugName('Morfin')).toBe('morfin');
    expect(formatGenericDrugName('Baklofen')).toBe('baklofen');
    expect(formatGenericDrugName('Fenobarbital')).toBe('fenobarbital');
    expect(formatGenericDrugName('Benzoylecgonin')).toBe('benzoylecgonin');
    expect(formatGenericDrugName('Etanol')).toBe('etanol');
    expect(formatGenericDrugName('Buprenorfin')).toBe('buprenorfin');
  });

  it('leaves already lower-case names unchanged', () => {
    expect(formatGenericDrugName('buprenorfin')).toBe('buprenorfin');
    expect(formatGenericDrugName('venlafaxine')).toBe('venlafaxine');
  });

  it('preserves all-caps acronyms and initialisms', () => {
    expect(formatGenericDrugName('BHB')).toBe('BHB');
    expect(formatGenericDrugName('THC')).toBe('THC');
    expect(formatGenericDrugName('LSD')).toBe('LSD');
    expect(formatGenericDrugName('MDMA')).toBe('MDMA');
    expect(formatGenericDrugName('PMMA')).toBe('PMMA');
    expect(formatGenericDrugName('EDDP')).toBe('EDDP');
    expect(formatGenericDrugName('MDMA (ecstasy)')).toBe('MDMA (ecstasy)');
  });

  it('preserves stereochemistry / locant prefixes', () => {
    expect(formatGenericDrugName('N-desmetyldiazepam')).toBe(
      'N-desmetyldiazepam',
    );
    expect(formatGenericDrugName('O-desmetyltramadol')).toBe(
      'O-desmetyltramadol',
    );
    expect(formatGenericDrugName('L-DOPA')).toBe('L-DOPA');
  });

  it('leaves digit/locant-leading names unchanged', () => {
    expect(formatGenericDrugName('3-klormetkatinon')).toBe('3-klormetkatinon');
    expect(formatGenericDrugName('6-monoacetylmorfin')).toBe(
      '6-monoacetylmorfin',
    );
    expect(formatGenericDrugName('7-aminoflunitrazepam')).toBe(
      '7-aminoflunitrazepam',
    );
    expect(formatGenericDrugName('10-OH-karbazepin (MHD)')).toBe(
      '10-OH-karbazepin (MHD)',
    );
  });

  it('handles empty and single-character input safely', () => {
    expect(formatGenericDrugName('')).toBe('');
    expect(formatGenericDrugName('X')).toBe('X');
  });
});

describe('capitalizeGenericDrugName', () => {
  it('capitalises the leading letter of plain generic names', () => {
    expect(capitalizeGenericDrugName('diazepam')).toBe('Diazepam');
    expect(capitalizeGenericDrugName('morfin')).toBe('Morfin');
    expect(capitalizeGenericDrugName('buprenorfin')).toBe('Buprenorfin');
    expect(capitalizeGenericDrugName('venlafaxine')).toBe('Venlafaxine');
    expect(capitalizeGenericDrugName('benzoylecgonin')).toBe('Benzoylecgonin');
  });

  it('leaves already-capitalised names unchanged', () => {
    expect(capitalizeGenericDrugName('Diazepam')).toBe('Diazepam');
    expect(capitalizeGenericDrugName('Morfin')).toBe('Morfin');
    expect(capitalizeGenericDrugName('Etanol')).toBe('Etanol');
  });

  it('preserves all-caps acronyms and mixed-case shorthands', () => {
    expect(capitalizeGenericDrugName('THC')).toBe('THC');
    expect(capitalizeGenericDrugName('LSD')).toBe('LSD');
    expect(capitalizeGenericDrugName('MDMA')).toBe('MDMA');
    expect(capitalizeGenericDrugName('PMMA')).toBe('PMMA');
    expect(capitalizeGenericDrugName('BHB')).toBe('BHB');
    expect(capitalizeGenericDrugName('mCPP')).toBe('mCPP');
  });

  it('preserves stereochemistry / locant prefixes', () => {
    expect(capitalizeGenericDrugName('N-desmetyldiazepam')).toBe(
      'N-desmetyldiazepam',
    );
    expect(capitalizeGenericDrugName('O-desmetyltramadol')).toBe(
      'O-desmetyltramadol',
    );
    expect(capitalizeGenericDrugName('L-DOPA')).toBe('L-DOPA');
    expect(
      capitalizeGenericDrugName('para-Methoxymethamphetamine (PMMA)'),
    ).toBe('para-Methoxymethamphetamine (PMMA)');
    expect(capitalizeGenericDrugName('gamma-hydroksismørsyre')).toBe(
      'gamma-hydroksismørsyre',
    );
    expect(capitalizeGenericDrugName('p-fluorfentanyl')).toBe(
      'p-fluorfentanyl',
    );
  });

  it('leaves digit/locant-leading names unchanged', () => {
    expect(capitalizeGenericDrugName('3-klormetkatinon')).toBe(
      '3-klormetkatinon',
    );
    expect(capitalizeGenericDrugName('6-monoacetylmorfin')).toBe(
      '6-monoacetylmorfin',
    );
    expect(capitalizeGenericDrugName('10-OH-karbazepin (MHD)')).toBe(
      '10-OH-karbazepin (MHD)',
    );
  });

  it('handles empty and single-character input safely', () => {
    expect(capitalizeGenericDrugName('')).toBe('');
    expect(capitalizeGenericDrugName('x')).toBe('x');
    expect(capitalizeGenericDrugName('X')).toBe('X');
  });
});

describe('buildDrugSearchSubtitle', () => {
  it('leads with the alternate (English) name, then short name and aliases', () => {
    expect(
      buildDrugSearchSubtitle(
        { nb: 'Valproinsyre', en: 'Valproic acid' },
        'Valproinsyre',
        'VPA',
        ['Divalproex', 'Depakote'],
      ),
    ).toBe('valproic acid · VPA · Divalproex · Depakote');
  });

  it('floats the term matching the query to the front of the extras', () => {
    // The visible names don't contain "2-ene"; the alias does, so it must
    // stay visible (first among the extras) even when the line truncates.
    expect(
      buildDrugSearchSubtitle(
        { nb: '2-propyl-2-pentensyre', en: '2-Propyl-2-pentenoic acid' },
        '2-propyl-2-pentensyre',
        null,
        ['valproinsyre', '2-propyl-2-pentenoic acid 2-ene', 'depakote'],
        '2-ene',
      ),
    ).toBe(
      '2-Propyl-2-pentenoic acid · 2-propyl-2-pentenoic acid 2-ene · valproinsyre · depakote',
    );
  });

  it('drops the primary name and case-insensitive duplicates', () => {
    expect(
      buildDrugSearchSubtitle(
        { nb: 'Morfin', en: 'Morphine' },
        'Morfin',
        'morfin',
        ['Morphine', 'MS Contin'],
      ),
    ).toBe('morphine · MS Contin');
  });

  it('returns an empty string when there is nothing secondary to show', () => {
    expect(
      buildDrugSearchSubtitle({ nb: 'Etanol' }, 'Etanol', null, null),
    ).toBe('');
  });

  it('keeps brand/street alias capitalisation but lower-cases the generic alt name', () => {
    expect(
      buildDrugSearchSubtitle(
        { nb: 'Metylfenidat', en: 'Methylphenidate' },
        'Metylfenidat',
        null,
        ['Ritalin', 'Concerta'],
      ),
    ).toBe('methylphenidate · Ritalin · Concerta');
  });
});
