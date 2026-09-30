import { describe, expect, it } from 'vitest';
import { generateSlug, targetSlug } from '../../api/_lib/slug';

describe('generateSlug', () => {
  it('strips characters outside [a-z0-9] and hyphenates whitespace', () => {
    expect(generateSlug('Opioid receptor mu 1')).toBe('opioid-receptor-mu-1');
  });

  it('returns an empty string for symbols made only of stripped characters', () => {
    // Greek letters used as receptor symbols (μ, κ, δ) carry no slug content.
    expect(generateSlug('μ')).toBe('');
  });
});

describe('targetSlug', () => {
  it('prefers the symbol when it produces a slug', () => {
    expect(targetSlug('SERT', 'Serotonin transporter')).toBe('sert');
  });

  it('falls back to the name when the symbol slugs to empty', () => {
    // Regression: a "μ" symbol with a valid name must not be rejected.
    expect(targetSlug('μ', 'opioid receptor mu 1')).toBe(
      'opioid-receptor-mu-1',
    );
  });

  it('is empty only when neither symbol nor name carries slug content', () => {
    expect(targetSlug('μ', '')).toBe('');
    expect(targetSlug(null, null)).toBe('');
  });
});
