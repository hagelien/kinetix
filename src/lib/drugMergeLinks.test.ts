import { describe, it, expect } from 'vitest';
import {
  rewriteDrugHref,
  rewriteDrugLinksInHtml,
  rewriteDrugLinksInJson,
} from './drugMergeLinks';

const R = { fromId: 115, toId: 988, fromSlug: 'mhd-old', toSlug: 'mhd' };

describe('rewriteDrugHref', () => {
  it('rewrites the numeric drug route', () => {
    expect(rewriteDrugHref('/wiki/drug/115', R)).toBe('/wiki/drug/988');
  });

  it('keeps query and fragment when rewriting the numeric route', () => {
    expect(rewriteDrugHref('/wiki/drug/115?tab=data', R)).toBe('/wiki/drug/988?tab=data');
    expect(rewriteDrugHref('/wiki/drug/115#pk', R)).toBe('/wiki/drug/988#pk');
  });

  it('does not rewrite an id that only shares a prefix', () => {
    // 1150 must not be caught by a rewrite of 115.
    expect(rewriteDrugHref('/wiki/drug/1150', R)).toBe('/wiki/drug/1150');
  });

  it('does not touch a different drug id', () => {
    expect(rewriteDrugHref('/wiki/drug/42', R)).toBe('/wiki/drug/42');
  });

  it('rewrites the monograph slug route', () => {
    expect(rewriteDrugHref('/wiki/mhd-old', R)).toBe('/wiki/mhd');
    expect(rewriteDrugHref('/wiki/mhd-old#section', R)).toBe('/wiki/mhd#section');
  });

  it('does not rewrite a slug that only shares a prefix', () => {
    expect(rewriteDrugHref('/wiki/mhd-old-notes', R)).toBe('/wiki/mhd-old-notes');
  });

  it('leaves unrelated links alone', () => {
    expect(rewriteDrugHref('/wiki/other', R)).toBe('/wiki/other');
    expect(rewriteDrugHref('https://example.com/wiki/mhd-old', R)).toBe(
      'https://example.com/wiki/mhd-old',
    );
  });

  it('does nothing when no slug rename is supplied', () => {
    const r = { fromId: 115, toId: 988 };
    expect(rewriteDrugHref('/wiki/mhd-old', r)).toBe('/wiki/mhd-old');
    expect(rewriteDrugHref('/wiki/drug/115', r)).toBe('/wiki/drug/988');
  });
});

describe('rewriteDrugLinksInJson', () => {
  it('rewrites href strings inside link marks and reports change', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'see MHD',
              marks: [{ type: 'link', attrs: { href: '/wiki/drug/115' } }],
            },
          ],
        },
      ],
    };
    const { value, changed } = rewriteDrugLinksInJson(doc, R);
    expect(changed).toBe(true);
    const href = (value as { content: { content: { marks: { attrs: { href: string } }[] }[] }[] })
      .content[0]!.content[0]!.marks[0]!.attrs.href;
    expect(href).toBe('/wiki/drug/988');
  });

  it('does not rewrite the id when it appears as body text, only under href', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'text', text: '/wiki/drug/115' }],
    };
    const { value, changed } = rewriteDrugLinksInJson(doc, R);
    expect(changed).toBe(false);
    expect((value as { content: { text: string }[] }).content[0]!.text).toBe('/wiki/drug/115');
  });

  it('leaves a document with no drug links untouched', () => {
    const doc = { type: 'doc', content: [{ type: 'text', text: 'plain' }] };
    expect(rewriteDrugLinksInJson(doc, R).changed).toBe(false);
  });
});

describe('rewriteDrugLinksInHtml', () => {
  it('rewrites href attributes in both quote styles', () => {
    const html = `<a href="/wiki/drug/115">a</a> and <a href='/wiki/mhd-old'>b</a>`;
    const { value, changed } = rewriteDrugLinksInHtml(html, R);
    expect(changed).toBe(true);
    expect(value).toContain('href="/wiki/drug/988"');
    expect(value).toContain("href='/wiki/mhd'");
  });

  it('leaves unrelated hrefs untouched', () => {
    const html = `<a href="/wiki/other">x</a>`;
    const { value, changed } = rewriteDrugLinksInHtml(html, R);
    expect(changed).toBe(false);
    expect(value).toBe(html);
  });
});
