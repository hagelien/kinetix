import { describe, expect, it } from 'vitest';
import {
  emptyMonographContentV2,
  emptyTipTapDoc,
  extractCitationIds,
  getFieldBody,
  getSectionBody,
  hasLegacyProse,
  isMonographContentEmpty,
  isMonographContentV2,
  isTipTapDoc,
  isTipTapDocEmpty,
  iterateSectionBodies,
  monographHasContent,
  normalizeMonographContentV2,
  setFieldBody,
  setSectionBody,
  wrapV1AsV2,
  type MonographContentV2,
  type TipTapDoc,
} from '../monographContent';

const PARA_DOC: TipTapDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
  ],
};

const SECOND_DOC: TipTapDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Section two' }] },
  ],
};

describe('monograph content envelope (v2)', () => {
  it('detects v2 envelopes and rejects other shapes', () => {
    expect(isMonographContentV2({ version: 2, sections: {} })).toBe(true);
    expect(isMonographContentV2(emptyMonographContentV2())).toBe(true);
    expect(isMonographContentV2(PARA_DOC)).toBe(false);
    expect(isMonographContentV2(null)).toBe(false);
    expect(isMonographContentV2({ version: 2, sections: [] })).toBe(false);
    expect(isMonographContentV2({ version: 1, sections: {} })).toBe(false);
  });

  it('detects v1 TipTap docs', () => {
    expect(isTipTapDoc(PARA_DOC)).toBe(true);
    expect(isTipTapDoc({ type: 'doc' })).toBe(true);
    expect(isTipTapDoc({ type: 'paragraph' })).toBe(false);
  });

  it('treats empty paragraph docs as empty', () => {
    expect(isTipTapDocEmpty(emptyTipTapDoc())).toBe(true);
    expect(isTipTapDocEmpty({ type: 'doc' })).toBe(true);
    expect(isTipTapDocEmpty({ type: 'doc', content: [] })).toBe(true);
    expect(
      isTipTapDocEmpty({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
        ],
      }),
    ).toBe(true);
    expect(isTipTapDocEmpty(PARA_DOC)).toBe(false);
  });

  it('wraps v1 content under the first remaining section (pd), idempotent on v2', () => {
    const wrapped = wrapV1AsV2(PARA_DOC);
    expect(wrapped.version).toBe(2);
    expect(wrapped.sections.pd?.body).toEqual(PARA_DOC);

    const again = wrapV1AsV2(wrapped);
    expect(again).toEqual(wrapped);

    // Empty v1 collapses to an empty v2, not a v2 with an empty body.
    const emptyWrap = wrapV1AsV2(emptyTipTapDoc());
    expect(emptyWrap.sections.pd).toBeUndefined();
  });

  it('reads section bodies with retired fields merged into the parent', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: { body: PARA_DOC },
        effects: {
          fields: { cardiovascular: { body: SECOND_DOC } },
        },
        pk: { body: emptyTipTapDoc() },
      },
    };
    expect(getSectionBody(content, 'pd')).toEqual(PARA_DOC);
    expect(getSectionBody(content, 'effects')?.content).toEqual(
      SECOND_DOC.content,
    );
    expect(getSectionBody(content, 'pk')).toBeNull();
    expect(getSectionBody(content, 'forensic')).toBeNull();
    expect(getFieldBody(content, 'effects', 'cardiovascular')).toBe(SECOND_DOC);
    expect(getFieldBody(content, 'effects', 'no_such_field')).toBeNull();
  });

  it('normalizes retired sub-category field bodies into parent section bodies', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        effects: {
          body: PARA_DOC,
          fields: {
            psychiatric: { body: SECOND_DOC },
          },
        },
      },
    };
    const normalized = normalizeMonographContentV2(content);
    expect(normalized.sections.effects?.fields).toBeUndefined();
    expect(normalized.sections.effects?.body?.content).toEqual([
      ...(PARA_DOC.content ?? []),
      ...(SECOND_DOC.content ?? []),
    ]);
  });

  it('iterates non-empty bodies in declared section order', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        // Insertion order is reversed on purpose to verify the helper
        // re-orders by MONOGRAPH_SECTIONS, not by object key order.
        forensic: { body: SECOND_DOC },
        pd: { body: PARA_DOC },
        effects: {
          body: PARA_DOC,
          fields: {
            cardiovascular: { body: SECOND_DOC },
          },
        },
      },
    };
    const order = iterateSectionBodies(content).map((c) => ({
      sectionId: c.sectionId,
      fieldId: c.fieldId,
    }));
    expect(order).toEqual([
      { sectionId: 'pd', fieldId: undefined },
      { sectionId: 'effects', fieldId: undefined },
      { sectionId: 'forensic', fieldId: undefined },
    ]);
    expect(iterateSectionBodies(content)[1]?.body.content).toEqual([
      ...(PARA_DOC.content ?? []),
      ...(SECOND_DOC.content ?? []),
    ]);
  });

  it('setSectionBody returns a new envelope and removes empty bodies', () => {
    const a = emptyMonographContentV2();
    const b = setSectionBody(a, 'pd', PARA_DOC);
    expect(b).not.toBe(a);
    expect(a.sections.pd).toBeUndefined();
    expect(b.sections.pd?.body).toBe(PARA_DOC);
    const c = setSectionBody(b, 'pd', emptyTipTapDoc());
    expect(c.sections.pd?.body).toBeUndefined();
  });

  it('setFieldBody adds, replaces and prunes fields cleanly', () => {
    const a = setFieldBody(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      PARA_DOC,
    );
    expect(a.sections.effects?.fields?.cardiovascular?.body).toBe(PARA_DOC);
    const b = setFieldBody(a, 'effects', 'cardiovascular', null);
    expect(b.sections.effects?.fields).toBeUndefined();
  });

  it('setSectionBody drops retired fields after merging', () => {
    const withRetiredField = setFieldBody(
      emptyMonographContentV2(),
      'effects',
      'cardiovascular',
      PARA_DOC,
    );
    const next = setSectionBody(withRetiredField, 'effects', SECOND_DOC);
    expect(next.sections.effects?.fields).toBeUndefined();
    expect(next.sections.effects?.body).toBe(SECOND_DOC);
  });

  it('isMonographContentEmpty reports true only when nothing is authored', () => {
    expect(isMonographContentEmpty(emptyMonographContentV2())).toBe(true);
    const filled = setSectionBody(emptyMonographContentV2(), 'pd', PARA_DOC);
    expect(isMonographContentEmpty(filled)).toBe(false);
  });
});

describe('extractCitationIds', () => {
  it('returns an empty set for non-content shapes', () => {
    expect(extractCitationIds(null)).toEqual(new Set());
    expect(extractCitationIds(undefined)).toEqual(new Set());
    expect(extractCitationIds('not content')).toEqual(new Set());
    expect(extractCitationIds(emptyMonographContentV2())).toEqual(new Set());
  });

  it('collects fact node referenceIds from section bodies', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'fact',
                attrs: { factId: 'a', referenceIds: [12, 34] },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        },
      },
    };
    expect(extractCitationIds(content)).toEqual(new Set([12, 34]));
  });

  it('collects retired field-body fact refs after merging', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        effects: {
          fields: {
            neurological: {
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'fact',
                    attrs: { factId: 'b', referenceIds: [42] },
                    content: [{ type: 'paragraph' }],
                  },
                ],
              },
            },
          },
        },
      },
    };
    expect(extractCitationIds(content)).toEqual(new Set([42]));
  });

  it('collects inline footnote node and mark referenceIds', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Hello' },
                  { type: 'footnote', attrs: { referenceId: 5 } },
                  {
                    type: 'text',
                    text: 'world',
                    marks: [{ type: 'footnote', attrs: { referenceId: 6 } }],
                  },
                ],
              },
            ],
          },
        },
      },
    };
    expect(extractCitationIds(content)).toEqual(new Set([5, 6]));
  });

  it('skips refs-only values under retired or removed field slots', () => {
    // Counterpart to the WikiRenderer test: refs stored only under PK
    // parameter fields that were dropped from the schema must not be
    // marked as used by the citations API, otherwise orphaned
    // citations created for content that no longer renders can leak
    // through `/api/references?drugId=...`.
    const content = {
      version: 2 as const,
      sections: {
        pk: {
          fields: {
            half_life: {
              refs: [301],
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'fact',
                    attrs: { factId: 'orphan-half-life', referenceIds: [302] },
                    content: [{ type: 'paragraph' }],
                  },
                ],
              },
            },
            cmax: {
              refs: [303],
            },
          },
        },
      },
    } as unknown as MonographContentV2;
    expect(extractCitationIds(content)).toEqual(new Set());
  });

  it('skips refs that live under sections removed by #396', () => {
    // Mirrors the bibliography fix in WikiRenderer: existing rows may
    // still have footnotes/fact refs stored under `summary` /
    // `key_facts` / `chemistry`. The citation extractor (used by the
    // references API to detect orphaned citations) must ignore those
    // bodies so it doesn't surface sources whose inline marker has
    // been stripped from the rendered view.
    const content = {
      version: 2 as const,
      sections: {
        pd: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'fact',
                attrs: { factId: 'kept', referenceIds: [11] },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        },
        chemistry: {
          fields: {
            iupac_name: {
              refs: [101],
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'fact',
                    attrs: { factId: 'orphan', referenceIds: [102] },
                    content: [{ type: 'paragraph' }],
                  },
                ],
              },
            },
          },
        },
      },
    } as unknown as MonographContentV2;
    expect(extractCitationIds(content)).toEqual(new Set([11]));
  });

  it('walks legacy v1 free-form docs', () => {
    const v1: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'a', referenceIds: [11] },
          content: [{ type: 'paragraph' }],
        },
      ],
    };
    expect(extractCitationIds(v1)).toEqual(new Set([11]));
  });

  it('ignores non-numeric or malformed refs', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'fact',
                attrs: { factId: 'x', referenceIds: ['1', null, NaN, 3] },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        },
      },
    };
    expect(extractCitationIds(content)).toEqual(new Set([3]));
  });
});

describe('hasLegacyProse (#303 P1 banner heuristic)', () => {
  it('is false for null / undefined', () => {
    expect(hasLegacyProse(null)).toBe(false);
    expect(hasLegacyProse(undefined)).toBe(false);
  });

  it('is false for an empty doc', () => {
    expect(hasLegacyProse(emptyTipTapDoc())).toBe(false);
  });

  it('is false for a TipTap-seeded empty paragraph (cursor placeholder)', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
    expect(hasLegacyProse(doc)).toBe(false);
  });

  it('is false for a fact-only doc (atomic-only section)', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'x', referenceIds: [1] },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'fact' }] },
          ],
        },
      ],
    } as unknown as TipTapDoc;
    expect(hasLegacyProse(doc)).toBe(false);
  });

  it('is true when a paragraph carries grandfathered prose alongside facts', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Legacy paragraph.' }],
        },
        {
          type: 'fact',
          attrs: { factId: 'x', referenceIds: [] },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'fact' }] },
          ],
        },
      ],
    } as unknown as TipTapDoc;
    expect(hasLegacyProse(doc)).toBe(true);
  });

  it('is true for headings, lists, tables, etc. — any structured prose counts as legacy', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'h' }],
        },
      ],
    } as unknown as TipTapDoc;
    expect(hasLegacyProse(doc)).toBe(true);
  });
});

describe('monographHasContent', () => {
  it('is false for a null content column with no plaintext cache', () => {
    expect(monographHasContent({ content: null, contentPlaintext: null })).toBe(
      false,
    );
  });

  it('is false for the empty v2 envelope', () => {
    expect(
      monographHasContent({
        content: emptyMonographContentV2(),
        contentPlaintext: null,
      }),
    ).toBe(false);
  });

  it('is true for a v2 envelope with a filled section', () => {
    const filled = setSectionBody(emptyMonographContentV2(), 'pd', PARA_DOC);
    expect(
      monographHasContent({ content: filled, contentPlaintext: null }),
    ).toBe(true);
  });

  it('is false for the canonical empty TipTap doc the editor writes on save', () => {
    expect(
      monographHasContent({ content: emptyTipTapDoc(), contentPlaintext: null }),
    ).toBe(false);
  });

  it('is true for a legacy TipTap doc with real prose', () => {
    expect(
      monographHasContent({ content: PARA_DOC, contentPlaintext: null }),
    ).toBe(true);
  });

  it('trusts a non-blank plaintext cache even over stale/unset content', () => {
    expect(
      monographHasContent({ content: null, contentPlaintext: '  Some text  ' }),
    ).toBe(true);
  });

  it('treats a whitespace-only plaintext cache as empty', () => {
    expect(
      monographHasContent({ content: null, contentPlaintext: '   ' }),
    ).toBe(false);
  });
});
