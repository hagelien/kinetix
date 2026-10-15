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
});
