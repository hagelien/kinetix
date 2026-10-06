/**
 * The entry editors show `parameterEntries.editor.error_<code>` for a refused
 * write and fall back to the server's English prose only when the key is
 * missing — so the quote refusal needs its own copy in every locale.
 */
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
  });
});
