import { describe, expect, it } from 'vitest';
import {
  extractTopicSections,
  isValidTopicSectionId,
  listTopicSectionIds,
  mintTopicSectionIds,
  mintUniqueSectionId,
  slugifyHeadingText,
} from '../topicSections';

describe('slugifyHeadingText', () => {
  it('lowercases, kebab-cases, and strips punctuation', () => {
    expect(slugifyHeadingText('Pharmacokinetics')).toBe('pharmacokinetics');
    expect(slugifyHeadingText('Half-life & metabolism')).toBe('half-life-metabolism');
    expect(slugifyHeadingText('  Trailing spaces  ')).toBe('trailing-spaces');
  });

  it('strips diacritics so Norwegian/Swedish headings stay readable', () => {
    expect(slugifyHeadingText('Bør tas på fastende mage')).toBe('bor-tas-pa-fastende-mage');
    expect(slugifyHeadingText('Cåfé')).toBe('cafe');
  });

  it('falls back to "section" when the input has no slug-able characters', () => {
    expect(slugifyHeadingText('???')).toBe('section');
    expect(slugifyHeadingText('')).toBe('section');
  });

  it('truncates to the API sectionId length cap (40 chars) so the schema accepts the result', () => {
    const long = 'a'.repeat(120);
    expect(slugifyHeadingText(long).length).toBeLessThanOrEqual(40);
  });
});

describe('mintUniqueSectionId — long-base collisions', () => {
  it('keeps the suffixed result within the 40-char API cap', () => {
    const taken = new Set<string>();
    const long = 'a'.repeat(60);
    const first = mintUniqueSectionId(long, taken);
    const second = mintUniqueSectionId(long, taken);
    expect(first.length).toBeLessThanOrEqual(40);
    expect(second.length).toBeLessThanOrEqual(40);
    expect(second).not.toBe(first);
    expect(/^[a-z0-9](?:[a-z0-9-]{0,39})$/.test(second)).toBe(true);
  });
});

describe('mintUniqueSectionId', () => {
  it('returns the bare slug when nothing collides', () => {
    const taken = new Set<string>();
    expect(mintUniqueSectionId('Pharmacology', taken)).toBe('pharmacology');
    expect(taken.has('pharmacology')).toBe(true);
  });

  it('appends numeric suffixes on collision and keeps the run unique', () => {
    const taken = new Set<string>(['pharmacology']);
    expect(mintUniqueSectionId('Pharmacology', taken)).toBe('pharmacology-2');
    expect(mintUniqueSectionId('Pharmacology', taken)).toBe('pharmacology-3');
    expect(taken.size).toBe(3);
  });
});

describe('isValidTopicSectionId', () => {
  it('accepts what slugifyHeadingText produces', () => {
    expect(isValidTopicSectionId('pharmacology')).toBe(true);
    expect(isValidTopicSectionId('half-life-metabolism')).toBe(true);
    expect(isValidTopicSectionId('section-2')).toBe(true);
  });

  it('rejects empty, leading-dash, uppercase, or whitespace-bearing ids', () => {
    expect(isValidTopicSectionId('')).toBe(false);
    expect(isValidTopicSectionId('-leading')).toBe(false);
    expect(isValidTopicSectionId('Mixed-Case')).toBe(false);
    expect(isValidTopicSectionId('has space')).toBe(false);
  });
});

describe('extractTopicSections', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Pre-heading prose' }] },
      {
        type: 'heading',
        attrs: { level: 1, sectionId: 'intro' },
        content: [{ type: 'text', text: 'Intro' }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Intro body' }] },
      {
        type: 'heading',
        attrs: { level: 2, sectionId: 'pharmacology' },
        content: [{ type: 'text', text: 'Pharmacology' }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'Pharma body' }] },
      // Heading without a sectionId falls inside the parent section's body.
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'More body' }] },
    ],
  };

  it('returns one entry per top-level heading carrying a sectionId', () => {
    const sections = extractTopicSections(doc);
    expect(sections.map((s) => s.sectionId)).toEqual(['intro', 'pharmacology']);
    expect(sections[0]?.headingText).toBe('Intro');
    expect(sections[0]?.headingLevel).toBe(1);
    expect(sections[0]?.bodyContent).toHaveLength(1);
  });

  it('groups everything between sectioned headings into the prior section body', () => {
    const sections = extractTopicSections(doc);
    expect(sections[1]?.bodyContent).toHaveLength(3); // paragraph + h3 + paragraph
  });

  it('drops pre-heading content (no section to anchor it)', () => {
    const sections = extractTopicSections(doc);
    const first = sections[0];
    expect(first?.bodyContent.some((n) => (n as { text?: string }).text === 'Pre-heading prose')).toBe(false);
  });

  it('returns an empty list for docs with no sectioned headings', () => {
    expect(extractTopicSections({ content: [] })).toEqual([]);
    expect(extractTopicSections(null)).toEqual([]);
    expect(
      extractTopicSections({ content: [{ type: 'heading', attrs: { level: 1 }, content: [] }] }),
    ).toEqual([]);
  });
});

describe('listTopicSectionIds', () => {
  it('returns the sectionIds in document order', () => {
    expect(
      listTopicSectionIds({
        content: [
          { type: 'heading', attrs: { sectionId: 'a', level: 1 }, content: [] },
          { type: 'heading', attrs: { sectionId: 'b', level: 1 }, content: [] },
        ],
      }),
    ).toEqual(['a', 'b']);
  });
});

describe('mintTopicSectionIds (migration)', () => {
  it('mints slugs into headings missing a sectionId', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Pharmacology' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Half-life' }] },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(result.changed).toBe(true);
    const ids = listTopicSectionIds(result.doc);
    expect(ids).toEqual(['pharmacology', 'half-life']);
  });

  it('is idempotent — already-sectioned headings skip the mint', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, sectionId: 'pre-existing' },
          content: [{ type: 'text', text: 'Pharmacology' }],
        },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(doc);
  });

  it('avoids collisions when two headings slugify to the same base', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Notes' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Notes' }] },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(listTopicSectionIds(result.doc)).toEqual(['notes', 'notes-2']);
  });

  it('respects existing sectionIds during collision avoidance', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, sectionId: 'notes' }, content: [{ type: 'text', text: 'Notes' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Notes' }] },
      ],
    };
    expect(listTopicSectionIds(mintTopicSectionIds(doc).doc)).toEqual(['notes', 'notes-2']);
  });

  it('remints subsequent duplicates of an existing sectionId (paste / clone)', () => {
    // Admin duplicates a heading carrying the same data-section-id, or
    // pastes content with a sectionId that already exists earlier in
    // the doc. The first occurrence keeps the id; the duplicate gets a
    // fresh one so applyTopicFactOp can still reach both sections.
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, sectionId: 'overview' }, content: [{ type: 'text', text: 'Overview' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'heading', attrs: { level: 1, sectionId: 'overview' }, content: [{ type: 'text', text: 'Overview' }] },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(result.changed).toBe(true);
    const ids = listTopicSectionIds(result.doc);
    expect(ids).toEqual(['overview', 'overview-2']);
  });

  it('remints existing sectionIds that fail the API validity pattern', () => {
    // Pasted / imported content can carry data-section-id values that
    // TopicSectionsEditor would still render, but the API would reject
    // every fact submission against (uppercase, spaces, too long, ...).
    // Treat them like missing ids and mint a fresh one from the
    // heading text.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, sectionId: 'Has Spaces' },
          content: [{ type: 'text', text: 'Has Spaces' }],
        },
        {
          type: 'heading',
          attrs: { level: 1, sectionId: 'A'.repeat(60) },
          content: [{ type: 'text', text: 'Too long' }],
        },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(result.changed).toBe(true);
    const ids = listTopicSectionIds(result.doc);
    expect(ids).toEqual(['has-spaces', 'too-long']);
    for (const id of ids) {
      expect(isValidTopicSectionId(id)).toBe(true);
    }
  });

  it('keeps later existing sectionIds stable when a new heading is inserted above', () => {
    // Admin inserts a new "Overview" heading above an existing
    // "Overview" section that already has sectionId="overview" (and
    // pending facts anchored to it). The original section must keep
    // its id; the new (id-less) heading gets a fresh slug.
    const doc = {
      type: 'doc',
      content: [
        // No sectionId — newly inserted by the admin.
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Overview' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'new body' }] },
        // Existing section with anchored facts.
        {
          type: 'heading',
          attrs: { level: 1, sectionId: 'overview' },
          content: [{ type: 'text', text: 'Overview' }],
        },
      ],
    };
    const result = mintTopicSectionIds(doc);
    expect(listTopicSectionIds(result.doc)).toEqual(['overview-2', 'overview']);
  });

  it('returns a stable shape on null/empty input', () => {
    expect(mintTopicSectionIds(null).changed).toBe(false);
    expect(mintTopicSectionIds({ content: [] }).changed).toBe(false);
  });
});
