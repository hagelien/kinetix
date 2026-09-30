import { describe, it, expect } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';

// Per AGENTS.md, every UI key MUST exist in both en and nb. This guards the
// whole locale tree (not just one namespace) so a PR that adds or renames a
// key in only one language fails CI instead of silently shipping a gap.

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flatten(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe('locale parity (en ↔ nb)', () => {
  const enKeys = flatten(en as Record<string, unknown>).sort();
  const nbKeys = flatten(nb as Record<string, unknown>).sort();

  it('has the exact same set of keys in en.json and nb.json', () => {
    const onlyEn = enKeys.filter((k) => !nbKeys.includes(k));
    const onlyNb = nbKeys.filter((k) => !enKeys.includes(k));
    expect(onlyEn, `keys missing from nb.json: ${onlyEn.join(', ')}`).toEqual([]);
    expect(onlyNb, `keys missing from en.json: ${onlyNb.join(', ')}`).toEqual([]);
  });

  it('has no empty string leaves in either language', () => {
    for (const [locale, obj] of [
      ['en', en],
      ['nb', nb],
    ] as const) {
      for (const key of flatten(obj as Record<string, unknown>)) {
        const value = key
          .split('.')
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], obj);
        // Leaves are usually strings; some are arrays/objects (returnObjects
        // content). Only string leaves are checked for emptiness.
        if (typeof value === 'string') {
          expect(value.length, `${locale}.${key} should be non-empty`).toBeGreaterThan(0);
        } else {
          expect(value, `${locale}.${key} should be defined`).toBeDefined();
        }
      }
    }
  });
});
