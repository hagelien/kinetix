import { describe, expect, it } from 'vitest';
import {
  applyAddSection,
  applyEditSection,
  applyRemoveSection,
  applyReorderSection,
  clearSectionFacts,
  countSectionBodyNodes,
} from '../topicSectionOps';
import type { TipTapDoc } from '../monographContent';

function heading(text: string, sectionId: string, level = 2): unknown {
  return {
    type: 'heading',
    attrs: { level, sectionId },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string): unknown {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function fact(factId: string, statement: string): unknown {
  return {
    type: 'fact',
    attrs: { factId, referenceIds: [1] },
    content: [{ type: 'text', text: statement }],
  };
}

function buildDoc(nodes: unknown[]): TipTapDoc {
  return { type: 'doc', content: nodes };
}

describe('applyAddSection', () => {
  it('adds a new section at the requested position and mints a slug', () => {
    const doc = buildDoc([
      heading('Pharmacology', 'pharmacology'),
      heading('Toxicity', 'toxicity'),
    ]);
    const { doc: out, sectionId } = applyAddSection(doc, {
      headingText: 'Half-life',
      headingLevel: 2,
      position: 1,
    });
    expect(sectionId).toBe('half-life');
    const ids = (out.content as Array<Record<string, unknown>>)
      .filter((n) => n.type === 'heading')
      .map((n) => (n.attrs as { sectionId: string }).sectionId);
    expect(ids).toEqual(['pharmacology', 'half-life', 'toxicity']);
  });

  it('appends past-the-end positions at the document tail', () => {
    const doc = buildDoc([heading('Pharmacology', 'pharmacology')]);
    const { doc: out } = applyAddSection(doc, {
      headingText: 'Notes',
      headingLevel: 2,
      position: 99,
    });
    const last = (out.content as Array<{ attrs?: { sectionId?: string } }>).at(-1);
    expect(last?.attrs?.sectionId).toBe('notes');
  });

  it('mints a collision-free id when the slug already exists', () => {
    const doc = buildDoc([heading('Notes', 'notes')]);
    const { sectionId } = applyAddSection(doc, {
      headingText: 'Notes',
      headingLevel: 2,
      position: 0,
    });
    expect(sectionId).toBe('notes-2');
  });

  it('rejects empty headings and out-of-range levels', () => {
    const doc = buildDoc([]);
    expect(() =>
      applyAddSection(doc, { headingText: '   ', headingLevel: 2, position: 0 }),
    ).toThrow(/headingText/);
    expect(() =>
      applyAddSection(doc, {
        headingText: 'X',
        headingLevel: 9 as never,
        position: 0,
      }),
    ).toThrow(/headingLevel/);
  });

  it('preserves preamble content (anything before the first sectioned heading)', () => {
    const doc = buildDoc([
      paragraph('Intro prose by an admin'),
      heading('Pharmacology', 'pharmacology'),
    ]);
    const { doc: out } = applyAddSection(doc, {
      headingText: 'Notes',
      headingLevel: 2,
      position: 0,
    });
    const top = out.content as Array<{ type?: string }>;
    expect(top[0]?.type).toBe('paragraph');
    expect(top[1]).toMatchObject({ type: 'heading', attrs: { sectionId: 'notes' } });
  });
});

describe('applyEditSection', () => {
  it('renames the heading text but preserves sectionId and section body', () => {
    const doc = buildDoc([
      heading('Pharmacology', 'pharmacology'),
      fact('f1', 'It is metabolized by CYP3A4'),
    ]);
    const out = applyEditSection(doc, {
      sectionId: 'pharmacology',
      headingText: 'Pharmacology & ADME',
    });
    const top = out.content as Array<Record<string, unknown>>;
    expect(top[0]).toMatchObject({
      type: 'heading',
      attrs: { sectionId: 'pharmacology' },
    });
    expect(
      (top[0] as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe('Pharmacology & ADME');
    expect(top[1]).toMatchObject({ type: 'fact', attrs: { factId: 'f1' } });
  });

  it('throws when the section is missing', () => {
    const doc = buildDoc([heading('Pharmacology', 'pharmacology')]);
    expect(() =>
      applyEditSection(doc, {
        sectionId: 'toxicity',
        headingText: 'Toxicity',
      }),
    ).toThrow(/not found/);
  });

  it('rejects empty heading text', () => {
    const doc = buildDoc([heading('Pharmacology', 'pharmacology')]);
    expect(() =>
      applyEditSection(doc, { sectionId: 'pharmacology', headingText: '   ' }),
    ).toThrow(/headingText/);
  });
});

describe('applyReorderSection', () => {
  it('moves the heading and its body slice together', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      fact('a-1', 'fact in A'),
      heading('B', 'b'),
      fact('b-1', 'fact in B'),
      heading('C', 'c'),
    ]);
    const out = applyReorderSection(doc, { sectionId: 'a', position: 2 });
    const top = out.content as Array<Record<string, unknown>>;
    const ids = top
      .filter((n) => n.type === 'heading')
      .map((n) => (n.attrs as { sectionId: string }).sectionId);
    expect(ids).toEqual(['b', 'c', 'a']);
    // A's fact still trails A after the move
    const aHeadingIdx = top.findIndex(
      (n) =>
        n.type === 'heading' &&
        (n.attrs as { sectionId: string }).sectionId === 'a',
    );
    expect(top[aHeadingIdx + 1]).toMatchObject({
      type: 'fact',
      attrs: { factId: 'a-1' },
    });
  });

  it('clamps positions past the section count to the end', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      heading('B', 'b'),
      heading('C', 'c'),
    ]);
    const out = applyReorderSection(doc, { sectionId: 'a', position: 99 });
    const ids = (out.content as Array<{ attrs?: { sectionId?: string } }>)
      .filter((n) => n.attrs?.sectionId)
      .map((n) => n.attrs!.sectionId);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('throws on unknown sectionId', () => {
    const doc = buildDoc([heading('A', 'a')]);
    expect(() =>
      applyReorderSection(doc, { sectionId: 'b', position: 0 }),
    ).toThrow(/not found/);
  });
});

describe('applyRemoveSection', () => {
  it('removes an empty section and leaves siblings intact', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      heading('B', 'b'),
      fact('b-1', 'fact'),
    ]);
    const out = applyRemoveSection(doc, { sectionId: 'a' });
    const ids = (out.content as Array<{ attrs?: { sectionId?: string } }>)
      .filter((n) => n.attrs?.sectionId)
      .map((n) => n.attrs!.sectionId);
    expect(ids).toEqual(['b']);
  });

  it('refuses to remove a non-empty section', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      fact('a-1', 'fact'),
      heading('B', 'b'),
    ]);
    expect(() => applyRemoveSection(doc, { sectionId: 'a' })).toThrow(
      /not empty/,
    );
  });

  it('throws on unknown sectionId', () => {
    const doc = buildDoc([heading('A', 'a')]);
    expect(() => applyRemoveSection(doc, { sectionId: 'x' })).toThrow(
      /not found/,
    );
  });
});

describe('countSectionBodyNodes', () => {
  it('returns the number of top-level nodes in the section body', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      fact('a-1', 'fact'),
      paragraph('extra prose'),
      heading('B', 'b'),
    ]);
    expect(countSectionBodyNodes(doc, 'a')).toBe(2);
    expect(countSectionBodyNodes(doc, 'b')).toBe(0);
    expect(countSectionBodyNodes(doc, 'missing')).toBe(0);
  });
});

describe('clearSectionFacts (#360)', () => {
  it('removes only fact nodes from the named section, leaves prose anchored', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      fact('a-1', 'fact 1'),
      paragraph('intro prose'),
      fact('a-2', 'fact 2'),
      heading('B', 'b'),
      fact('b-1', 'b fact'),
    ]);
    const out = clearSectionFacts(doc, 'a');
    const top = out.content as Array<{
      type?: string;
      attrs?: { sectionId?: string; factId?: string };
    }>;
    // A's facts gone, A's paragraph stays, B untouched.
    expect(top.map((n) => n.type)).toEqual(['heading', 'paragraph', 'heading', 'fact']);
    expect(top[2]?.attrs?.sectionId).toBe('b');
    expect(top[3]?.attrs?.factId).toBe('b-1');
  });

  it('throws when the section is missing', () => {
    const doc = buildDoc([heading('A', 'a')]);
    expect(() => clearSectionFacts(doc, 'missing')).toThrow(/not found/);
  });

  it('after clearSectionFacts, applyRemoveSection succeeds when only facts remain', () => {
    const doc = buildDoc([
      heading('A', 'a'),
      fact('a-1', 'fact'),
      heading('B', 'b'),
    ]);
    const cleared = clearSectionFacts(doc, 'a');
    const removed = applyRemoveSection(cleared, { sectionId: 'a' });
    const ids = (removed.content as Array<{ attrs?: { sectionId?: string } }>)
      .filter((n) => n.attrs?.sectionId)
      .map((n) => n.attrs!.sectionId);
    expect(ids).toEqual(['b']);
  });
});
