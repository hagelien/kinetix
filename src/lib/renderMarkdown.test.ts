import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './renderMarkdown';

describe('renderMarkdown', () => {
  it('renders headings and emphasis', () => {
    const html = renderMarkdown('# Tittel\n\nDette er **viktig**.');
    expect(html).toContain('<h1>Tittel</h1>');
    expect(html).toContain('<strong>viktig</strong>');
  });

  it('renders tables', () => {
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('strips script tags and inline handlers', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
  });

  it('removes embedded media from review markdown', () => {
    const html = renderMarkdown(
      '![pixel](https://attacker.example/pixel.png)\n\n<iframe src="https://attacker.example"></iframe>',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('attacker.example');
  });

  it('normalizes safe links and unwraps unsafe links', () => {
    const html = renderMarkdown(
      '[safe](https://example.com) [bad](javascript:alert(1)) <a href="//example.com">proto</a>',
    );
    expect(html).toContain(
      '<a href="https://example.com" rel="noopener noreferrer nofollow">safe</a>',
    );
    expect(html).toContain('bad');
    expect(html).toContain('proto');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="//example.com"');
  });
});
