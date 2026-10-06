/**
 * The entry editors show `parameterEntries.editor.error_<code>` for a refused
 * write, and the review card maps the code through REVIEW_ERROR_KEYS to
 * `review.errors.*`; both fall back to the server's English prose only when
 * the key is missing — so the quote refusal needs its copy in every locale,
 * on both surfaces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../src/locales/en.json';
import nb from '../../src/locales/nb.json';

describe('the source_quote_required refusal', () => {
  it.each([
    ['en', en],
    ['nb', nb],
  ])('has editor copy in %s', (_locale, messages) => {
    const editor = (messages as { parameterEntries: { editor: Record<string, string> } })
      .parameterEntries.editor;
    expect(editor.error_source_quote_required).toBeTruthy();
    const review = (messages as { review: { errors: Record<string, string> } }).review.errors;
    expect(review.sourceQuoteRequired).toBeTruthy();
  });

  it('is mapped on the review card', () => {
    const card = readFileSync('src/components/review/PendingEditCard.tsx', 'utf8');
    expect(card).toMatch(/source_quote_required: 'review\.errors\.sourceQuoteRequired'/);
  });
});
