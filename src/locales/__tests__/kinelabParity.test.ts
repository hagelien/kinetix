import { describe, it, expect } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';

// Per AGENTS.md, every UI key MUST exist in both en and nb. The KineLab
// namespace is new and shipped with the /kinelab route; this test guards
// against future PRs that touch only one locale.

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

describe('kinelab i18n parity', () => {
  const enKeys = flatten((en as Record<string, unknown>).kinelab as Record<string, unknown>).sort();
  const nbKeys = flatten((nb as Record<string, unknown>).kinelab as Record<string, unknown>).sort();

  it('has the chart, report, compare, and priorsPanel sub-namespaces', () => {
    expect(enKeys.some((k) => k.startsWith('chart.'))).toBe(true);
    expect(nbKeys.some((k) => k.startsWith('chart.'))).toBe(true);
    expect(enKeys.some((k) => k.startsWith('report.'))).toBe(true);
    expect(nbKeys.some((k) => k.startsWith('report.'))).toBe(true);
    expect(enKeys.some((k) => k.startsWith('compare.'))).toBe(true);
    expect(nbKeys.some((k) => k.startsWith('compare.'))).toBe(true);
    expect(enKeys.some((k) => k.startsWith('priorsPanel.'))).toBe(true);
    expect(nbKeys.some((k) => k.startsWith('priorsPanel.'))).toBe(true);
  });

  it('has identical keys in en and nb under kinelab.*', () => {
    expect(nbKeys).toEqual(enKeys);
  });

  it('every chart, report, compare, and priorsPanel key is non-empty in both locales', () => {
    const enKinelab = (en as unknown as { kinelab: Record<string, Record<string, string>> })
      .kinelab;
    const nbKinelab = (nb as unknown as { kinelab: Record<string, Record<string, string>> })
      .kinelab;
    for (const sub of ['chart', 'report', 'compare', 'priorsPanel'] as const) {
      const enSub = enKinelab[sub] ?? {};
      const nbSub = nbKinelab[sub] ?? {};
      for (const key of Object.keys(enSub)) {
        expect(enSub[key], `en kinelab.${sub}.${key}`).toBeTruthy();
        expect(nbSub[key], `nb kinelab.${sub}.${key}`).toBeTruthy();
      }
    }
  });
});
