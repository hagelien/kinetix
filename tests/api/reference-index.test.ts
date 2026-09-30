import { describe, expect, it } from 'vitest';

import {
  alphaBucketKey,
  alphaBucketRank,
  authorBucketKey,
  buildReferenceIndexPage,
  parseGroupBy,
  parseLang,
  parsePage,
  parsePageSize,
  yearBucketKey,
  type IndexCitation,
  type ReferenceOwner,
} from '../../api/_lib/reference-index.ts';

function citation(
  id: number,
  title: string,
  year?: number | null,
): IndexCitation {
  return {
    id,
    drugId: null,
    type: 'doi',
    identifier: `10.1000/${id}`,
    metadata: { title, ...(year != null ? { year } : {}) },
    createdAt: '2026-05-12T00:00:00.000Z',
  };
}

function authored(
  id: number,
  title: string,
  authors: string[],
  year?: number,
): IndexCitation {
  const row = citation(id, title, year);
  return { ...row, metadata: { ...row.metadata, authors } };
}

function citationMap(rows: IndexCitation[]): Map<number, IndexCitation> {
  return new Map(rows.map((row) => [row.id, row]));
}

const drugOwner = (
  id: number,
  heading: string,
  citationIds: number[],
): ReferenceOwner => ({
  kind: 'drug',
  id,
  slug: heading.toLowerCase(),
  names: { nb: heading },
  href: `/wiki/drug/${id}`,
  heading,
  citationIds,
});

describe('query parsing', () => {
  it('defaults to the monograph axis', () => {
    expect(parseGroupBy(null)).toBe('drug');
    expect(parseGroupBy('nonsense')).toBe('drug');
    expect(parseGroupBy('alpha')).toBe('alpha');
    expect(parseGroupBy('author')).toBe('author');
    expect(parseGroupBy('year')).toBe('year');
  });

  it('clamps the page size and floors the page at 1', () => {
    expect(parsePageSize(null)).toBe(50);
    expect(parsePageSize('0')).toBe(50);
    expect(parsePageSize('10')).toBe(10);
    expect(parsePageSize('9999')).toBe(200);
    expect(parsePage('-3')).toBe(1);
    expect(parsePage('4')).toBe(4);
  });

  it('never lets a positive fraction truncate the page size to zero', () => {
    // `pageSize=0.5` passes a naive `> 0` guard, then truncates to 0 — which
    // would slice every page empty and make totalPages Infinity.
    expect(parsePageSize('0.5')).toBe(1);
    expect(parsePageSize('1.9')).toBe(1);
  });

  it('accepts well-formed language tags and drops malformed ones', () => {
    expect(parseLang('nb')).toBe('nb');
    expect(parseLang('en-GB')).toBe('en-GB');
    expect(parseLang('zh-Hant-TW')).toBe('zh-Hant-TW');
    // Intl throws a RangeError on these; the index must not 500 over a sort key.
    expect(parseLang('en_US')).toBeUndefined();
    expect(parseLang('foo_bar')).toBeUndefined();
    expect(parseLang('')).toBeUndefined();
    expect(parseLang(null)).toBeUndefined();
  });
});

describe('bucket keys', () => {
  it('files a title under its first letter, ignoring leading punctuation', () => {
    expect(alphaBucketKey('"Absorption of ethanol"')).toBe('A');
    expect(alphaBucketKey('Élimination rénale')).toBe('E');
    expect(alphaBucketKey('5-HT2A binding')).toBe('#');
    expect(alphaBucketKey('')).toBe('#');
  });

  it('keeps Æ/Ø/Å as their own Norwegian buckets', () => {
    expect(alphaBucketKey('Åreknuter')).toBe('Å');
    expect(alphaBucketKey('øyeblikkelig')).toBe('Ø');
  });

  it('orders A–Z, then Æ Ø Å, then everything else, then #', () => {
    const ordered = ['A', 'B', 'Z', 'Æ', 'Ø', 'Å', 'Ω', '#'];
    const ranks = ordered.map(alphaBucketRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(alphaBucketRank('Å')).toBeLessThan(alphaBucketRank('Ω'));
    expect(alphaBucketRank('Ω')).toBeLessThan(alphaBucketRank('#'));
  });

  it('reads a four-digit year, else "unknown"', () => {
    expect(yearBucketKey(citation(1, 'x', 2019))).toBe('2019');
    expect(yearBucketKey(citation(2, 'x'))).toBe('unknown');
    expect(yearBucketKey(citation(3, 'x', 19 as number))).toBe('unknown');
  });

  it('files a source under its first author’s surname initial', () => {
    // The surname is whichever part is not an initial cluster, so the axis
    // agrees with the "[Huertas 2020]" marker rendered next to the citation.
    expect(authorBucketKey(authored(1, 'x', ['Huertas T', 'Aasen B']))).toBe(
      'H',
    );
    expect(authorBucketKey(authored(2, 'x', ['Doe John']))).toBe('D');
    expect(authorBucketKey(authored(3, 'x', ['Ødegaard K']))).toBe('Ø');
    // An organisation files under its own name rather than a parsed surname.
    expect(authorBucketKey(authored(4, 'x', ['World Health Organization']))).toBe(
      'W',
    );
  });

  it('buckets an authorless source apart, after every letter and #', () => {
    expect(authorBucketKey(citation(1, 'A standard with no author'))).toBe(
      'unknown',
    );
    expect(authorBucketKey(authored(2, 'x', ['   ']))).toBe('unknown');
    expect(alphaBucketRank('unknown')).toBeGreaterThan(alphaBucketRank('#'));
  });
});

describe('buildReferenceIndexPage', () => {
  it('orders drug monographs before wiki pages, each alphabetically', () => {
    const citations = citationMap([
      citation(1, 'Alpha'),
      citation(2, 'Beta'),
      citation(3, 'Gamma'),
    ]);
    const owners: ReferenceOwner[] = [
      {
        kind: 'wiki',
        id: 9,
        slug: 'half-life',
        title: 'Half-life',
        href: '/wiki/half-life',
        heading: 'Half-life',
        citationIds: [3],
      },
      drugOwner(2, 'Oksazepam', [2]),
      drugOwner(1, 'Diazepam', [1]),
    ];

    const page = buildReferenceIndexPage({
      owners,
      citations,
      groupBy: 'drug',
      page: 1,
      pageSize: 50,
    });

    expect(page.groups.map((g) => g.key)).toEqual([
      'drug-1',
      'drug-2',
      'wiki-9',
    ]);
    expect(page.totalRows).toBe(3);
    expect(page.rangeStart).toBe(1);
    expect(page.rangeEnd).toBe(3);
  });

  it('counts a source once per owner in drug mode', () => {
    const citations = citationMap([citation(1, 'Shared source')]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1]), drugOwner(2, 'Oksazepam', [1])],
      citations,
      groupBy: 'drug',
      page: 1,
      pageSize: 50,
    });

    expect(page.totalRows).toBe(2);
    expect(page.matchedReferences).toBe(1);
    expect(page.groups).toHaveLength(2);
  });

  it('lists a source once on the flat A–Z axis, with # last', () => {
    const citations = citationMap([
      citation(1, '5-HT2A binding'),
      citation(2, 'Absorption'),
      citation(3, 'Åreknuter'),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3]), drugOwner(2, 'X', [2])],
      citations,
      groupBy: 'alpha',
      page: 1,
      pageSize: 50,
    });

    expect(page.groups.map((g) => g.key)).toEqual(['A', 'Å', '#']);
    expect(page.totalRows).toBe(3);
    expect(page.buckets).toEqual([
      { key: 'A', label: 'A', count: 1 },
      { key: 'Å', label: 'Å', count: 1 },
      { key: '#', label: '#', count: 1 },
    ]);
  });

  it('keeps the Nordic buckets after Z even under an English collator', () => {
    // Intl.Collator('en') treats Å/Æ as variants of A and Ø as a variant of O,
    // which would interleave them into the Latin run for exactly the readers
    // least likely to expect it. The alpha axis has one canonical order.
    const citations = citationMap([
      citation(1, 'Absorption'),
      citation(2, 'Åreknuter'),
      citation(3, 'Binding'),
      citation(4, 'Ømfintlig'),
      citation(5, 'Ærlig'),
      citation(6, 'Zolpidem'),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3, 4, 5, 6])],
      citations,
      groupBy: 'alpha',
      page: 1,
      pageSize: 50,
      lang: 'en',
    });

    expect(page.groups.map((g) => g.key)).toEqual([
      'A',
      'B',
      'Z',
      'Æ',
      'Ø',
      'Å',
    ]);
    expect(page.buckets.map((b) => b.key)).toEqual(['A', 'B', 'Z', 'Æ', 'Ø', 'Å']);
  });

  it('sorts by first-author surname, with authorless sources last', () => {
    const citations = citationMap([
      authored(1, 'Postmortem redistribution', ['Ødegaard K', 'Andersen B']),
      authored(2, 'Ethanol elimination', ['Axelsson P']),
      authored(3, 'Diazepam kinetics', ['Andersen B', 'Huertas T']),
      citation(4, 'ISO 17025 accreditation'),
      authored(5, 'Benzodiazepine screening', ['Huertas T']),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3, 4, 5])],
      citations,
      groupBy: 'author',
      page: 1,
      pageSize: 50,
    });

    expect(page.groups.map((g) => g.key)).toEqual(['A', 'H', 'Ø', 'unknown']);
    // Within A the bucket only fixes the initial — Andersen still sorts ahead
    // of Axelsson — and the catch-all bucket carries no letter to label itself.
    expect(page.groups[0]!.references.map((r) => r.id)).toEqual([3, 2]);
    expect(page.groups[3]!.label).toBeNull();
    expect(page.groups.every((g) => g.kind === 'author')).toBe(true);
  });

  it('breaks an author tie with the title, not insertion order', () => {
    const citations = citationMap([
      authored(1, 'Zolpidem in blood', ['Huertas T']),
      authored(2, 'Amphetamine in blood', ['Huertas T', 'Aasen B']),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2])],
      citations,
      groupBy: 'author',
      page: 1,
      pageSize: 50,
    });

    expect(page.groups[0]!.references.map((r) => r.id)).toEqual([2, 1]);
  });

  it('sorts years newest first and parks undated sources at the end', () => {
    const citations = citationMap([
      citation(1, 'Old', 1998),
      citation(2, 'New', 2024),
      citation(3, 'Undated'),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3])],
      citations,
      groupBy: 'year',
      page: 1,
      pageSize: 50,
    });

    expect(page.groups.map((g) => g.key)).toEqual(['2024', '1998', 'unknown']);
    expect(page.groups[2]!.label).toBeNull();
  });

  it('splits a bucket across pages while keeping its full count', () => {
    const rows = [1, 2, 3, 4, 5].map((id) => citation(id, `Title ${id}`, 2020));
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3, 4, 5])],
      citations: citationMap(rows),
      groupBy: 'year',
      page: 2,
      pageSize: 2,
    });

    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(3);
    expect(page.rangeStart).toBe(3);
    expect(page.rangeEnd).toBe(4);
    expect(page.groups[0]!.references.map((r) => r.id)).toEqual([3, 4]);
    expect(page.groups[0]!.totalReferences).toBe(5);
  });

  it('clamps a page number past the end back onto the last page', () => {
    const rows = [1, 2, 3].map((id) => citation(id, `Title ${id}`));
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2, 3])],
      citations: citationMap(rows),
      groupBy: 'alpha',
      page: 99,
      pageSize: 2,
    });

    expect(page.page).toBe(2);
    expect(page.groups[0]!.references.map((r) => r.id)).toEqual([3]);
  });

  it('narrows to one bucket but still returns the whole jump index', () => {
    const citations = citationMap([
      citation(1, 'Absorption'),
      citation(2, 'Binding'),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2])],
      citations,
      groupBy: 'alpha',
      bucket: 'B',
      page: 1,
      pageSize: 50,
    });

    expect(page.bucket).toBe('B');
    expect(page.totalRows).toBe(1);
    expect(page.groups[0]!.references.map((r) => r.id)).toEqual([2]);
    expect(page.buckets.map((b) => b.key)).toEqual(['A', 'B']);
  });

  it('sorts rather than throwing when handed a malformed locale', () => {
    const citations = citationMap([
      citation(2, 'Binding'),
      citation(1, 'Absorption'),
    ]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1, 2])],
      citations,
      groupBy: 'alpha',
      page: 1,
      pageSize: 50,
      lang: 'en_US',
    });

    expect(page.groups.map((g) => g.key)).toEqual(['A', 'B']);
  });

  it('ignores a bucket that matches nothing rather than showing an empty page', () => {
    const citations = citationMap([citation(1, 'Absorption')]);
    const page = buildReferenceIndexPage({
      owners: [drugOwner(1, 'Diazepam', [1])],
      citations,
      groupBy: 'alpha',
      bucket: 'Q',
      page: 1,
      pageSize: 50,
    });

    expect(page.bucket).toBeNull();
    expect(page.totalRows).toBe(1);
  });
});
