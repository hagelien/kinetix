import { beforeAll, describe, expect, it } from 'vitest';
import i18nApp from '@/i18n';
import { blockSnapshotLines } from './drugBlockSnapshots';

const t = (key: string, opts?: Record<string, unknown>) =>
  i18nApp.t(key, opts) as string;

describe('blockSnapshotLines', () => {
  beforeAll(async () => {
    await i18nApp.changeLanguage('en');
  });

  it('writes one metabolism line per route, link and note, with its citations', () => {
    const lines = blockSnapshotLines(
      'metabolism',
      {
        evidenceNote: 'Mostly hepatic.',
        routes: [
          {
            kind: 'enzyme',
            enzyme: { symbol: 'CYP2E1', name: 'CYP2E1', nameEn: null },
            label: null,
            fraction: { min: null, median: 0.1, max: null },
            note: null,
            referenceIds: [12],
          },
        ],
        metabolites: [
          {
            metaboliteName: 'NAPQI',
            drug: null,
            activity: 'active',
            conversionFraction: null,
            evidenceNote: null,
            referenceIds: null,
          },
        ],
        precursors: [],
      },
      t,
      'en',
    );
    expect(lines[0]).toMatch(/^CYP2E1 · 10\s?% · #12$/);
    expect(lines[1]).toBe('Metabolites: NAPQI · active');
    expect(lines[2]).toBe('Note: Mostly hepatic.');
  });

  it('writes one line per mechanism with its tier, target and measurements', () => {
    const [line] = blockSnapshotLines(
      'pharmacodynamics',
      {
        mechanisms: [
          {
            tier: 'primary',
            interactionType: 'antagonist',
            target: { symbol: 'DRD2' },
            ki: { median: 1.2, unit: 'nM' },
            selectivityRatio: { median: 30 },
            referenceIds: [3],
          },
        ],
      },
      t,
      'en',
    );
    expect(line).toContain('DRD2');
    expect(line).toContain('Ki 1.2');
    expect(line).toContain('Selectivity 30');
    expect(line).toMatch(/#3$/);
  });

  it('writes one line per model-structure declaration', () => {
    const [line] = blockSnapshotLines(
      'modelStructure',
      {
        declarations: [
          {
            parameter: 'absorptionModel',
            categoricalValue: 'first-order',
            route: 'oral',
            citationId: 9,
            sourceQuote: null,
          },
        ],
      },
      t,
      'en',
    );
    expect(line).toMatch(/· #9$/);
    expect(line?.toLowerCase()).toContain('oral');
  });

  it('yields no lines for a snapshot that is not an object', () => {
    expect(blockSnapshotLines('metabolism', null, t, 'en')).toEqual([]);
  });

  it('names a worded metric in the reader\'s language', async () => {
    await i18nApp.changeLanguage('nb');
    try {
      const [line] = blockSnapshotLines(
        'pharmacodynamics',
        {
          mechanisms: [
            {
              tier: null,
              interactionType: 'agonist',
              target: { symbol: 'MOR' },
              selectivityRatio: { median: 30 },
              referenceIds: [],
            },
          ],
        },
        t,
        'nb',
      );
      expect(line).toContain('Selektivitet 30');
      expect(line).not.toContain('Selectivity');
    } finally {
      await i18nApp.changeLanguage('en');
    }
  });

  it('shows the profile citations on the note line, even without a note', () => {
    const lines = blockSnapshotLines(
      'metabolism',
      { evidenceNote: null, referenceIds: [7], routes: [], metabolites: [], precursors: [] },
      t,
      'en',
    );
    expect(lines).toEqual(['Note: — · #7']);
  });

  it('writes one line per route-scoped ka value', () => {
    const lines = blockSnapshotLines(
      'modelStructure',
      {
        declarations: [],
        routeValues: [
          {
            parameter: 'ka',
            route: 'oral',
            low: null,
            high: null,
            median: '1.200000',
            qualifier: null,
            unit: '1/h',
            n: 12,
            comments: null,
            observationContext: null,
            citationId: 4,
            sourceQuote: null,
          },
        ],
      },
      t,
      'en',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1.2');
    expect(lines[0]?.toLowerCase()).toContain('oral');
    expect(lines[0]).toContain('n=12');
    expect(lines[0]).toMatch(/#4$/);
  });
  it.each(['en', 'nb'])('renders the reported ka centre and interval in %s', async (lang) => {
    await i18nApp.changeLanguage(lang);
    try {
      const [line] = blockSnapshotLines('modelStructure', {
        routeValues: [{ parameter: 'ka', route: 'oral', centralValue: '1.400000',
          centralStatistic: 'arithmetic_mean', intervalKind: 'ci95', low: '1.100000',
          high: '1.700000', median: null, unit: '1/h', citationId: 4 }],
      }, t, lang);
      expect(line).toContain('1.4 (1.1–1.7) 1/h');
      expect(line).toContain(t('doseContext.values.centralStatistic.arithmetic_mean'));
      expect(line).toContain(t('doseContext.values.intervalKind.ci95'));
      expect(line).toMatch(/#4$/);
    } finally {
      await i18nApp.changeLanguage('en');
    }
  });

  it('shows a reported ka centre without bounds, including zero', () => {
    const [line] = blockSnapshotLines('modelStructure', {
      routeValues: [{ parameter: 'ka', centralValue: '0', centralStatistic: 'median', unit: '1/h' }],
    }, t, 'en');
    expect(line).toContain(': 0 1/h');
    expect(line).toContain(t('doseContext.values.centralStatistic.median'));
  });

});
