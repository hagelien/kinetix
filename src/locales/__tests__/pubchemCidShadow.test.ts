import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';

// `pubchem_cid_shadows_drug_id` reaches three surfaces — the research import,
// the wiki create page and the review card — and all of them map it to this
// one key. The component tests echo keys, so only this file notices a key
// that is missing or left in English.
type Locale = { errors: Record<string, string | undefined> };

describe('errors.pubchemCidShadowsDrugId', () => {
  it.each([
    ['en', en],
    ['nb', nb],
  ])('has copy in %s', (_lang, bundle) => {
    const value = (bundle as Locale).errors.pubchemCidShadowsDrugId;
    expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
  });

  it('is translated rather than copied from English', () => {
    expect((nb as Locale).errors.pubchemCidShadowsDrugId).not.toBe(
      (en as Locale).errors.pubchemCidShadowsDrugId,
    );
  });
});
