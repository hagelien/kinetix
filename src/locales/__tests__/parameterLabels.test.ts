import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';
import { DRUG_PARAMETER_IDS } from '@/lib/drugParameters';
import { DRUG_COVERAGE_AREAS } from '@/lib/drugCoverageAreas';

type ParameterLocale = Record<string, { label?: string; longLabel?: string }>;

describe('parameter i18n labels', () => {
  const locales: Array<[string, ParameterLocale]> = [
    ['en', (en as { parameters: ParameterLocale }).parameters],
    ['nb', (nb as { parameters: ParameterLocale }).parameters],
  ];

  it('has non-empty short and long labels for every registered parameter', () => {
    for (const [locale, parameters] of locales) {
      for (const id of DRUG_PARAMETER_IDS) {
        expect(
          parameters[id]?.label,
          `${locale} parameters.${id}.label`,
        ).toBeTruthy();
        expect(
          parameters[id]?.longLabel,
          `${locale} parameters.${id}.longLabel`,
        ).toBeTruthy();
      }
    }
  });
});

describe('coverage-area i18n labels', () => {
  // The admin focus picker and the monograph's flag buttons both read these
  // keys. A missing one degrades to the raw id (`metabolism`), which is the
  // kind of half-translated control the bilingual rule exists to prevent.
  const locales: Array<[string, Record<string, string>]> = [
    ['en', (en as { coverageAreas: Record<string, string> }).coverageAreas],
    ['nb', (nb as { coverageAreas: Record<string, string> }).coverageAreas],
  ];

  it('has a non-empty label for every coverage area', () => {
    for (const [locale, areas] of locales) {
      for (const area of DRUG_COVERAGE_AREAS) {
        const key = area.i18nKey.replace(/^coverageAreas\./, '');
        expect(areas[key], `${locale} ${area.i18nKey}`).toBeTruthy();
      }
    }
  });
});
