/**
 * Every key the registries name must resolve in both languages.
 *
 * The locale parity test checks that nb and en carry the same keys; it cannot
 * see whether a key a *module* names exists at all. That gap is exactly where an
 * untranslated registry entry hides: the model carries a key, the view renders
 * it verbatim, and the screen shows `pattern.profile.feature.x.label` to a
 * toxicologist. So the keys are collected from the module objects themselves —
 * add a feature without a translation and this fails, in both languages, without
 * anyone remembering to list it here.
 */

import { describe, it, expect } from 'vitest';

import en from '../../locales/en.json';
import nb from '../../locales/nb.json';
import { UNIVERSAL_CONTEXT_FIELDS, HYDROLYSIS_CONTEXT_FIELD } from './contextFields.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { COCAINE_MODULE } from './modules/cocaine.js';
import { DEGRADATION_KEYS, ENFSI_STRENGTH_KEYS, NOT_CALCULABLE_KEYS } from './wording.js';

/** Every string-valued property whose name ends in `Key`, however deeply nested. */
function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) {
      if (name.endsWith('Key') && typeof entry === 'string') found.add(entry);
      else collectKeys(entry, found);
    }
  }
  return found;
}

function resolve(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object' && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, bundle);
}

const registryKeys = [
  ...collectKeys([
    BENZODIAZEPINE_MODULE,
    COCAINE_MODULE,
    UNIVERSAL_CONTEXT_FIELDS,
    HYDROLYSIS_CONTEXT_FIELD,
  ]),
  // The wording tables are keys the engine emits rather than a registry
  // declares, and they are exactly the strings a report will reuse in Phase 4 —
  // an untranslated one would reach a reader through two surfaces, not one.
  ...Object.values(ENFSI_STRENGTH_KEYS),
  ...Object.values(NOT_CALCULABLE_KEYS),
  ...Object.values(DEGRADATION_KEYS),
].sort();

describe('registry label keys resolve in both locales', () => {
  it('collects keys from the registries rather than a hand-kept list', () => {
    // A guard against the suite passing because the collector found nothing.
    expect(registryKeys.length).toBeGreaterThan(30);
  });

  it.each(registryKeys)('nb: %s', (key) => {
    expect(typeof resolve(nb, key), `nb is missing ${key}`).toBe('string');
  });

  it.each(registryKeys)('en: %s', (key) => {
    expect(typeof resolve(en, key), `en is missing ${key}`).toBe('string');
  });
});
