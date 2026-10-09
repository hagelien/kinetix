/**
 * Matching a Kinetix substance to a row of the laboratory's guideline.
 *
 * The whole feature rests on this: a member looking up a substance is told what
 * the guideline states for it, and a wrong match would put one substance's
 * agreed band under another substance's name. The cases below are the ones a
 * guideline's own spelling makes non-obvious — compound cells, parenthesised
 * synonyms, substances that are both a row and somebody's metabolite.
 *
 * The rows are SYNTHETIC (`fixtures/refsSyntheticGuideline.ts`): the real table
 * is restricted and lives only in the database.
 */
import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_REFS_ROWS as REFS_URINE_DETECTION_ROWS,
  SYNTHETIC_REFS_SOURCE,
} from './fixtures/refsSyntheticGuideline';
import {
  buildRefsNameIndex,
  foldSubstanceName,
  matchRefsRows,
  nameMatchKeys,
  isRefsGuidelineSource,
  isRefsUrineDetectionRow,
  refsStatementForRole,
  substanceNameCandidates,
} from '../refsDetectionTimes';

const index = buildRefsNameIndex(REFS_URINE_DETECTION_ROWS);

/** Match by a bare name, the way a caller with one string would. */
function match(...names: string[]) {
  return matchRefsRows(index, names);
}

describe('foldSubstanceName', () => {
  it('ignores case, spacing, hyphens and accents', () => {
    expect(foldSubstanceName('6-MAM')).toBe(foldSubstanceName('6 mam'));
    expect(foldSubstanceName('THC-syre')).toBe(foldSubstanceName('THCsyre'));
    expect(foldSubstanceName('Fenazepam')).toBe(foldSubstanceName('fenazepam'));
  });
});

describe('nameMatchKeys', () => {
  it('splits a parenthesised synonym out of the name', () => {
    expect(nameMatchKeys('Fencyklidin (PCP)')).toEqual(
      expect.arrayContaining(['fencyklidinpcp', 'fencyklidin', 'pcp']),
    );
  });

  it('splits a compound cell on its separators', () => {
    expect(nameMatchKeys('MDMA/MDA (Ecstacy)')).toEqual(
      expect.arrayContaining(['mdma', 'mda', 'ecstacy']),
    );
  });
});

describe('matchRefsRows', () => {
  it('finds a substance that is a row of its own', () => {
    const [first] = match('Ketamin');
    expect(first?.row.key).toBe('ketamin');
    expect(first?.role).toBe('parent');
  });

  it('finds a substance through the metabolite column', () => {
    // A urine screen finds THC-syre, not THC. The guideline answers that
    // through the THC row, and the match has to say why it is showing one.
    const [first] = match('THC-syre');
    expect(first?.row.key).toBe('thc');
    expect(first?.role).toBe('metabolite');
    expect(first?.matchedName).toBe('THC-syre');
  });

  it('returns both roles for a substance that is a row AND a metabolite', () => {
    // Oxazepam is its own row and a listed metabolite of diazepam. Losing either would hide the ambiguity the section interprets
    // around — so both come back, the substance's own row first.
    const matches = match('Oxazepam');
    expect(matches.map((m) => [m.row.key, m.role])).toEqual([
      ['oxazepam', 'parent'],
      ['diazepam', 'metabolite'],
    ]);
  });

  it('matches an English name through the row aliases', () => {
    expect(match('Cocaine')[0]?.row.key).toBe('kokain');
    expect(match('Methamphetamine')[0]?.row.key).toBe('metamfetamin');
  });

  it('matches a synonym written inside the guideline cell', () => {
    expect(match('PCP')[0]?.row.key).toBe('fencyklidin');
    expect(match('MDMA')[0]?.row.key).toBe('mdma-mda');
  });

  it('does not match a substance the guideline never names', () => {
    expect(match('Paracetamol')).toEqual([]);
  });

  it('reports each row once however many names point at it', () => {
    const matches = match('Kokain', 'Cocaine', 'kokain');
    expect(matches.filter((m) => m.row.key === 'kokain')).toHaveLength(1);
  });

  it('takes every name a catalog substance is known by', () => {
    const candidates = substanceNameCandidates({
      names: { nb: 'Metadon', en: 'Methadone' },
      nameShort: null,
      aliases: ['EDDP'],
    });
    expect(matchRefsRows(index, candidates)[0]?.row.key).toBe('metadon');
  });
});

describe('refsStatementForRole', () => {
  const row = (key: string) =>
    REFS_URINE_DETECTION_ROWS.find((r) => r.key === key)!;

  it('gives the one statement a row makes about the pair', () => {
    expect(refsStatementForRole(row('ketamin'), 'parent')).toEqual({
      kind: 'band',
      band: 'days',
    });
  });

  it('gives each half of a split row its own statement', () => {
    // The etanol row states one band for the parent and another for EtG/EtS.
    // A reader who searched for EtG must get the second, not the first.
    expect(refsStatementForRole(row('etanol'), 'parent')).toEqual({
      kind: 'band',
      band: 'halfDay',
    });
    expect(refsStatementForRole(row('etanol'), 'metabolite')).toEqual({
      kind: 'band',
      band: 'days',
    });
  });

  it('states nothing for a metabolite the row only answers the parent for', () => {
    // The metadon row states a band for the parent only, with EDDP beside
    // it, so it says nothing about how long EDDP is found. Handing the
    // parent's band to EDDP would be inventing a forensic statement.
    expect(refsStatementForRole(row('metadon'), 'parent')).toEqual({
      kind: 'band',
      band: 'week',
    });
    expect(refsStatementForRole(row('metadon'), 'metabolite')).toEqual({
      kind: 'notStated',
    });
  });
});

describe('the fixture table', () => {
  it('carries a document identity the source guard accepts', () => {
    expect(isRefsGuidelineSource(SYNTHETIC_REFS_SOURCE)).toBe(true);
    expect(isRefsGuidelineSource({ ...SYNTHETIC_REFS_SOURCE, version: 1 })).toBe(
      false,
    );
  });

  it('passes the validator the client rejects a bad payload with', () => {
    // Keeps the fixture honest against the guard: a row typed wrong here would
    // be dropped at the client boundary, and a shortened forensic table is
    // indistinguishable from a complete one.
    for (const row of REFS_URINE_DETECTION_ROWS) {
      expect(isRefsUrineDetectionRow(row), row.key).toBe(true);
    }
  });

  it('keys every row uniquely', () => {
    const keys = REFS_URINE_DETECTION_ROWS.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('states at least one reading per row', () => {
    for (const row of REFS_URINE_DETECTION_ROWS) {
      expect(row.readings.length, row.key).toBeGreaterThan(0);
    }
  });

  it('splits a reading by scope only when the row has more than one', () => {
    // A single-reading row saying "moderstoff" would draw a distinction the
    // guideline's cell did not make.
    for (const row of REFS_URINE_DETECTION_ROWS) {
      if (row.readings.length === 1) {
        expect(row.readings[0]!.scope, row.key).not.toBe('metabolite');
      }
    }
  });

  it('keeps every band within the vocabulary the module renders', () => {
    const allowed = new Set(['halfDay', 'day', 'days', 'week', 'twoWeeks']);
    for (const row of REFS_URINE_DETECTION_ROWS) {
      for (const reading of row.readings) {
        if (reading.statement.kind !== 'band') continue;
        expect(allowed.has(reading.statement.band), row.key).toBe(true);
        if (reading.statement.upper) {
          expect(allowed.has(reading.statement.upper), row.key).toBe(true);
        }
      }
    }
  });
});

describe('metabolite synonyms', () => {
  it('keys every metabolite alias by a metabolite the row actually lists', () => {
    // Otherwise a metabolite renamed in the table leaves its synonyms pointing
    // at a name the guideline no longer uses.
    for (const row of REFS_URINE_DETECTION_ROWS) {
      for (const key of Object.keys(row.metaboliteAliases ?? {})) {
        expect(row.metabolites, `${row.key}.${key}`).toContain(key);
      }
    }
  });

  it('gives a metabolite synonym the metabolite role, not the parent one', () => {
    // The role decides which half of a split row the reader is told: etanol's
    // parent and EtG carry different bands. Filed as a parent alias, EtG would
    // be answered with the parent's reading.
    for (const name of ['EtG', 'Etylglukuronid', 'Benzoylecgonine', 'M3G']) {
      const [first] = match(name);
      expect(first?.role, name).toBe('metabolite');
    }
    expect(match('EtG')[0]?.matchedName).toBe('Etylglukuronid');
  });

  it('never reports one row as both the parent and a metabolite of one name', () => {
    // Two roles on ONE row is always a data error — a substance cannot be its
    // own metabolite. Two roles across two rows (oxazepam) is the guideline's
    // own cross-reference and stays.
    const names = REFS_URINE_DETECTION_ROWS.flatMap((row) => [
      row.parent,
      ...row.metabolites,
      ...(row.aliases ?? []),
      ...Object.values(row.metaboliteAliases ?? {}).flat(),
    ]);
    for (const name of names) {
      const seen = new Set<string>();
      for (const found of match(name)) {
        expect(seen.has(found.row.key), `${name} → ${found.row.key}`).toBe(false);
        seen.add(found.row.key);
      }
    }
  });

  it('does not answer for substances the table leaves out', () => {
    // Each of these is a close relative of a row (a metabolite or congener)
    // that the table does not name; an over-broad alias would hand it a band
    // stated for something else.
    expect(match('Norketamin')).toEqual([]);
    expect(match('Norefedrin')).toEqual([]);
    expect(match('Tiopental')).toEqual([]);
  });
});
