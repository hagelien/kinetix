import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../api/_lib/tiptap-utils.ts';
import { sanitizeWikiHtml } from './sanitizeWikiHtml';

describe('renderHtml security hardening', () => {
  it('normalizes heading levels before interpolating HTML tags', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: '1 onclick="alert(1)"' },
          content: [{ type: 'text', text: 'Injected heading' }],
        },
      ],
    });

    expect(html).toBe('<h1>Injected heading</h1>');
    expect(html).not.toContain('onclick');
  });

  it('drops unsafe link protocols instead of rendering executable anchors', () => {
    const html = renderHtml({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Click me',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    });

    expect(html).toBe('<p>Click me</p>');
    expect(html).not.toContain('javascript:');
  });
});

describe('sanitizeWikiHtml', () => {
  it('strips active content from stored HTML before rendering', () => {
    const html = sanitizeWikiHtml(
      '<h1 onclick="alert(1)">Title</h1>' +
        '<a href="javascript:alert(1)" rel="evil">link</a>' +
        '<script>alert(1)</script>' +
        '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" onerror="alert(1)" alt="x">',
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('link');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('preserves the fact wrapper div with data-fact-id and data-fact-refs (#284)', () => {
    const html = sanitizeWikiHtml(
      '<div class="monograph-fact" data-fact-id="abc" data-fact-refs="12,34"><p>claim</p></div>',
    );
    expect(html).toContain('data-fact-id="abc"');
    expect(html).toContain('data-fact-refs="12,34"');
    expect(html).toContain('class="monograph-fact"');
    expect(html).toContain('<p>claim</p>');
  });

  it('preserves the flat <p class="monograph-fact"> shape introduced for prose flow (#303 P2)', () => {
    const html = sanitizeWikiHtml(
      '<p class="monograph-fact" data-fact-id="abc" data-fact-refs="12,34">claim</p>',
    );
    expect(html).toContain('data-fact-id="abc"');
    expect(html).toContain('data-fact-refs="12,34"');
    expect(html).toContain('class="monograph-fact"');
    expect(html).toContain('>claim<');
  });

  it('strips other attributes from the fact wrapper but keeps the data-attrs', () => {
    const html = sanitizeWikiHtml(
      '<div class="monograph-fact" data-fact-id="abc" onclick="alert(1)" style="color:red"><p>claim</p></div>',
    );
    expect(html).toContain('data-fact-id="abc"');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('style');
  });

  it('strips unrecognized classes so stored content cannot spoof trusted renderer UI', () => {
    const html = sanitizeWikiHtml(
      '<p class="monograph-fact kx-verify kx-verify-3 text-primary" data-fact-id="abc">claim</p>' +
        '<span class="kx-verify kx-verify-disputed unit-conversion-tooltip">fake badge</span>',
    );

    expect(html).toContain('class="monograph-fact"');
    expect(html).not.toContain('kx-verify');
    expect(html).not.toContain('unit-conversion-tooltip');
    expect(html).not.toContain('text-primary');
  });

  it('preserves renderer-owned citation and footnote classes', () => {
    const html = sanitizeWikiHtml(
      '<sup class="footnote-marker extra"><span class="citation-tooltip-trigger unknown"><a href="#ref-1">[1]</a><span class="citation-tooltip extra"><span class="citation-tooltip-entry unknown">Ref</span></span></span></sup>',
    );

    expect(html).toContain('class="footnote-marker"');
    expect(html).toContain('class="citation-tooltip-trigger"');
    expect(html).toContain('class="citation-tooltip"');
    expect(html).toContain('class="citation-tooltip-entry"');
    expect(html).not.toContain('unknown');
    expect(html).not.toContain('extra');
  });

  it('preserves the parameter-anchor aside placeholder + dl replacement output (#276 phase 1d)', () => {
    const html = sanitizeWikiHtml(
      '<aside class="monograph-parameter" data-monograph-parameter="halfLife" data-monograph-section="pk" data-monograph-field="half_life"></aside>' +
        '<dl class="monograph-parameter" data-monograph-parameter="halfLife" data-monograph-section="pk" data-monograph-field="half_life"><dt>Halveringstid</dt><dd>2 – 4 h</dd></dl>',
    );
    expect(html).toContain('<aside');
    expect(html).toContain('data-monograph-parameter="halfLife"');
    expect(html).toContain('<dl');
    expect(html).toContain('<dt>Halveringstid</dt>');
    expect(html).toContain('<dd>2 – 4 h</dd>');
  });
});

describe('sanitizeWikiHtml math markers', () => {
  it('preserves data-tex on inline math spans', () => {
    const html = sanitizeWikiHtml(
      '<p>x <span class="kx-math" data-tex="C_0 e^{-kt}"></span></p>',
    );
    expect(html).toContain('class="kx-math"');
    expect(html).toContain('data-tex="C_0 e^{-kt}"');
  });

  it('preserves data-tex on display math divs', () => {
    const html = sanitizeWikiHtml(
      '<div class="kx-math-block" data-tex="\\frac{a}{b}"></div>',
    );
    expect(html).toContain('class="kx-math-block"');
    expect(html).toContain('data-tex="\\frac{a}{b}"');
  });

  it('still strips event-handler attributes from math markers', () => {
    const html = sanitizeWikiHtml(
      '<span class="kx-math" data-tex="x" onclick="alert(1)"></span>',
    );
    expect(html).not.toContain('onclick');
    expect(html).toContain('data-tex="x"');
  });
});
