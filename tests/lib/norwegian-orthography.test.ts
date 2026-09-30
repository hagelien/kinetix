import { describe, expect, it } from 'vitest';
import {
  inspectNorwegianOrthography,
  repairStrongTransliterations,
} from '../../src/lib/norwegianOrthography';

/**
 * The sentence that started this: a real verification note written by a
 * maintenance agent, Norwegian throughout, with every æ/ø/å folded away.
 */
const TRANSLITERATED =
  'Konkordans=svak og en aerlig karakteristikk siden det er en videreformidlet, ikke ny malt, verdi fra den forste studien.';

const PROPER =
  'Konkordans=svak og en ærlig karakteristikk siden det er en videreformidlet, ikke ny målt, verdi fra den første studien.';

describe('inspectNorwegianOrthography', () => {
  it('flags Norwegian prose whose æ/ø/å were folded to ASCII', () => {
    const report = inspectNorwegianOrthography(TRANSLITERATED);
    expect(report.looksNorwegian).toBe(true);
    expect(report.hasNorwegianLetters).toBe(false);
    expect(report.transliterated).toBe(true);
    expect(report.hits.map((h) => h.word)).toContain('aerlig');
    expect(report.hits.map((h) => h.word)).toContain('forste');
  });

  it('separates certain folds from ones that are also real words', () => {
    const report = inspectNorwegianOrthography(TRANSLITERATED);
    const byWord = new Map(report.hits.map((h) => [h.word, h]));
    expect(byWord.get('aerlig')?.confidence).toBe('strong');
    // "malt" is a word in its own right, so it is a lead, not a correction.
    expect(byWord.get('malt')?.confidence).toBe('likely');
  });

  it('leaves correctly spelled Norwegian alone', () => {
    const report = inspectNorwegianOrthography(PROPER);
    expect(report.hasNorwegianLetters).toBe(true);
    expect(report.transliterated).toBe(false);
  });

  it('does not call an English sentence transliterated', () => {
    const report = inspectNorwegianOrthography(
      'The median was 2.86 and the assay was validated against a certified reference material.',
    );
    expect(report.looksNorwegian).toBe(false);
    expect(report.transliterated).toBe(false);
  });

  it('reports an ambiguous fold with both readings', () => {
    const report = inspectNorwegianOrthography(
      'Verdien er ikke arlig kontrollert av en uavhengig kilde, og den er heller ikke dokumentert.',
    );
    const hit = report.hits.find((h) => h.word === 'arlig');
    expect(hit?.suggestions).toEqual(['ærlig', 'årlig']);
  });
});

describe('repairStrongTransliterations', () => {
  it('restores the spellings that cannot be anything else', () => {
    const fixed = repairStrongTransliterations(TRANSLITERATED);
    expect(fixed).toContain('ærlig');
    expect(fixed).toContain('første');
  });

  it('never touches an ambiguous or dictionary-word fold', () => {
    const fixed = repairStrongTransliterations(TRANSLITERATED);
    // "malt" could be the grain; "arlig" could be yearly or honest.
    expect(fixed).toContain('ikke ny malt, verdi');
    expect(repairStrongTransliterations('arlig')).toBe('arlig');
  });

  it('repairs inflections through the fragment rules', () => {
    const text =
      'Forslaget bygger paa en primaerkilde, men paastanden er ikke maalt i denne studien og kan ikke etterproves her.';
    const fixed = repairStrongTransliterations(text);
    expect(fixed).toContain('på en primærkilde');
    expect(fixed).toContain('påstanden');
    expect(fixed).toContain('målt');
  });

  it('leaves a word alone when only an ambiguous reading exists', () => {
    // "malt" without the digraph could be the grain; "bade" could be bathing.
    expect(repairStrongTransliterations('ny malt verdi')).toBe('ny malt verdi');
    expect(repairStrongTransliterations('bade i blod og urin')).toBe(
      'bade i blod og urin',
    );
  });

  it('keeps a capitalised word capitalised', () => {
    expect(repairStrongTransliterations('Ogsaa i fullblod')).toBe(
      'Også i fullblod',
    );
  });

  it('returns the text unchanged when there is nothing to repair', () => {
    expect(repairStrongTransliterations(PROPER)).toBe(PROPER);
  });
});
