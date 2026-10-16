import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// English is not in the entry bundle (src/i18n.ts): Norwegian visitors never
// download it, and an English visitor's strings arrive before the first render.

async function loadI18n() {
  vi.resetModules();
  return import('../i18n');
}

describe('i18n English on demand', () => {
  // The suite's setup replaces localStorage with bare mocks; give getItem a
  // stored language per test.
  let storedLanguage: string | null = null;
  beforeEach(() => {
    storedLanguage = null;
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'kinetix-lang' ? storedLanguage : null,
    );
  });
  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('starts in Norwegian without loading the English bundle', async () => {
    const { default: i18n, i18nReady } = await loadI18n();
    await i18nReady;
    expect(i18n.language).toBe('nb');
    expect(i18n.t('nav.drugTable')).toBe('Substansregister');
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(false);
  });

  it('has English ready once i18nReady resolves for a stored English choice', async () => {
    storedLanguage = 'en';
    const { default: i18n, i18nReady } = await loadI18n();
    await i18nReady;
    expect(i18n.language).toBe('en');
    expect(i18n.t('nav.drugTable')).toBe('Drug Table');
  });

  it('loads English when the language is switched', async () => {
    const { default: i18n, i18nReady } = await loadI18n();
    await i18nReady;
    await i18n.changeLanguage('en');
    expect(i18n.t('nav.drugTable')).toBe('Drug Table');
    await i18n.changeLanguage('nb');
    expect(i18n.t('nav.drugTable')).toBe('Substansregister');
  });

  it('still resolves, in the Norwegian fallback, when the English chunk fails', async () => {
    storedLanguage = 'en';
    vi.doMock('../locales/en.json', () => {
      throw new Error('chunk failed to load');
    });
    try {
      const { default: i18n, i18nReady } = await loadI18n();
      await i18nReady;
      expect(i18n.t('nav.drugTable')).toBe('Substansregister');
    } finally {
      vi.doUnmock('../locales/en.json');
    }
  });
});
