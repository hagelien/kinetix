/**
 * Name matching for the Farmakologiportalen link backfill.
 *
 * The rule worth pinning is the refusal: `drugs.names` has no cross-drug
 * uniqueness, so a spelling two drugs answer to must resolve to neither. A
 * first-writer-wins index would silently hand it to whichever row the catalog
 * query returned first and put the link on the wrong monograph — a failure
 * that looks like a working link.
 */
import { describe, it, expect } from 'vitest';
import {
  AMBIGUOUS,
  buildNameIndex,
  matchSubstanceTitle,
  type IndexableDrug,
} from '../scripts/farmakologiportalen/match';

function drug(
  id: number,
  names: Record<string, string>,
  aliases: string[] = [],
): IndexableDrug {
  return { id, names, aliases };
}

describe('buildNameIndex', () => {
  it('indexes every localized name and alias', () => {
    const index = buildNameIndex([
      drug(1, { nb: 'Alimemazin', en: 'Alimemazine' }, ['Trimeprazine']),
    ]);
    expect(index.get('alimemazin')).toBe(1);
    expect(index.get('alimemazine')).toBe(1);
    expect(index.get('trimeprazine')).toBe(1);
  });

  it('marks a spelling two different drugs answer to', () => {
    // One string as drug A's Norwegian name and drug B's English name — the
    // exact collision `drugs.names` permits.
    const index = buildNameIndex([
      drug(1, { nb: 'Kodein' }),
      drug(2, { nb: 'Kodein-6-glukuronid', en: 'Kodein' }),
    ]);
    expect(index.get('kodein')).toBe(AMBIGUOUS);
    expect(index.get('kodein-6-glukuronid')).toBe(2);
  });

  it('does not treat one drug reaching a key twice as a collision', () => {
    const index = buildNameIndex([drug(7, { nb: 'Morfin', en: 'Morfin' }, ['morfin'])]);
    expect(index.get('morfin')).toBe(7);
  });

  it('ignores names that normalize to nothing', () => {
    const index = buildNameIndex([drug(1, { nb: '   ' }, ['']), drug(2, { nb: 'Diazepam' })]);
    expect(index.get('diazepam')).toBe(2);
    expect([...index.keys()]).toEqual(['diazepam']);
  });
});

describe('matchSubstanceTitle', () => {
  const index = buildNameIndex([
    drug(1, { nb: 'Morfin-3-glukuronid' }, ['M3G']),
    drug(2, { nb: 'Kodein' }),
    drug(3, { nb: 'Kodein-6-glukuronid', en: 'Kodein' }, ['K6G']),
  ]);

  it('matches on the base name, dropping the portal parenthetical', () => {
    expect(matchSubstanceTitle(index, 'Morfin-3-glukuronid (M3G)')).toEqual({
      drugId: 1,
      ambiguous: false,
    });
  });

  it('falls back to the parenthetical alias', () => {
    expect(matchSubstanceTitle(index, 'Ukjent substans (M3G)').drugId).toBe(1);
  });

  it('refuses a title whose only candidate two drugs share', () => {
    // 'Kodein' is drug 2's name and drug 3's English name. Linking either one
    // would be a coin flip, so the substance is left unlinked and reported.
    expect(matchSubstanceTitle(index, 'Kodein')).toEqual({
      drugId: null,
      ambiguous: true,
    });
  });

  it('steps over an ambiguous base name to a candidate that resolves', () => {
    // Base name 'Kodein' is shared, but the parenthetical names one drug —
    // ambiguity skips that candidate rather than ending the match.
    expect(matchSubstanceTitle(index, 'Kodein (K6G)')).toEqual({
      drugId: 3,
      ambiguous: false,
    });
    expect(matchSubstanceTitle(index, 'Kodein-6-glukuronid').drugId).toBe(3);
  });

  it('reports an unknown substance as unmatched, not ambiguous', () => {
    expect(matchSubstanceTitle(index, 'Fentanyl')).toEqual({
      drugId: null,
      ambiguous: false,
    });
  });
});
