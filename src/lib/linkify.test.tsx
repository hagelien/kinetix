import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { linkify } from './linkify';

describe('linkify', () => {
  it('returns the original text unchanged when no URLs are present', () => {
    const { container } = render(<>{linkify('just plain text, no links')}</>);
    expect(container.textContent).toBe('just plain text, no links');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('renders a single URL as an anchor with target=_blank + rel', () => {
    const { container } = render(<>{linkify('see https://example.org for details')}</>);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://example.org');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toBe('see https://example.org for details');
  });

  it('strips trailing punctuation from the href while keeping it in text', () => {
    const { container } = render(<>{linkify('go to https://example.org.')}</>);
    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe('https://example.org');
    expect(container.textContent).toBe('go to https://example.org.');
  });

  it('renders multiple URLs in order', () => {
    const { container } = render(
      <>{linkify('a https://a.example and b http://b.example end')}</>,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute('href')).toBe('https://a.example');
    expect(links[1]!.getAttribute('href')).toBe('http://b.example');
  });

  it('ignores schemeless text even if it looks like a domain', () => {
    const { container } = render(<>{linkify('visit example.org to learn more')}</>);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('keeps balanced parens inside a URL (Wikipedia-style)', () => {
    const { container } = render(
      <>{linkify('see https://en.wikipedia.org/wiki/Function_(mathematics)')}</>,
    );
    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe(
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
    expect(container.textContent).toBe(
      'see https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
  });

  it('does not absorb a closing paren when the URL sits inside prose parentheses', () => {
    const { container } = render(<>{linkify('(see https://example.org)')}</>);
    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe('https://example.org');
    expect(container.textContent).toBe('(see https://example.org)');
  });
});
