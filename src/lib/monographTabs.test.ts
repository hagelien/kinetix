import { describe, expect, it } from 'vitest';
import { MONOGRAPH_SECTION_IDS } from './monographSections';
import {
  MONOGRAPH_TAB_IDS,
  SECTION_TAB,
  filterMonographHtmlForTab,
  isMonographTabId,
  sectionsForTab,
  tabForParameter,
} from './monographTabs';

const section = (id: string, body: string) =>
  `<section data-monograph-section="${id}"><h2 data-monograph-section-title="${id}">${id}</h2>${body}</section>`;

describe('monograph tabs', () => {
  it('gives every prose section a tab', () => {
    for (const id of MONOGRAPH_SECTION_IDS) {
      expect(MONOGRAPH_TAB_IDS).toContain(SECTION_TAB[id]);
    }
  });

  it('folds sections without a box of their own into the nearest tab', () => {
    expect(sectionsForTab('pharmacodynamics')).toEqual(['pd', 'effects']);
    expect(sectionsForTab('dose_exposure')).toEqual([
      'medical_use',
      'non_medical_use',
    ]);
    expect(sectionsForTab('interpretive_concentrations')).toEqual(['toxicity']);
    expect(sectionsForTab('postmortem')).toEqual(['forensic']);
    expect(sectionsForTab('chemistry')).toEqual([]);
  });

  it('keeps only the sections that belong on the tab', () => {
    const html =
      section('pd', '<p>receptor</p>') +
      section('pk', '<p>half-life</p>') +
      section('effects', '<p>sedation</p>');
    // The section named like the tab loses its heading (the page title says
    // it); a folded-in section keeps its own.
    expect(filterMonographHtmlForTab(html, 'pharmacodynamics')).toBe(
      '<section data-monograph-section="pd"><p>receptor</p></section>' +
        section('effects', '<p>sedation</p>'),
    );
    expect(filterMonographHtmlForTab(html, 'pharmacokinetics')).toBe(
      '<section data-monograph-section="pk"><p>half-life</p></section>',
    );
    expect(filterMonographHtmlForTab(html, 'postmortem')).toBe('');
  });

  it('shows text outside any section on the chemistry tab', () => {
    const legacy = '<h2>Intro</h2><p>Free text</p>';
    expect(filterMonographHtmlForTab(legacy, 'chemistry')).toBe(legacy);
    expect(filterMonographHtmlForTab(legacy, 'pharmacokinetics')).toBe('');
    expect(
      filterMonographHtmlForTab(
        `<p>lead</p>${section('pk', '<p>x</p>')}`,
        'chemistry',
      ),
    ).toBe('<p>lead</p>');
  });

  it('opens a deep-linked parameter on the tab that shows it', () => {
    expect(tabForParameter('halfLife')).toBe('pharmacokinetics');
    expect(tabForParameter('analyteStability')).toBe('analytics_detection');
    // Ungrouped metadata (names, aliases) lives with the drug's identity.
    expect(tabForParameter('aliases')).toBe('chemistry');
    expect(tabForParameter('notAParameter')).toBeNull();
  });

  it('recognises only known tab ids', () => {
    expect(isMonographTabId('postmortem')).toBe(true);
    expect(isMonographTabId('edit')).toBe(false);
    expect(isMonographTabId(undefined)).toBe(false);
  });
});
