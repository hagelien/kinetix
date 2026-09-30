import { describe, expect, it } from 'vitest';
import { applyTopicFactOp } from '../topicFactOps';
import { createFactNode, type TipTapDoc } from '../monographContent';

function topicDoc(headings: Array<{ id: string; text: string; bodyText?: string }>): TipTapDoc {
  const content: unknown[] = [];
  for (const h of headings) {
    content.push({
      type: 'heading',
      attrs: { level: 2, sectionId: h.id },
      content: [{ type: 'text', text: h.text }],
    });
    if (h.bodyText) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: h.bodyText }],
      });
    }
  }
  return { type: 'doc', content };
}

const FACT_A = createFactNode({
  factId: 'aaaa',
  statement: 'First claim',
  referenceIds: [1],
});

const FACT_B = createFactNode({
  factId: 'bbbb',
  statement: 'Second claim',
  referenceIds: [2],
});

describe('applyTopicFactOp — add', () => {
  it('appends a fact at the end of the named section (before the next heading)', () => {
    const doc = topicDoc([
      { id: 'pharma', text: 'Pharmacology', bodyText: 'pharma body' },
      { id: 'use', text: 'Use', bodyText: 'use body' },
    ]);

    const next = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);

    const ids = (next.content ?? []).map((n) => {
      const node = n as { type?: string; attrs?: { sectionId?: string; factId?: string } };
      return node.attrs?.sectionId ?? node.attrs?.factId ?? node.type;
    });
    expect(ids).toEqual(['pharma', 'paragraph', 'aaaa', 'use', 'paragraph']);
  });

  it('appends to the end of the doc when the section is the final one', () => {
    const doc = topicDoc([{ id: 'only', text: 'Only', bodyText: 'body' }]);
    const next = applyTopicFactOp(doc, 'add', { sectionId: 'only' }, FACT_A);
    const last = (next.content ?? []).at(-1) as { attrs?: { factId?: string } };
    expect(last.attrs?.factId).toBe('aaaa');
  });

  it('throws when the sectionId is unknown', () => {
    const doc = topicDoc([{ id: 'pharma', text: 'P' }]);
    expect(() => applyTopicFactOp(doc, 'add', { sectionId: 'missing' }, FACT_A)).toThrow(
      /Section "missing" not found/,
    );
  });

  it('upserts in place when the section already carries the factId', () => {
    // A queued add can reach approval after the same fact was published by
    // hand. Appending blind would leave the section carrying it twice.
    const doc = topicDoc([
      { id: 'pharma', text: 'Pharmacology', bodyText: 'pharma body' },
      { id: 'use', text: 'Use' },
    ]);
    const seeded = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);
    const revised = createFactNode({
      factId: 'aaaa',
      statement: 'Revised claim',
      referenceIds: [9],
    });

    const next = applyTopicFactOp(seeded, 'add', { sectionId: 'pharma' }, revised);

    const facts = (next.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toEqual([revised]);
    // The upsert replaces the node at its slot; surrounding prose and the
    // following heading keep their positions.
    const ids = (next.content ?? []).map((n) => {
      const node = n as { type?: string; attrs?: { sectionId?: string; factId?: string } };
      return node.attrs?.sectionId ?? node.attrs?.factId ?? node.type;
    });
    expect(ids).toEqual(['pharma', 'paragraph', 'aaaa', 'use']);
  });

  it('appends when the same factId lives in a different section', () => {
    // Topic docs address facts by (sectionId, factId) — `replace` and `remove`
    // are both section-scoped — so the dedup is too. A fact in another section
    // is a different anchor, not an occupied one.
    const doc = topicDoc([
      { id: 'pharma', text: 'Pharmacology' },
      { id: 'use', text: 'Use' },
    ]);
    const seeded = applyTopicFactOp(doc, 'add', { sectionId: 'use' }, FACT_A);
    const next = applyTopicFactOp(seeded, 'add', { sectionId: 'pharma' }, FACT_A);
    const facts = (next.content ?? []).filter(
      (n) => (n as { type?: string }).type === 'fact',
    );
    expect(facts).toHaveLength(2);
  });
});

describe('applyTopicFactOp — replace', () => {
  it('swaps the matching fact in place', () => {
    const doc = topicDoc([{ id: 'pharma', text: 'P' }]);
    const seeded = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);

    const replacement = createFactNode({
      factId: 'aaaa',
      statement: 'Updated claim',
      referenceIds: [9],
    });
    const next = applyTopicFactOp(seeded, 'replace', { sectionId: 'pharma', factId: 'aaaa' }, replacement);

    const facts = (next.content ?? []).filter((n) => (n as { type?: string }).type === 'fact');
    expect(facts).toHaveLength(1);
    const fact = facts[0] as { attrs: { factId: string; referenceIds: number[] } };
    expect(fact.attrs.factId).toBe('aaaa');
    expect(fact.attrs.referenceIds).toEqual([9]);
  });

  it('throws when the factId is missing from the section', () => {
    const doc = topicDoc([{ id: 'pharma', text: 'P' }]);
    expect(() =>
      applyTopicFactOp(doc, 'replace', { sectionId: 'pharma', factId: 'nope' }, FACT_A),
    ).toThrow(/Fact "nope" not found/);
  });

  it("won't reach across sections to find the fact", () => {
    let doc = topicDoc([
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ]);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'a' }, FACT_A);
    expect(() =>
      applyTopicFactOp(doc, 'replace', { sectionId: 'b', factId: 'aaaa' }, FACT_B),
    ).toThrow(/Fact "aaaa" not found in section "b"/);
  });
});

describe('applyTopicFactOp — remove', () => {
  it('splices the fact out of the section', () => {
    let doc = topicDoc([{ id: 'pharma', text: 'P' }]);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_B);

    const next = applyTopicFactOp(doc, 'remove', { sectionId: 'pharma', factId: 'aaaa' }, null);
    const facts = (next.content ?? []).filter((n) => (n as { type?: string }).type === 'fact');
    expect(facts.map((f) => (f as { attrs: { factId: string } }).attrs.factId)).toEqual(['bbbb']);
  });
});

describe('applyTopicFactOp — contract violations', () => {
  it('rejects add without a fact node', () => {
    const doc = topicDoc([{ id: 'a', text: 'A' }]);
    expect(() => applyTopicFactOp(doc, 'add', { sectionId: 'a' }, null)).toThrow(/add op requires/);
  });

  it('rejects replace/remove without a factId', () => {
    const doc = topicDoc([{ id: 'a', text: 'A' }]);
    expect(() => applyTopicFactOp(doc, 'replace', { sectionId: 'a' }, FACT_A)).toThrow(
      /replace op requires a factId/,
    );
    expect(() => applyTopicFactOp(doc, 'remove', { sectionId: 'a' }, null)).toThrow(
      /remove op requires a factId/,
    );
  });
});

describe('applyTopicFactOp — reorder (#358)', () => {
  const FACT_C = createFactNode({
    factId: 'cccc',
    statement: 'Third claim',
    referenceIds: [3],
  });

  function seedThreeFacts(): TipTapDoc {
    let doc = topicDoc([{ id: 'pharma', text: 'P' }]);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_B);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_C);
    return doc;
  }

  function factOrder(doc: TipTapDoc): string[] {
    return (doc.content ?? [])
      .filter((n) => (n as { type?: string }).type === 'fact')
      .map((n) => (n as { attrs: { factId: string } }).attrs.factId);
  }

  it('moves a fact to the head of the section', () => {
    const doc = seedThreeFacts();
    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'cccc', position: 0 },
      null,
    );
    expect(factOrder(next)).toEqual(['cccc', 'aaaa', 'bbbb']);
  });

  it('moves a fact to the tail when position equals fact-count', () => {
    const doc = seedThreeFacts();
    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'aaaa', position: 2 },
      null,
    );
    expect(factOrder(next)).toEqual(['bbbb', 'cccc', 'aaaa']);
  });

  it('clamps a past-the-end position to the tail rather than throwing', () => {
    const doc = seedThreeFacts();
    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'aaaa', position: 99 },
      null,
    );
    expect(factOrder(next)).toEqual(['bbbb', 'cccc', 'aaaa']);
  });

  it('keeps non-fact siblings anchored when reordering facts', () => {
    // bodyText creates a paragraph between heading and the facts; the
    // reorder splice must not shuffle it.
    let doc = topicDoc([{ id: 'pharma', text: 'P', bodyText: 'intro prose' }]);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_A);
    doc = applyTopicFactOp(doc, 'add', { sectionId: 'pharma' }, FACT_B);

    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'bbbb', position: 0 },
      null,
    );

    // Expected layout: heading, paragraph (anchored), bbbb, aaaa.
    // The paragraph stays put; the facts swap relative order.
    const types = (next.content ?? []).map((n) => {
      const node = n as { type?: string; attrs?: { factId?: string } };
      return node.type === 'fact' ? `fact:${node.attrs?.factId}` : node.type;
    });
    expect(types).toEqual(['heading', 'paragraph', 'fact:bbbb', 'fact:aaaa']);
  });

  it('preserves prose BETWEEN facts when reordering (Codex review on #369)', () => {
    // Codex flagged that an array-splice approach moves prose nodes
    // sitting between facts out of their slot. Layout
    // `heading, factA, paragraph, factB` reordering factB to fact-pos 0
    // must produce `heading, factB, paragraph, factA` — the slot
    // structure is preserved (paragraph stays in the gap between the
    // first and second fact slots), only the fact identities rotate.
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, sectionId: 'pharma' },
          content: [{ type: 'text', text: 'P' }],
        },
        FACT_A,
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'between' }],
        },
        FACT_B,
      ],
    };

    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'bbbb', position: 0 },
      null,
    );

    const types = (next.content ?? []).map((n) => {
      const node = n as { type?: string; attrs?: { factId?: string } };
      return node.type === 'fact' ? `fact:${node.attrs?.factId}` : node.type;
    });
    expect(types).toEqual(['heading', 'fact:bbbb', 'paragraph', 'fact:aaaa']);
  });

  it('rejects fractional positions (Codex review on #369)', () => {
    const doc = seedThreeFacts();
    expect(() =>
      applyTopicFactOp(
        doc,
        'reorder',
        { sectionId: 'pharma', factId: 'aaaa', position: 0.5 },
        null,
      ),
    ).toThrow(/non-negative integer position/);
  });

  it('throws when the factId is missing from the section', () => {
    const doc = seedThreeFacts();
    expect(() =>
      applyTopicFactOp(
        doc,
        'reorder',
        { sectionId: 'pharma', factId: 'nope', position: 0 },
        null,
      ),
    ).toThrow(/Fact "nope" not found/);
  });

  it('rejects negative or non-integer positions', () => {
    const doc = seedThreeFacts();
    expect(() =>
      applyTopicFactOp(
        doc,
        'reorder',
        { sectionId: 'pharma', factId: 'aaaa', position: -1 },
        null,
      ),
    ).toThrow(/non-negative integer position/);
    expect(() =>
      applyTopicFactOp(
        doc,
        'reorder',
        { sectionId: 'pharma', factId: 'aaaa' },
        null,
      ),
    ).toThrow(/non-negative integer position/);
  });

  it('reorder to the same position is effectively a no-op', () => {
    const doc = seedThreeFacts();
    const next = applyTopicFactOp(
      doc,
      'reorder',
      { sectionId: 'pharma', factId: 'bbbb', position: 1 },
      null,
    );
    expect(factOrder(next)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });
});
