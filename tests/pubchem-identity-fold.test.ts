/**
 * The audit is only as good as its name comparison.
 *
 * Too strict and it reports most of a Norwegian catalog as suspect, which means
 * nobody reads the list. Too loose and it silently clears a CID naming a
 * different substance, which is the one thing it exists to catch. These are the
 * cases that pin both edges.
 */
import { describe, expect, it } from 'vitest';
import {
  candidates,
  catalogForms,
  foldName,
  matchesAny,
} from '../scripts/pubchem/names';

const same = (a: string, b: string): boolean => foldName(a) === foldName(b);

describe('foldName: Norwegian and English INN spellings of one substance', () => {
  it.each([
    ['Ephedrine', 'Efedrin'],
    ['Norephedrine', 'Norefedrin'],
    ['Scopolamine', 'Skopolamin'],
    ['Codeine', 'Kodein'],
    ['Oxycodone', 'Oksykodon'],
    ['Diazepam', 'Diazepam'],
    ['Cyclophosphamide', 'Syklofosfamid'],
    ['Amphetamine', 'Amfetamin'],
    ['Theophylline', 'Teofyllin'],
    ['Warfarin', 'Warfarin'],
  ])('%s ≡ %s', (en, nb) => {
    expect(same(en, nb)).toBe(true);
  });

  it('ignores stereo and charge decoration PubChem titles carry', () => {
    expect(same('(1R,2S)-Ephedrine', 'Efedrin')).toBe(true);
    expect(same('DL-Ephedrine', 'DL-Efedrin')).toBe(true);
  });
});

describe('foldName: substances that are not the same substance', () => {
  /**
   * Every pair here is a real or realistic near-miss. If the fold collapses one
   * of them the audit stops being able to report the bug it was written for —
   * `sildenafil` carrying a CID for methyl pyrazole-4-carboxylate.
   */
  it.each([
    ['Sildenafil', 'Methyl 1H-pyrazole-4-carboxylate'],
    ['Telmisartan', '2-Bromobenzoic acid'],
    ['Valsartan', 'Losartan'],
    ['Codeine', 'Codeine N-oxide'],
    ['Morphine', 'Morphinone'],
    ['Nortriptyline', 'Amitriptyline'],
    ['Alprazolam', 'Triazolam'],
    ['Enalapril', 'Enalaprilat'],
  ])('%s ≢ %s', (a, b) => {
    expect(same(a, b)).toBe(false);
  });
});

describe('no name is cleared on resemblance alone', () => {
  /**
   * A bounded edit distance used to stand in for identity here, on the theory
   * that two characters could not reach a neighbouring drug name over twelve.
   * These are the pairs from this catalog that disprove it — and they are not
   * obscure: two barbiturates, and two designer benzodiazepines a laboratory
   * reports separately.
   *
   * INN stems are shared on purpose, so pharmacologically adjacent substances
   * have adjacent names BY DESIGN. Distance between drug names is not evidence
   * about molecules, at any threshold.
   */
  const catalogNamed = (name: string) =>
    catalogForms({ names: { nb: name }, aliases: [], nameShort: null });

  it.each([
    ['Fenobarbital', 'Pentobarbital'],
    ['Flubromazepam', 'Flubromazolam'],
    ['Enalapril', 'Enalaprilat'],
    ['Morphine', 'Morphinone'],
    ['Nortriptyline', 'Amitriptyline'],
    ['Dexamethasone', 'Betamethasone'],
  ])('%s does not clear %s', (a, b) => {
    expect(matchesAny(catalogNamed(a), b)).toBe(false);
    expect(matchesAny(catalogNamed(b), a)).toBe(false);
  });

  it('still clears a spelling the fold genuinely bridges', () => {
    expect(matchesAny(catalogNamed('Efedrin'), 'Ephedrine')).toBe(true);
    expect(matchesAny(catalogNamed('Skopolamin'), 'Scopolamine')).toBe(true);
    expect(matchesAny(catalogNamed('Syklofosfamid'), 'Cyclophosphamide')).toBe(true);
  });
});

describe('candidates: shortening a PubChem title to its parent name', () => {
  /**
   * A title match is stage 1 of the audit, and stage 1 SHORT-CIRCUITS: a row
   * that matches here never reaches the synonym list or the InChIKey
   * connectivity comparison. So a title shortened past the point where it still
   * names the same molecule is not a near-miss, it is a wrong CID reported as
   * confirmed.
   */
  const shortens = (title: string, name: string): boolean =>
    candidates(title).some((c) => matchesAny(catalogForms({ names: { nb: name }, aliases: [], nameShort: null }), c));

  it.each([
    ['Warfarin sodium', 'Warfarin'],
    ['Sildenafil citrate', 'Sildenafil'],
    ['Amitriptyline hydrochloride', 'Amitriptylin'],
    ['Ondansetron hydrochloride dihydrate', 'Ondansetron'],
    ['Cocaine free base', 'Kokain'],
  ])('%s still names %s', (title, name) => {
    expect(shortens(title, name)).toBe(true);
  });

  it.each([
    // The regression this replaced a regex for: `sodium` used to consume the
    // rest of the title, so the withheld `phosphate` never got a say. All four
    // are esters — a different molecule from the drug they are named after.
    ['Dexamethasone sodium phosphate', 'Dexametason'],
    ['Betamethasone sodium phosphate', 'Betametason'],
    ['Methylprednisolone sodium succinate', 'Metylprednisolon'],
    ['Chloramphenicol sodium succinate', 'Kloramfenikol'],
    ['Haloperidol decanoate', 'Haloperidol'],
    ['Codeine phosphate', 'Kodein'],
    // Phase II conjugates. In a forensic toxicology catalog the conjugate is
    // the analyte, with its own detection window — `Morphine sulfate` is a salt
    // and `Estrone sulfate` is not, and the title cannot tell them apart.
    ['Estrone sulfate', 'Østron'],
    ['Dehydroepiandrosterone sulfate', 'Dehydroepiandrosteron'],
    ['Morphine sulfate', 'Morfin'],
  ])('%s does NOT clear a CID for %s', (title, name) => {
    expect(shortens(title, name)).toBe(false);
  });

  it('gives up rather than returning a partial strip', () => {
    // `sodium` is recognised, `phosphate` is not. Returning "Dexamethasone
    // sodium" would be no safer than returning "Dexamethasone" — the point is
    // that an unrecognised modifier sends the whole row to the slower checks.
    expect(candidates('Dexamethasone sodium phosphate')).toEqual([
      'Dexamethasone sodium phosphate',
    ]);
  });

  it('never shortens a title away to nothing', () => {
    for (const title of ['Sodium', 'sodium chloride', 'Hydrate']) {
      expect(candidates(title).every((c) => c.trim().length > 0)).toBe(true);
    }
  });
});

describe('foldName: shape', () => {
  it('is idempotent, so a folded value can be compared to a folded value', () => {
    for (const n of ['Ephedrine', 'Skopolamin', '(1R,2S)-Ephedrine']) {
      expect(foldName(foldName(n))).toBe(foldName(n));
    }
  });

  it('folds an empty or punctuation-only name to nothing rather than matching everything', () => {
    expect(foldName('')).toBe('');
    expect(foldName('   -  ')).toBe('');
    expect(foldName('()')).toBe('');
  });
});
