import { describe, expect, it } from 'vitest';
import {
  SETTING,
  SITE_SETTING_DEFAULTS,
  SITE_SETTING_LIST,
  getSiteSetting,
  isSiteSettingId,
  sanitizeSiteSettings,
} from './siteSettings';

describe('site setting registry', () => {
  it('gives every switch a unique id', () => {
    const ids = SITE_SETTING_LIST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the reference gate ON, so nothing is relaxed by upgrading', () => {
    expect(
      SITE_SETTING_DEFAULTS[SETTING['referenceGate.blockUnreviewedCitations']],
    ).toBe(true);
  });

  it('exposes each switch by id', () => {
    for (const def of SITE_SETTING_LIST) {
      expect(isSiteSettingId(def.id)).toBe(true);
      expect(getSiteSetting(def.id)).toBe(def);
    }
    expect(isSiteSettingId('nope')).toBe(false);
    expect(getSiteSetting('nope')).toBeUndefined();
  });
});

describe('sanitizeSiteSettings', () => {
  const gate = SETTING['referenceGate.blockUnreviewedCitations'];

  it('returns the defaults when nothing is stored', () => {
    expect(sanitizeSiteSettings({})).toEqual(SITE_SETTING_DEFAULTS);
  });

  it('applies a stored deviation', () => {
    expect(sanitizeSiteSettings({ [gate]: false })[gate]).toBe(false);
  });

  it('drops ids this release no longer knows', () => {
    const result = sanitizeSiteSettings({ 'gone.away': false });
    expect(result).toEqual(SITE_SETTING_DEFAULTS);
    expect('gone.away' in result).toBe(false);
  });

  it('ignores a non-boolean value rather than coercing it', () => {
    // The column is jsonb, so a hand-edited row can hold anything. Coercing
    // "false" or 0 to false would silently drop a guard.
    for (const bad of ['false', 0, null, {}, []]) {
      expect(sanitizeSiteSettings({ [gate]: bad })[gate]).toBe(true);
    }
  });

  it('always has exactly the registry keys', () => {
    expect(Object.keys(sanitizeSiteSettings({ 'gone.away': true })).sort()).toEqual(
      SITE_SETTING_LIST.map((s) => s.id).sort(),
    );
  });
});
