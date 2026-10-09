import { describe, expect, it } from 'vitest';
import { wikiSectionSiblingConflictIds } from '../../api/_lib/pending-edits-helpers';

const fact = (id: number, sectionId: string) => ({
  id,
  editType: 'wiki_fact',
  sectionId,
  operation: null,
});
const section = (id: number, operation: string, sectionId: string | null) => ({
  id,
  editType: 'wiki_section',
  sectionId,
  operation,
});

describe('wikiSectionSiblingConflictIds', () => {
  const siblings = [
    fact(1, 'sec-a'),
    fact(2, 'sec-b'),
    section(3, 'edit', 'sec-a'),
    section(4, 'edit', 'sec-b'),
    section(5, 'add', null),
    section(6, 'reorder', 'sec-b'),
    section(7, 'remove', 'sec-a'),
  ];

  it('leaves pending facts alone when a section is renamed', () => {
    expect(
      wikiSectionSiblingConflictIds({ operation: 'edit', sectionId: 'sec-a' }, siblings),
    ).toEqual([3, 7]);
  });

  it('leaves pending facts alone when a section is added', () => {
    expect(
      wikiSectionSiblingConflictIds({ operation: 'add', sectionId: null }, siblings),
    ).toEqual([5, 6]);
  });

  it('leaves pending facts alone when a section is moved', () => {
    expect(
      wikiSectionSiblingConflictIds({ operation: 'reorder', sectionId: 'sec-a' }, siblings),
    ).toEqual([5, 6]);
  });

  it('flags only facts and section ops on a removed section', () => {
    expect(
      wikiSectionSiblingConflictIds({ operation: 'remove', sectionId: 'sec-a' }, siblings),
    ).toEqual([1, 3, 5, 6, 7]);
  });
});
