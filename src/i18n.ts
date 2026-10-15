import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import nb from './locales/nb.json';

// Norwegian is the fallback language and what a visitor sees until they pick
// English, so it ships in the entry chunk. English is ~60 kB compressed that
// every Norwegian visitor used to download and parse before first paint; it is
// now its own chunk, fetched only when English is the active language (stored
// choice at startup, or the header toggle — changeLanguage waits for it).
// `partialBundledLanguages` lets i18next consult this backend for a language
// that is not in `resources` while still using the bundled Norwegian as is.
const onDemandLocales: BackendModule = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    if (language !== 'en') {
      callback(null, {});
      return;
    }
    import('./locales/en.json').then(
      (bundle) => callback(null, bundle.default),
      (err: Error) => callback(err, null),
    );
  },
};

/**
 * Resolves once the active language's strings are loaded: immediately for
 * Norwegian, after one chunk request for English. It also resolves when that
 * request fails — the app then renders with the Norwegian fallback.
 */
export const i18nReady = i18n
  .use(onDemandLocales)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      nb: { translation: nb },
    },
    partialBundledLanguages: true,
    fallbackLng: 'nb',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
      lookupLocalStorage: 'kinetix-lang',
    },
  });

export default i18n;
