import { describe, it, expect } from 'vitest';
import {
  buildEntryComments,
  loadPmAmDataset,
  parsePmAmDataset,
  seededReadingFor,
  storedEntryMatches,
  toParameterEntryInput,
  PM_AM_PARAMETER,
  PM_AM_UNIT,
  type PmAmRow,
} from '../scripts/pm-am-ratios/dataset';
import {
  parameterIsMatrixRelevant,
  parameterIsScenarioRelevant,
  parameterIsSummarizable,
  getRangeSpec,
} from '../src/lib/drugParameters';
import { validateEntryForParameter } from '../src/lib/parameterEntries';

const dataset = loadPmAmDataset();

/** A row shaped like Table I, for the negative cases. */
function row(overrides: Partial<PmAmRow> = {}): PmAmRow {
  return {
    drug: 'Amitriptyline',
    pubchemCid: 2160,
    pubchemName: 'Amitriptyline',
    class: 'Antidepressiva',
    n: 53,
    t1Hours: 29,
    t2Hours: 18,
    median: 2.6,
    low: 0.37,
    high: 224,
    pValue: '<0.001',
    significant: true,
    ...overrides,
  } as PmAmRow;
}

describe('PM/AM ratio dataset (Mantinieks et al. 2021)', () => {
  it('cites the paper by DOI with a complete bibliographic record', () => {
    expect(dataset.source.type).toBe('doi');
    expect(dataset.source.identifier).toBe('10.1093/jat/bkaa107');
    expect(dataset.source.journal).toBe('Journal of Analytical Toxicology');
    expect(dataset.source.year).toBe(2021);
    expect(dataset.source.pages).toBe('368-377');
    expect(dataset.source.authors[0]).toBe('Mantinieks D');
  });

  it('transcribes all 42 Table I analytes, one row each', () => {
    // The paper reports 42 parent drugs and metabolites with at least 10
    // paired AM/PM values.
    expect(dataset.entries).toHaveLength(42);
    const cids = dataset.entries.map((e) => e.pubchemCid);
    expect(new Set(cids).size).toBe(cids.length);
    expect(dataset.study.cases).toBe(811);
  });

  it('pins each analyte to a verified PubChem identity', () => {
    // Matching is by CID, so a mistyped one silently seeds the WRONG drug
    // rather than failing to match. `pubchemName` is PubChem's own Title for
    // that CID, captured at transcription time so the mapping is reviewable
    // offline — an earlier draft had pholcodine on a CID that resolves to an
    // unrelated peptide.
    const byName = new Map(dataset.entries.map((e) => [e.drug, e]));
    const verified: Record<string, [number, string]> = {
      // The rows where the paper's analyte name is NOT PubChem's preferred one,
      // plus the two that are easy to attach to the wrong compound.
      Methylamphetamine: [10836, 'Methamphetamine'],
      Paracetamol: [1983, 'Acetaminophen'],
      'Morphine, free': [5288826, 'Morphine'],
      'Codeine, free': [5284371, 'Codeine'],
      EDDP: [5352621, '2-Ethylidene-1,5-dimethyl-3,3-diphenylpyrrolidine'],
      Pholcodine: [5311356, 'Pholcodine'],
      // The paper counts the risperidone metabolite and administered
      // paliperidone as one drug.
      Hydroxyrisperidone: [115237, 'Paliperidone'],
      // The O-desmethyl metabolite (desvenlafaxine), NOT N-desmethylvenlafaxine
      // (CID 3501942), which is a separate registry entry.
      'O-Desmethylvenlafaxine': [125017, 'Desvenlafaxine'],
    };
    for (const [name, [cid, title]] of Object.entries(verified)) {
      const entry = byName.get(name);
      expect(entry, `${name} missing from dataset`).toBeDefined();
      expect([entry!.pubchemCid, entry!.pubchemName]).toEqual([cid, title]);
    }
    // No row may be left without its verified identity.
    for (const e of dataset.entries) {
      expect(e.pubchemName.length).toBeGreaterThan(0);
    }
  });

  it('names the venlafaxine metabolite by isomer so it cannot be confused', () => {
    const drugs = dataset.entries.map((e) => e.drug);
    expect(drugs).toContain('O-Desmethylvenlafaxine');
    expect(drugs).not.toContain('Desmethylvenlafaxine');
    const entry = dataset.entries.find(
      (e) => e.drug === 'O-Desmethylvenlafaxine',
    )!;
    expect(entry.note).toContain('IKKE N-desmetylvenlafaksin');
  });

  it('matches the published median (range) for a spot-check across drug classes', () => {
    const byName = new Map(dataset.entries.map((e) => [e.drug, e]));
    const expected: Record<string, [number, number, number, number]> = {
      // drug: [median, low, high, n]
      Amitriptyline: [2.6, 0.37, 224, 53],
      Olanzapine: [3.3, 0.25, 86, 53],
      Alprazolam: [0.54, 0.07, 2.1, 27],
      Diltiazem: [0.69, 0.09, 5.4, 13],
      Methylamphetamine: [0.95, 0.02, 5.0, 59],
      Pholcodine: [16, 0.24, 47, 16],
      'Morphine, free': [1.7, 0.04, 122, 204],
      Paracetamol: [0.94, 0.04, 17, 224],
    };
    for (const [name, [median, low, high, n]] of Object.entries(expected)) {
      const entry = byName.get(name);
      expect(entry, `${name} missing from dataset`).toBeDefined();
      expect([entry!.median, entry!.low, entry!.high, entry!.n]).toEqual([
        median,
        low,
        high,
        n,
      ]);
    }
  });

  it('marks exactly the shaded (statistically significant) Table I rows', () => {
    const significant = dataset.entries
      .filter((e) => e.significant)
      .map((e) => e.drug)
      .sort();
    expect(significant).toEqual(
      [
        'Amitriptyline',
        'Nortriptyline',
        'Citalopram',
        'Sertraline',
        'Paroxetine',
        'Mirtazapine',
        'Olanzapine',
        'Hydroxyrisperidone',
        'Quetiapine',
        'Diazepam',
        'Nordiazepam',
        'Alprazolam',
        'Atenolol',
        'Verapamil',
        'Pholcodine',
        'Morphine, free',
        'EDDP',
        'Levetiracetam',
        'Metoclopramide',
      ].sort(),
    );
    // Every non-significant row carries the ">0.05" the table prints.
    for (const e of dataset.entries.filter((x) => !x.significant)) {
      expect(e.pValue).toBe('>0.05');
    }
  });

  it('keeps every value inside the pmAmRatio registry bounds', () => {
    const spec = getRangeSpec(PM_AM_PARAMETER);
    for (const e of dataset.entries) {
      for (const v of [e.low, e.median, e.high]) {
        expect(v).toBeGreaterThanOrEqual(spec.bounds.min);
        expect(v).toBeLessThanOrEqual(spec.bounds.max);
      }
    }
  });

  it('builds an entry payload that passes the live registry validation', () => {
    for (const e of dataset.entries) {
      const input = toParameterEntryInput(e, 1, 1);
      expect(input.parameter).toBe(PM_AM_PARAMETER);
      expect(input.unit).toBe(PM_AM_UNIT);
      expect(input.n).toBe(e.n);
      expect(validateEntryForParameter(PM_AM_PARAMETER, input)).toBeNull();
    }
  });

  it('records study context in comments, since PM/AM has no matrix or scenario column', () => {
    expect(parameterIsSummarizable(PM_AM_PARAMETER)).toBe(true);
    expect(parameterIsMatrixRelevant(PM_AM_PARAMETER)).toBe(false);
    expect(parameterIsScenarioRelevant(PM_AM_PARAMETER)).toBe(false);

    // The comment is reader-facing, so it is Norwegian like every other stored
    // string a Kinetix reader sees.
    const comments = buildEntryComments(row());
    expect(comments).toContain('53 parvise saker');
    expect(comments).toContain('femoralblod');
    expect(comments).toContain('statistisk signifikant');
    // The ratio must never be presented as a back-calculation factor, nor as a
    // single site sampled twice — only the PM member's site is defined.
    expect(comments).toContain('ikke en faktor for å regne tilbake');
    expect(comments).toContain('Parvise prøver, ikke ett prøvested tatt to ganger');
    expect(comments).toContain('uoppgitt sted');

    const nonSignificant = buildEntryComments(
      row({ significant: false, pValue: '>0.05' }),
    );
    expect(nonSignificant).toContain('Ingen statistisk signifikant forskjell');
  });

  it('appends the drug-specific caveat when the paper reports one', () => {
    const quetiapine = dataset.entries.find((e) => e.drug === 'Quetiapine')!;
    expect(buildEntryComments(quetiapine)).toContain(
      'Netto nedbrytning av kvetiapin',
    );
  });

  it('rejects a row whose median falls outside its reported range', () => {
    expect(() =>
      parsePmAmDataset({ ...dataset, entries: [row({ median: 300 })] }),
    ).toThrow();
  });

  it('rejects a duplicate analyte', () => {
    expect(() =>
      parsePmAmDataset({ ...dataset, entries: [row(), row()] }),
    ).toThrow(/Duplicate pubchemCid/);
  });
});

describe('rerun identity (storedEntryMatches)', () => {
  const input = toParameterEntryInput(row(), 7, 9);
  /** What the driver returns for the row that input wrote: numerics as strings. */
  const stored = {
    low: '0.370000',
    high: '224.000000',
    median: '2.600000',
    centralValue: null,
    centralStatistic: null,
    intervalKind: null,
    unit: input.unit,
    n: input.n ?? null,
    comments: input.comments ?? null,
  };
  /** The same row after a curator said what its numbers are. */
  const labelled = {
    ...stored,
    median: null,
    centralValue: '2.600000',
    centralStatistic: 'median',
    intervalKind: 'range',
  };

  it('treats a curator-labelled row with the same numbers as unchanged, so a rerun keeps the labels', () => {
    expect(storedEntryMatches(labelled, input)).toBe(true);
  });

  it('keeps the curated labels around corrected numbers', () => {
    const corrected = toParameterEntryInput(row({ median: 2.5 }), 7, 9);
    expect(storedEntryMatches(labelled, corrected)).toBe(false);
    expect(seededReadingFor(labelled, corrected)).toEqual({
      ok: true,
      reading: {
        low: 0.37,
        high: 224,
        centralValue: 2.5,
        centralStatistic: 'median',
        intervalKind: 'range',
      },
    });
  });

  it('writes an unlabelled row as the plain low/high/median it was', () => {
    const corrected = toParameterEntryInput(row({ median: 2.5 }), 7, 9);
    expect(seededReadingFor(stored, corrected)).toEqual({
      ok: true,
      reading: { low: 0.37, high: 224, median: 2.5 },
    });
  });

  it('leaves labels that no longer fit the corrected numbers to a human', () => {
    const sd = { ...labelled, centralStatistic: 'arithmetic_mean', intervalKind: 'sd' };
    const corrected = toParameterEntryInput(row({ median: 2.5 }), 7, 9);
    const result = seededReadingFor(sd, corrected);
    expect(result.ok).toBe(false);
  });

  it('treats a row written from the same dataset as unchanged', () => {
    expect(storedEntryMatches(stored, input)).toBe(true);
  });

  it('detects a corrected bound, so the seeder updates instead of inserting a second row', () => {
    // Value-keyed matching would call this a new independent observation and
    // double-weight the paper.
    expect(storedEntryMatches({ ...stored, high: '220.000000' }, input)).toBe(
      false,
    );
    expect(storedEntryMatches({ ...stored, median: '2.700000' }, input)).toBe(
      false,
    );
  });

  it('detects a corrected sample size or comment, which value-keyed matching ignores', () => {
    // `n` weights the pooled aggregate, so a stale one silently mis-weights the
    // summary; neither field is compared by entryDuplicateExists.
    expect(storedEntryMatches({ ...stored, n: 52 }, input)).toBe(false);
    expect(
      storedEntryMatches({ ...stored, comments: 'stale note' }, input),
    ).toBe(false);
  });

  it('treats a missing stored value as a difference', () => {
    expect(storedEntryMatches({ ...stored, median: null }, input)).toBe(false);
  });
});
