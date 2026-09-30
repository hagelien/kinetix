import { describe, expect, it } from 'vitest';
import { extractConvertibleProse } from '../topicProseConversion';

const para = (text: string, extra: unknown[] = []) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }, ...extra],
});

const footnote = (referenceId: number) => ({
  type: 'footnote',
  attrs: { referenceId },
});

describe('extractConvertibleProse', () => {
  it('returns one entry per non-empty top-level paragraph', () => {
    const body = [para('First claim.'), para('Second claim.')];
    const result = extractConvertibleProse(body);
    expect(result.map((p) => p.text)).toEqual(['First claim.', 'Second claim.']);
    // index tracks the position within bodyContent
    expect(result.map((p) => p.index)).toEqual([0, 1]);
  });

  it('skips empty / whitespace-only paragraphs', () => {
    const body = [
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
      para('Real content.'),
    ];
    const result = extractConvertibleProse(body);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('Real content.');
    expect(result[0]?.index).toBe(2);
  });

  it('ignores fact nodes, lists, tables and images', () => {
    const body = [
      { type: 'fact', attrs: { factId: 'abc' } },
      { type: 'bulletList', content: [] },
      { type: 'image', attrs: { src: 'x.png' } },
      para('Only this is convertible.'),
    ];
    const result = extractConvertibleProse(body);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('Only this is convertible.');
  });

  it('collapses internal whitespace and excludes footnote markers from text', () => {
    const body = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Half-life   is\n4 h' },
          footnote(42),
        ],
      },
    ];
    const [entry] = extractConvertibleProse(body);
    expect(entry?.text).toBe('Half-life is 4 h');
  });

  it('harvests and de-duplicates citation ids from inline footnotes', () => {
    const body = [para('Claim.', [footnote(7), footnote(7), footnote(9)])];
    const [entry] = extractConvertibleProse(body);
    expect(entry?.referenceIds).toEqual([7, 9]);
  });

  it('strips footnote nodes from the editor content but keeps the prose', () => {
    const body = [para('Claim with cite.', [footnote(3)])];
    const [entry] = extractConvertibleProse(body);
    expect(entry?.content).toHaveLength(1);
    const block = entry?.content[0] as { type: string; content: unknown[] };
    expect(block.type).toBe('paragraph');
    expect(block.content).toEqual([{ type: 'text', text: 'Claim with cite.' }]);
  });

  it('tolerates null / non-array input', () => {
    expect(extractConvertibleProse(null)).toEqual([]);
    expect(extractConvertibleProse(undefined)).toEqual([]);
    expect(extractConvertibleProse([])).toEqual([]);
  });
});
