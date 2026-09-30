import { describe, expect, it } from 'vitest';
import {
  ensureTopicSectionIds,
  extractPlaintext,
  renderHtml,
} from '../../api/_lib/tiptap-utils';
import { listTopicSectionIds } from '../../src/lib/topicSections';
import type {
  MonographContentV2,
  TipTapDoc,
} from '../../src/lib/monographContent';

const PARA_DOC: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Hello world' }],
    },
  ],
};

const FOOTNOTED_DOC: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Claim' },
        { type: 'footnote', attrs: { referenceId: 42 } },
      ],
    },
  ],
};

const SECOND_DOC: TipTapDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Section two' }],
    },
  ],
};

describe('renderHtml — v1 fallback', () => {
  it('renders a free-form doc unchanged', () => {
    expect(renderHtml(PARA_DOC)).toBe('<p>Hello world</p>');
  });

  it('returns empty string for non-doc input', () => {
    expect(renderHtml(null)).toBe('');
    expect(renderHtml({})).toBe('');
    expect(renderHtml({ type: 'paragraph' })).toBe('');
  });

  it('numbers footnotes from 1 within a single doc', () => {
    expect(renderHtml(FOOTNOTED_DOC)).toContain('[1]');
    expect(renderHtml(FOOTNOTED_DOC)).toContain('data-reference-id="42"');
  });

  it('preserves the topic-page sectionId attribute on heading nodes (#348)', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, sectionId: 'pharmacology' },
          content: [{ type: 'text', text: 'Pharmacology' }],
        },
      ],
    };
    expect(renderHtml(doc)).toBe(
      '<h2 data-section-id="pharmacology">Pharmacology</h2>',
    );
  });

  it('escapes injected attribute content on the section anchor', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, sectionId: 'a"><script>x</script>' },
          content: [{ type: 'text', text: 'X' }],
        },
      ],
    };
    expect(renderHtml(doc)).not.toContain('<script>');
  });

  it('normalizes path-traversal link hrefs so the rendered href shows the resolved destination', () => {
    // A traversal path like /wiki/../../api/admin must not appear verbatim
    // in the rendered href — the browser would navigate to /api/admin.
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [
                { type: 'link', attrs: { href: '/wiki/../../api/admin' } },
              ],
            },
          ],
        },
      ],
    };
    const html = renderHtml(doc);
    // The href must be the normalized path, not the traversal sequence.
    expect(html).not.toContain('/wiki/../../api/admin');
    expect(html).toContain('href="/api/admin"');
  });
});

describe('renderHtml — v2 monograph', () => {
  it('emits sections in declared order with Norwegian h2 headings', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        // Insertion order reversed; declared order is pd → pk → forensic.
        forensic: { body: SECOND_DOC },
        pk: { body: PARA_DOC },
        pd: { body: PARA_DOC },
      },
    };
    const html = renderHtml(content);
    const pdIdx = html.indexOf('data-monograph-section="pd"');
    const pkIdx = html.indexOf('data-monograph-section="pk"');
    const forensicIdx = html.indexOf('data-monograph-section="forensic"');
    expect(pdIdx).toBeGreaterThan(-1);
    expect(pkIdx).toBeGreaterThan(pdIdx);
    expect(forensicIdx).toBeGreaterThan(pkIdx);
    // Server emits the canonical Norwegian title with a data-attr lookup
    // key; the client-side WikiRenderer rewrites the inner text based on
    // the active i18n locale before sanitization.
    expect(html).toContain('Farmakodynamikk</h2>');
    expect(html).toContain('Farmakokinetikk</h2>');
    expect(html).toContain('Rettstoksikologisk tolkning</h2>');
    expect(html).toContain('data-monograph-section-title="pd"');
    expect(html).toContain('data-monograph-section-title="pk"');
  });

  it('skips empty sections entirely', () => {
    // After #396 no section declares parameter-kind fields any more, so
    // sections with no body and no non-empty prose fields are skipped
    // even when they are otherwise schema-declared (e.g. `toxicity`).
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: { body: PARA_DOC },
        toxicity: { body: { type: 'doc', content: [{ type: 'paragraph' }] } },
      },
    };
    const html = renderHtml(content);
    expect(html).toContain('data-monograph-section="pd"');
    expect(html).not.toContain('data-monograph-section="toxicity"');
  });

  it('does not emit inline parameter-anchor placeholders any more (#396)', () => {
    // The right-side drug parameter box now owns every numeric value;
    // the v2 renderer must not splice <aside data-monograph-parameter>
    // markers into the main content view at all.
    const html = renderHtml({ version: 2, sections: {} });
    expect(html).not.toContain('data-monograph-parameter=');
    expect(html).not.toContain('<aside');
  });

  it('merges retired field bodies under the parent section in stable order', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        effects: {
          fields: {
            // Order swapped vs schema (psychiatric, neurological, cardiovascular)
            cardiovascular: { body: SECOND_DOC },
            psychiatric: { body: PARA_DOC },
          },
        },
      },
    };
    const html = renderHtml(content);
    const psychiatric = html.indexOf('data-monograph-field="psychiatric"');
    const cardiovascular = html.indexOf(
      'data-monograph-field="cardiovascular"',
    );
    expect(psychiatric).toBe(-1);
    expect(cardiovascular).toBe(-1);
    expect(html).toContain('data-monograph-section="effects"');
    expect(html.indexOf('Hello world')).toBeLessThan(
      html.indexOf('Section two'),
    );
  });

  it('shares footnote numbering across sections', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: { body: FOOTNOTED_DOC },
        pk: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Other' },
                  { type: 'footnote', attrs: { referenceId: 99 } },
                ],
              },
            ],
          },
        },
      },
    };
    const html = renderHtml(content);
    expect(html).toContain('[1]');
    expect(html).toContain('[2]');
    expect(html).toContain('data-reference-id="42"');
    expect(html).toContain('data-reference-id="99"');
  });
});

describe('renderHtml — fact nodes (#284, #303 P2)', () => {
  it('renders a single-paragraph fact as a flat <p> so it flows as prose', () => {
    const doc: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'aaaa-bbbb', referenceIds: [12, 34] },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Morfin er en full agonist.' }],
            },
          ],
        },
      ],
    };
    const html = renderHtml(doc);
    expect(html).toContain('data-fact-id="aaaa-bbbb"');
    expect(html).toContain('data-fact-refs="12,34"');
    expect(html).toContain('Morfin er en full agonist.');
    expect(html).toContain('class="monograph-fact"');
    // #303 P2: the wrapper is a <p>, not a <div>, so consecutive facts
    // render as natural prose paragraphs in the reader.
    expect(html.startsWith('<p ')).toBe(true);
    expect(html).not.toContain('<div ');
    // Citation markers sit inside the paragraph, after the sentence,
    // instead of dangling below the block.
    expect(html).toMatch(
      /Morfin er en full agonist\.<sup class="footnote-marker"[^>]*><a [^>]*>\[1\]<\/a><\/sup><sup class="footnote-marker"[^>]*><a [^>]*>\[2\]<\/a><\/sup><\/p>/,
    );
  });

  it('wraps multi-block facts in <div> and splices markers into the last block', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'multi', referenceIds: [9] },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'opening sentence' }],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'closing sentence' }],
            },
          ],
        },
      ],
    });
    expect(html.startsWith('<div ')).toBe(true);
    expect(html).toContain('data-fact-id="multi"');
    expect(html).toContain('<p>opening sentence</p>');
    // Markers attach to the last paragraph so the citation reads
    // inline with the closing sentence rather than trailing below it.
    expect(html).toMatch(
      /<p>closing sentence<sup class="footnote-marker"[^>]*><a [^>]*>\[1\]<\/a><\/sup><\/p>/,
    );
  });

  it('omits empty/missing data-attrs when refs are absent', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'only-id', referenceIds: [] },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'claim' }],
            },
          ],
        },
      ],
    });
    expect(html).toContain('data-fact-id="only-id"');
    expect(html).not.toContain('data-fact-refs');
  });

  it('emits footnote markers for fact referenceIds so cited claims render as cited', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'fact',
          attrs: { factId: 'fact-1', referenceIds: [42, 99] },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'claim' }],
            },
          ],
        },
      ],
    });
    expect(html).toContain('[1]');
    expect(html).toContain('[2]');
    expect(html).toContain('data-reference-id="42"');
    expect(html).toContain('data-reference-id="99"');
  });

  it('shares the footnote counter between inline footnote nodes and fact refs', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'inline ' },
            { type: 'footnote', attrs: { referenceId: 7 } },
          ],
        },
        {
          type: 'fact',
          attrs: { factId: 'fact-1', referenceIds: [42, 7] },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'claim' }] },
          ],
        },
      ],
    });
    // refId 7 already used → reused as [1]; 42 is new → [2]
    const idxOf = (s: string) => html.indexOf(s);
    expect(idxOf('data-reference-id="7"')).toBeGreaterThan(-1);
    expect(idxOf('data-reference-id="42"')).toBeGreaterThan(-1);
    // fact's own data-fact-refs preserves the original input order
    expect(html).toContain('data-fact-refs="42,7"');
  });
});

describe('extractPlaintext', () => {
  it('flattens v1 content as before', () => {
    expect(extractPlaintext(PARA_DOC)).toBe('Hello world');
  });

  it('includes section titles and merged field prose inline for v2', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: { body: PARA_DOC },
        effects: {
          fields: { cardiovascular: { body: SECOND_DOC } },
        },
      },
    };
    const text = extractPlaintext(content);
    expect(text).toContain('Farmakodynamikk');
    expect(text).toContain('Hello world');
    expect(text).toContain('Effekter, bivirkninger og komplikasjoner');
    expect(text).not.toContain('Kardiovaskulære');
    expect(text).toContain('Section two');
  });
});

describe('ensureTopicSectionIds', () => {
  const TOPIC_DOC: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Analytisk påvisning' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Brødtekst.' }],
      },
    ],
  };

  it('mints section ids onto a topic page whose headings lack them', () => {
    expect(listTopicSectionIds(TOPIC_DOC)).toEqual([]);
    const result = ensureTopicSectionIds('topic', TOPIC_DOC) as TipTapDoc;
    expect(listTopicSectionIds(result)).toEqual(['analytisk-pavisning']);
  });

  it('leaves an already-anchored topic doc untouched (idempotent)', () => {
    const once = ensureTopicSectionIds('topic', TOPIC_DOC);
    const twice = ensureTopicSectionIds('topic', once);
    expect(listTopicSectionIds(twice as TipTapDoc)).toEqual([
      'analytisk-pavisning',
    ]);
  });

  it('returns non-topic content unchanged', () => {
    const monograph = ensureTopicSectionIds('drug_monograph', TOPIC_DOC);
    expect(monograph).toBe(TOPIC_DOC);
    expect(listTopicSectionIds(monograph as TipTapDoc)).toEqual([]);
  });

  it('treats entity monographs like topic pages (#785)', () => {
    const result = ensureTopicSectionIds(
      'entity_monograph',
      TOPIC_DOC,
    ) as TipTapDoc;
    expect(listTopicSectionIds(result)).toEqual(['analytisk-pavisning']);
  });

  it('tolerates null/empty content', () => {
    expect(ensureTopicSectionIds('topic', null)).toBeNull();
    expect(ensureTopicSectionIds('topic', undefined)).toBeUndefined();
  });
});

describe('renderHtml math nodes', () => {
  it('emits an inline math marker carrying escaped LaTeX', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'where ' },
            { type: 'mathInline', attrs: { tex: 'C_0 e^{-kt}' } },
          ],
        },
      ],
    });
    expect(html).toBe(
      '<p>where <span class="kx-math" data-tex="C_0 e^{-kt}"></span></p>',
    );
  });

  it('emits a display math block for mathBlock nodes', () => {
    const html = renderHtml({
      type: 'doc',
      content: [{ type: 'mathBlock', attrs: { tex: '\\frac{a}{b}' } }],
    });
    expect(html).toBe(
      '<div class="kx-math-block" data-tex="\\frac{a}{b}"></div>',
    );
  });

  it('escapes quotes/markup in the tex attribute', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        { type: 'mathBlock', attrs: { tex: '\\text{"<x>"} & y' } },
      ],
    });
    expect(html).not.toContain('<x>');
    expect(html).toContain('data-tex="\\text{&quot;&lt;x&gt;&quot;} &amp; y"');
  });

  it('drops empty math nodes', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        { type: 'mathInline', attrs: { tex: '' } },
        { type: 'mathBlock', attrs: {} },
      ],
    });
    expect(html).toBe('');
  });

  it('surfaces math source in extracted plaintext for search', () => {
    const text = extractPlaintext({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'mathInline', attrs: { tex: 'sigma(x)' } }],
        },
        { type: 'mathBlock', attrs: { tex: 'iPMR = 100 \\times V' } },
      ],
    });
    expect(text).toContain('sigma(x)');
    expect(text).toContain('iPMR = 100 \\times V');
  });
});
