import { describe, expect, it } from 'vitest';
import {
  clusterSameWorks,
  freetextMatchesRecord,
  isSameWork,
  workFingerprint,
  type WorkMatchRow,
} from './citationWorkMatch';

const schulz = {
  authors: ['Schulz M', 'Schmoldt A'],
  year: 2003,
  title:
    'Therapeutic and toxic blood concentrations of more than 800 drugs and other xenobiotics.',
};

function fp(record: Parameters<typeof workFingerprint>[0]) {
  const out = workFingerprint(record);
  if (!out) throw new Error('expected a fingerprint');
  return out;
}

describe('isSameWork', () => {
  it('matches a one-word slip in the title', () => {
    expect(
      isSameWork(
        fp(schulz),
        fp({
          ...schulz,
          title:
            'Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics',
        }),
      ),
    ).toBe(true);
  });

  it('ignores punctuation, case, accents and author-name order', () => {
    expect(
      isSameWork(
        fp({ authors: ['Høiseth G'], year: 2007, title: 'Exploring QSAR: Hydrophobic, Electronic, and Steric Constants' }),
        fp({ authors: ['G. Høiseth'], year: 2007, title: 'exploring qsar — hydrophobic electronic and steric constants' }),
      ),
    ).toBe(true);
  });

  it('treats a different number in the title as a different work', () => {
    expect(
      isSameWork(
        fp({ authors: ['Sweetman SC'], year: 2014, title: 'Martindale: The Complete Drug Reference, 38th ed.' }),
        fp({ authors: ['Sweetman SC'], year: 2014, title: 'Martindale: The Complete Drug Reference, 36th ed.' }),
      ),
    ).toBe(false);
    expect(
      isSameWork(
        fp(schulz),
        fp({ ...schulz, title: 'Therapeutic and toxic blood concentrations of nearly 1,000 drugs and other xenobiotics' }),
      ),
    ).toBe(false);
  });

  it('requires the same first author and year', () => {
    expect(isSameWork(fp(schulz), fp({ ...schulz, year: 2012 }))).toBe(false);
    expect(
      isSameWork(fp(schulz), fp({ ...schulz, authors: ['Schmoldt A'] })),
    ).toBe(false);
  });

  it('does not match two different papers by one author in one year', () => {
    expect(
      isSameWork(
        fp({ authors: ['Jones AW'], year: 2010, title: 'Evidence-based survey of the elimination rates of ethanol from blood' }),
        fp({ authors: ['Jones AW'], year: 2010, title: 'Blood ethanol concentrations in drunk drivers in Sweden' }),
      ),
    ).toBe(false);
  });

  it('gives no fingerprint for a title too short to tell works apart', () => {
    expect(workFingerprint({ authors: ['Holford NH'], year: 1987, title: 'Ethanol' })).toBeNull();
    expect(workFingerprint({ year: 2003, title: schulz.title })).toBeNull();
    expect(workFingerprint({ authors: ['Schulz M'], title: schulz.title })).toBeNull();
  });
});

describe('freetextMatchesRecord', () => {
  it('accepts text that opens with the author or the title', () => {
    expect(
      freetextMatchesRecord(
        'Schulz M, Schmoldt A. Therapeutic and toxic blood concentrations of more than 800 drugs and other xenobiotics. Pharmazie 2003.',
        fp(schulz),
      ),
    ).toBe(true);
    expect(freetextMatchesRecord(schulz.title, fp(schulz))).toBe(true);
  });

  it('rejects text describing a different work from its record', () => {
    // Two references pasted into one string, record filled in for the second.
    expect(
      freetextMatchesRecord(
        'Schulz M, Schmoldt A. Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics. Basalt RC. Disposition of Toxic Drugs and Chemicals in Man.',
        fp({ authors: ['Baselt RC'], year: 2020, title: 'Disposition of Toxic Drugs and Chemicals in Man, 12th ed.' }),
      ),
    ).toBe(false);
  });
});

describe('clusterSameWorks', () => {
  const row = (
    id: number,
    type: string,
    identifier: string,
    metadata: WorkMatchRow['metadata'],
    handleKey: string | null = null,
  ): WorkMatchRow => ({ id, type, identifier, metadata, handleKey });

  it('ties reworded free text to the resolvable row for the same work', () => {
    const clusters = clusterSameWorks([
      row(1744, 'pmid', '12889529', schulz, 'pmid:12889529'),
      row(1601, 'freetext', schulz.title, schulz),
      row(2132, 'freetext', 'Schulz M, Schmoldt A. Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics.', {
        ...schulz,
        title: 'Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics',
      }),
      row(9, 'freetext', 'Something else entirely, 2003', { authors: ['Other A'], year: 2003, title: 'A wholly unrelated paper on ethanol kinetics' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.ambiguous).toBe(false);
    expect(clusters[0]!.rows.map((r) => r.id).sort()).toEqual([1601, 1744, 2132]);
  });

  it('never joins two resolvable rows on their titles alone', () => {
    const guideline = { authors: ['Hiemke C'], year: 2018, title: 'Consensus Guidelines for Therapeutic Drug Monitoring in Neuropsychopharmacology' };
    expect(
      clusterSameWorks([
        row(1, 'pmid', '28910830', guideline, 'pmid:28910830'),
        row(2, 'pmid', '29390205', guideline, 'pmid:29390205'),
      ]),
    ).toEqual([]);
  });

  it('flags free text that reaches two different handles as ambiguous', () => {
    const [cluster] = clusterSameWorks([
      row(1, 'pmid', '1', schulz, 'pmid:1'),
      row(2, 'doi', '10.1/x', schulz, 'doi:10.1/x'),
      row(3, 'freetext', schulz.title, schulz),
    ]);
    expect(cluster?.ambiguous).toBe(true);
  });

  it('treats two rows of one handle group as one paper', () => {
    const [cluster] = clusterSameWorks([
      row(1, 'pmid', '1', schulz, 'pmid:1'),
      row(2, 'doi', '10.1/x', schulz, 'pmid:1'),
      row(3, 'freetext', schulz.title, schulz),
    ]);
    expect(cluster?.ambiguous).toBe(false);
  });
});
