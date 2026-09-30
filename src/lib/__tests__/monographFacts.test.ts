import { describe, expect, it } from 'vitest';
import {
  appendFactToField,
  appendFactToSection,
  applyFactOp,
  createFactNode,
  emptyMonographContentV2,
  findFactInContent,
  isFactNode,
  removeFactFromSection,
  replaceFactInSection,
  setFieldBody,
  type MonographContentV2,
  type TipTapDoc,
} from '../monographContent';

const FACT_A = createFactNode({
  factId: 'aaaa',
  statement: 'Morfin er en full agonist på μ-opioidreseptoren',
  referenceIds: [12, 34],
});

const FACT_B = createFactNode({
  factId: 'bbbb',
  statement: 'Halveringstiden er 2-4 timer',
  referenceIds: [99],
});

describe('createFactNode + isFactNode', () => {
  it('builds a well-formed fact node', () => {
    expect(isFactNode(FACT_A)).toBe(true);
    expect(FACT_A.attrs.factId).toBe('aaaa');
    expect(FACT_A.attrs.referenceIds).toEqual([12, 34]);
    expect(FACT_A.content).toHaveLength(1);
  });

  it('rejects non-fact shapes', () => {
    expect(isFactNode(null)).toBe(false);
    expect(isFactNode({ type: 'paragraph' })).toBe(false);
    expect(isFactNode({ type: 'fact' })).toBe(false);
    expect(
      isFactNode({ type: 'fact', attrs: { factId: 1, referenceIds: [] } }),
    ).toBe(false);
  });

  it('clones referenceIds so callers cannot mutate the array in place', () => {
    const refs = [1, 2];
    const fact = createFactNode({
      factId: 'x',
      statement: 's',
      referenceIds: refs,
    });
    refs.push(3);
    expect(fact.attrs.referenceIds).toEqual([1, 2]);
  });

  it('preserves sanitized rich paragraph content supplied by the API', () => {
    const content: unknown[] = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          {
            type: 'text',
            text: 'morphine',
            marks: [{ type: 'link', attrs: { href: '/wiki/morphine' } }],
          },
        ],
      },
    ];
    const fact = createFactNode({
      factId: 'x',
      statement: 'See morphine',
      referenceIds: [1],
      content,
    });
    expect(fact.content).toEqual(content);
    content[0] = { type: 'paragraph' };
    expect(fact.content).not.toEqual(content);
  });
});

describe('appendFactToSection', () => {
  it('creates a body when none exists', () => {
    const next = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    expect(next.sections.pd?.body?.content).toEqual([FACT_A]);
  });

  it('appends to the end of existing body content', () => {
    const seed = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    const next = appendFactToSection(seed, 'pd', FACT_B);
    expect(next.sections.pd?.body?.content).toEqual([FACT_A, FACT_B]);
  });

  it('does not mutate the input envelope', () => {
    const seed = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    appendFactToSection(seed, 'pd', FACT_B);
    expect(seed.sections.pd?.body?.content).toEqual([FACT_A]);
  });
});

describe('findFactInContent', () => {
  it('locates a fact in a section body', () => {
    const c = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    expect(findFactInContent(c, 'aaaa')).toEqual({ sectionId: 'pd', index: 0 });
  });

  it('preserves the physical location for retired field facts', () => {
    const fieldDoc: TipTapDoc = { type: 'doc', content: [FACT_B] };
    const c: MonographContentV2 = setFieldBody(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      fieldDoc,
    );
    expect(findFactInContent(c, 'bbbb')).toEqual({
      sectionId: 'effects',
      fieldId: 'cardiovascular',
      index: 0,
    });
  });

  it('returns null for unknown ids', () => {
    expect(findFactInContent(emptyMonographContentV2(), 'missing')).toBeNull();
  });
});

describe('replaceFactInSection', () => {
  it('replaces in place, preserving other facts and order', () => {
    let c = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    c = appendFactToSection(c, 'pd', FACT_B);
    const replacement = createFactNode({
      factId: 'aaaa',
      statement: 'Updated claim',
      referenceIds: [12],
    });
    const next = replaceFactInSection(c, 'aaaa', replacement);
    expect(next.sections.pd?.body?.content).toEqual([replacement, FACT_B]);
  });

  it('throws when the fact is missing', () => {
    const replacement = createFactNode({
      factId: 'nope',
      statement: 's',
      referenceIds: [1],
    });
    expect(() =>
      replaceFactInSection(emptyMonographContentV2(), 'nope', replacement),
    ).toThrow(/Fact not found/);
  });

  it('throws when the replacement carries a different factId', () => {
    const c = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    // Caller mistake: built the replacement with a fresh id rather than
    // reusing the target's. Without this guard the original anchor would
    // silently disappear and any other pending edits referencing it would
    // start failing to locate the fact.
    expect(() => replaceFactInSection(c, 'aaaa', FACT_B)).toThrow(
      /does not match target/,
    );
  });
});

describe('removeFactFromSection', () => {
  it('removes the matching fact and keeps siblings', () => {
    let c = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    c = appendFactToSection(c, 'pd', FACT_B);
    const next = removeFactFromSection(c, 'aaaa');
    expect(next.sections.pd?.body?.content).toEqual([FACT_B]);
  });

  it('drops the body entirely when removing the last child', () => {
    const c = appendFactToSection(emptyMonographContentV2(), 'pd', FACT_A);
    const next = removeFactFromSection(c, 'aaaa');
    expect(next.sections.pd?.body).toBeUndefined();
  });

  it('drops the field entirely when removing its last child', () => {
    const fieldDoc: TipTapDoc = { type: 'doc', content: [FACT_A] };
    let c = setFieldBody(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      fieldDoc,
    );
    c = removeFactFromSection(c, 'aaaa');
    expect(c.sections.effects?.fields).toBeUndefined();
  });

  it('throws when the fact is missing', () => {
    expect(() =>
      removeFactFromSection(emptyMonographContentV2(), 'nope'),
    ).toThrow(/Fact not found/);
  });
});

describe('appendFactToField', () => {
  it('creates the field and its body when neither exists yet', () => {
    const next = appendFactToField(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      FACT_A,
    );
    expect(
      next.sections.effects?.fields?.cardiovascular?.body?.content,
    ).toEqual([FACT_A]);
  });

  it('appends to an existing field body', () => {
    const seed = appendFactToField(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      FACT_A,
    );
    const next = appendFactToField(seed, 'effects', 'cardiovascular', FACT_B);
    expect(
      next.sections.effects?.fields?.cardiovascular?.body?.content,
    ).toEqual([FACT_A, FACT_B]);
  });
});

describe('applyFactOp', () => {
  it('dispatches add to the section body when no fieldId is set', () => {
    const next = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pd' },
      FACT_A,
    );
    expect(next.sections.pd?.body?.content).toEqual([FACT_A]);
  });

  it('dispatches add to the parent section when a retired fieldId is set', () => {
    const next = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'effects', fieldId: 'cardiovascular' },
      FACT_A,
    );
    expect(next.sections.effects?.body?.content).toEqual([FACT_A]);
    expect(next.sections.effects?.fields).toBeUndefined();
  });

  it('dispatches replace and preserves the surrounding fact', () => {
    let c = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pd' },
      FACT_A,
    );
    c = applyFactOp(c, 'add', { sectionId: 'pd' }, FACT_B);
    const replacement = createFactNode({
      factId: 'aaaa',
      statement: 'Updated',
      referenceIds: [12],
    });
    const next = applyFactOp(
      c,
      'replace',
      { sectionId: 'pd', factId: 'aaaa' },
      replacement,
    );
    expect(next.sections.pd?.body?.content).toEqual([replacement, FACT_B]);
  });

  it('dispatches remove and prunes the empty body', () => {
    const c = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pd' },
      FACT_A,
    );
    const next = applyFactOp(
      c,
      'remove',
      { sectionId: 'pd', factId: 'aaaa' },
      null,
    );
    expect(next.sections.pd?.body).toBeUndefined();
  });

  it('upserts when the target factId is already present in the section', () => {
    const seeded = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pd' },
      FACT_A,
    );
    const revised = createFactNode({
      factId: FACT_A.attrs.factId,
      statement: 'Revised by an approved edit',
      referenceIds: [7],
    });
    const next = applyFactOp(seeded, 'add', { sectionId: 'pd' }, revised);
    expect(next.sections.pd?.body?.content).toEqual([revised]);
  });

  it('upserts in place when the fact was moved to another section', () => {
    // An admin filed the fact under `pk`; the queued edit targets `pd`.
    // Appending into `pd` would duplicate it, so the existing node is
    // updated where it sits rather than relocated.
    const seeded = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pk' },
      FACT_A,
    );
    const revised = createFactNode({
      factId: FACT_A.attrs.factId,
      statement: 'Revised by an approved edit',
      referenceIds: [7],
    });
    const next = applyFactOp(seeded, 'add', { sectionId: 'pd' }, revised);
    expect(next.sections.pk?.body?.content).toEqual([revised]);
    expect(next.sections.pd).toBeUndefined();
  });

  it('still appends when the section is absent, which is every first fact', () => {
    // `normalizeMonographContentV2` prunes empty sections, so an absent
    // section is indistinguishable from one an admin emptied. The upsert
    // above must not turn that into a refusal.
    const next = applyFactOp(
      emptyMonographContentV2(),
      'add',
      { sectionId: 'pd' },
      FACT_A,
    );
    expect(next.sections.pd?.body?.content).toEqual([FACT_A]);
  });

  it('throws on missing arguments per op', () => {
    expect(() =>
      applyFactOp(emptyMonographContentV2(), 'add', { sectionId: 'pd' }, null),
    ).toThrow(/add requires a fact node/);
    expect(() =>
      applyFactOp(
        emptyMonographContentV2(),
        'replace',
        { sectionId: 'pd' },
        FACT_A,
      ),
    ).toThrow(/replace requires target.factId/);
    expect(() =>
      applyFactOp(
        emptyMonographContentV2(),
        'remove',
        { sectionId: 'pd' },
        null,
      ),
    ).toThrow(/remove requires target.factId/);
  });
});
