import { describe, expect, it } from 'vitest';
import {
  buildWikiPageTree,
  filterNonMonographPages,
  wikiSummaryPageUrl,
} from './WikiHome';

const base = {
  updatedAt: '2026-05-21T00:00:00.000Z',
};

describe('buildWikiPageTree', () => {
  it('nests topic and monograph pages under their parents', () => {
    const tree = buildWikiPageTree([
      {
        ...base,
        id: 3,
        slug: 'diazepam',
        title: 'Diazepam',
        pageType: 'drug_monograph',
        parentId: 1,
      },
      {
        ...base,
        id: 1,
        slug: 'sedatives',
        title: 'Sedatives',
        pageType: 'topic',
        parentId: null,
      },
      {
        ...base,
        id: 2,
        slug: 'benzodiazepines',
        title: 'Benzodiazepines',
        pageType: 'topic',
        parentId: 1,
      },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.slug).toBe('sedatives');
    expect(tree[0]?.children.map((node) => node.slug)).toEqual([
      'benzodiazepines',
      'diazepam',
    ]);
  });

  it('keeps orphaned child pages visible at the root', () => {
    const tree = buildWikiPageTree([
      {
        ...base,
        id: 2,
        slug: 'orphan',
        title: 'Orphan',
        pageType: 'topic',
        parentId: 999,
      },
    ]);

    expect(tree.map((node) => node.slug)).toEqual(['orphan']);
  });

  it('keeps cyclic parent references visible at the root', () => {
    const tree = buildWikiPageTree([
      {
        ...base,
        id: 1,
        slug: 'cycle-a',
        title: 'Cycle A',
        pageType: 'topic',
        parentId: 2,
      },
      {
        ...base,
        id: 2,
        slug: 'cycle-b',
        title: 'Cycle B',
        pageType: 'topic',
        parentId: 1,
      },
      {
        ...base,
        id: 3,
        slug: 'child',
        title: 'Child',
        pageType: 'topic',
        parentId: 1,
      },
    ]);

    expect(tree.map((node) => node.slug)).toEqual(['cycle-a', 'cycle-b']);
    expect(tree[0]?.children.map((node) => node.slug)).toEqual(['child']);
  });
});

describe('filterNonMonographPages', () => {
  it('drops drug monographs and keeps other page types', () => {
    const filtered = filterNonMonographPages([
      {
        ...base,
        id: 1,
        slug: 'morphine',
        title: 'Morphine',
        pageType: 'drug_monograph',
        parentId: null,
      },
      {
        ...base,
        id: 2,
        slug: 'sedatives',
        title: 'Sedatives',
        pageType: 'topic',
        parentId: null,
      },
      {
        ...base,
        id: 3,
        slug: 'about',
        title: 'About',
        pageType: 'article',
        parentId: null,
      },
    ]);

    expect(filtered.map((page) => page.slug)).toEqual(['sedatives', 'about']);
  });
});

describe('wikiSummaryPageUrl', () => {
  it('requests non-monograph summary rows only', () => {
    expect(wikiSummaryPageUrl(400)).toBe(
      '/api/wiki/pages?limit=200&offset=400&view=summary&excludePageType=drug_monograph',
    );
  });
});
