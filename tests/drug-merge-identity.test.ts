/**
 * Identity folding for `npm run merge:drugs`.
 *
 * A merge deletes one of two rows, so any spelling only that row carried is
 * gone for good unless the fold keeps it. These pin the rule that keeps search
 * working afterwards: the survivor's names win their slots, but nothing the
 * loser answered to is dropped on the floor.
 */
import { describe, expect, it } from 'vitest';
import { mergeIdentity } from '../scripts/drug-merge/identity';

describe('mergeIdentity', () => {
  it('fills a language slot the survivor has no name for', () => {
    // The real Efedrin merge: survivor had nb only, loser carried the English.
    const merged = mergeIdentity(
      { names: { nb: 'Efedrin' }, aliases: [] },
      { names: { en: 'Ephedrine', nb: 'Efedrin' }, aliases: [] },
    );
    expect(merged.names).toEqual({ nb: 'Efedrin', en: 'Ephedrine' });
    expect(merged.addedNames).toEqual(['en="Ephedrine"']);
    expect(merged.aliases).toEqual([]);
  });

  it('keeps the survivor name and demotes the loser spelling to an alias', () => {
    const merged = mergeIdentity(
      { names: { nb: 'Norefedrin' }, aliases: [] },
      { names: { nb: 'Norefedrin (PPA)' }, aliases: [] },
    );
    expect(merged.names).toEqual({ nb: 'Norefedrin' });
    // Not discarded — somebody searches by it.
    expect(merged.aliases).toEqual(['Norefedrin (PPA)']);
    expect(merged.addedAliases).toEqual(['Norefedrin (PPA)']);
  });

  it('carries the loser aliases across', () => {
    const merged = mergeIdentity(
      { names: { nb: 'Amfetamin' }, aliases: ['Speed'] },
      { names: { nb: 'Amfetamin' }, aliases: ['Pepp', 'Speed'] },
    );
    expect(merged.aliases).toEqual(['Speed', 'Pepp']);
    expect(merged.addedAliases).toEqual(['Pepp']);
  });

  it('never repeats a spelling that is already a name in some language', () => {
    // buildDrugSearchKey indexes names and aliases alike, so a duplicate only
    // bloats the row without making anything findable.
    const merged = mergeIdentity(
      { names: { nb: 'Efedrin', en: 'Ephedrine' }, aliases: [] },
      { names: { nb: 'efedrin' }, aliases: ['EPHEDRINE'] },
    );
    expect(merged.aliases).toEqual([]);
    expect(merged.addedAliases).toEqual([]);
  });

  it('ignores blank and whitespace-only entries', () => {
    const merged = mergeIdentity(
      { names: { nb: 'Kodein' }, aliases: [] },
      { names: { en: '   ' }, aliases: ['', '  '] },
    );
    expect(merged.names).toEqual({ nb: 'Kodein' });
    expect(merged.aliases).toEqual([]);
  });

  it('builds a search key covering every surviving spelling', () => {
    const merged = mergeIdentity(
      { names: { nb: 'Efedrin' }, aliases: [] },
      { names: { en: 'Ephedrine' }, aliases: ['Efedrinhydroklorid'] },
    );
    for (const term of ['efedrin', 'ephedrine', 'efedrinhydroklorid']) {
      expect(merged.searchKey).toContain(term);
    }
  });

  describe('nameShort', () => {
    // `collectSearchTerms` indexes nameShort alongside names and aliases, so a
    // rebuild that forgets it drops the abbreviation out of the search key
    // while the column still displays one — search silently stops finding the
    // drug by the short name it still shows.
    it('keeps the survivor short name in the rebuilt search key', () => {
      const merged = mergeIdentity(
        { names: { nb: 'Gammahydroksysmørsyre' }, aliases: [], nameShort: 'GHB' },
        { names: { nb: 'Gammahydroksysmørsyre' }, aliases: [] },
      );
      expect(merged.nameShort).toBe('GHB');
      expect(merged.searchKey).toContain('ghb');
    });

    it('inherits the loser short name when the survivor has none', () => {
      const merged = mergeIdentity(
        { names: { nb: 'Gammahydroksysmørsyre' }, aliases: [], nameShort: null },
        { names: { nb: 'Gammahydroksysmørsyre' }, aliases: [], nameShort: 'GHB' },
      );
      expect(merged.nameShort).toBe('GHB');
      expect(merged.inheritedNameShort).toBe('GHB');
      expect(merged.searchKey).toContain('ghb');
    });

    it('keeps a differing loser short name as an alias rather than losing it', () => {
      const merged = mergeIdentity(
        { names: { nb: 'Morfin-6-glukuronid' }, aliases: [], nameShort: 'M6G' },
        { names: { nb: 'Morfin-6-glukuronid' }, aliases: [], nameShort: 'M-6-G' },
      );
      expect(merged.nameShort).toBe('M6G');
      expect(merged.aliases).toContain('M-6-G');
      expect(merged.searchKey).toContain('m-6-g');
    });

    it('does not repeat a short name that is already a name or alias', () => {
      const merged = mergeIdentity(
        { names: { nb: 'Efedrin' }, aliases: ['GHB'], nameShort: 'GHB' },
        { names: { nb: 'Efedrin' }, aliases: [], nameShort: 'ghb' },
      );
      expect(merged.aliases).toEqual([]);
      expect(merged.addedAliases).toEqual([]);
    });
  });

  it('leaves the survivor untouched when the loser adds nothing', () => {
    const survivor = { names: { nb: 'Diazepam' }, aliases: ['Valium'] };
    const merged = mergeIdentity(survivor, { names: { nb: 'Diazepam' }, aliases: [] });
    expect(merged.names).toEqual({ nb: 'Diazepam' });
    expect(merged.aliases).toEqual(['Valium']);
    expect(merged.addedNames).toEqual([]);
    expect(merged.addedAliases).toEqual([]);
  });
});
