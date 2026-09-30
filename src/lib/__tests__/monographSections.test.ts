import { describe, expect, it } from 'vitest';
import { DRUG_PARAMETERS, isDrugParameterId } from '../drugParameters';
import {
  MONOGRAPH_SECTIONS,
  MONOGRAPH_SECTION_IDS,
  getMonographField,
  getMonographSection,
  getParameterAnchoredFields,
  getPendingAnchorFields,
  isMergedMonographFieldId,
  isMonographSectionId,
} from '../monographSections';

describe('monograph section schema', () => {
  it('exposes the remaining 9 sections in order (3 removed by #396, case_templates + evidence removed)', () => {
    expect(MONOGRAPH_SECTIONS).toHaveLength(9);
    MONOGRAPH_SECTIONS.forEach((s, i) => {
      expect(s.order).toBe(i + 1);
    });
  });

  it('does not expose the removed case_templates / evidence sections', () => {
    // "Saksspesifikke tolkningsmaler" (case_templates) and "Evidenskvalitet
    // og kildenoter" (evidence) were retired as fact categories; their bodies
    // are stripped from stored content and no longer targetable.
    for (const removed of ['case_templates', 'evidence']) {
      expect(isMonographSectionId(removed)).toBe(false);
    }
  });

  it('section ids list matches the sections array', () => {
    expect(MONOGRAPH_SECTIONS.map((s) => s.id)).toEqual(
      MONOGRAPH_SECTION_IDS as readonly string[],
    );
    for (const id of MONOGRAPH_SECTION_IDS) {
      expect(isMonographSectionId(id)).toBe(true);
      expect(getMonographSection(id).id).toBe(id);
    }
    expect(isMonographSectionId('not-a-section')).toBe(false);
  });

  it('does not expose the sections removed in #396', () => {
    // Sammendrag / hurtigoversikt / stoffidentitet og kjemi were removed
    // from the main monograph content view in #396; the numeric content
    // they used to host now lives only in the right-side parameter box.
    for (const removed of ['summary', 'key_facts', 'chemistry']) {
      expect(isMonographSectionId(removed)).toBe(false);
    }
  });

  it('section ids and field ids are unique', () => {
    const ids = new Set<string>();
    for (const s of MONOGRAPH_SECTIONS) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      const fieldIds = new Set<string>();
      for (const f of s.fields) {
        expect(fieldIds.has(f.id)).toBe(false);
        fieldIds.add(f.id);
      }
    }
  });

  it('has no inline parameter-kind fields in the main content (#396)', () => {
    // The right-side drug parameter box owns every numeric value; the main
    // monograph schema must not declare any parameter-kind anchors so the
    // renderer cannot accidentally splice tabular values back inline.
    const anchored = getParameterAnchoredFields();
    expect(anchored).toEqual([]);
    for (const s of MONOGRAPH_SECTIONS) {
      for (const f of s.fields) {
        expect(f.kind).not.toBe('parameter');
      }
    }
    // Sanity: the drug-parameter registry stays the source of truth for
    // the sidebar — confirm it isn't accidentally empty.
    expect(Object.keys(DRUG_PARAMETERS).length).toBeGreaterThan(0);
    expect(isDrugParameterId('halfLife')).toBe(true);
  });

  it('does not expose fact sub-categories as schema fields (#458)', () => {
    expect(getPendingAnchorFields()).toEqual([]);
    for (const section of MONOGRAPH_SECTIONS) {
      expect(section.fields).toEqual([]);
    }
    expect(isMergedMonographFieldId('effects', 'cardiovascular')).toBe(true);
    expect(isMergedMonographFieldId('analytical', 'matrix_blood')).toBe(true);
    expect(isMergedMonographFieldId('pk', 'half_life')).toBe(false);
  });

  it('getMonographField resolves known and unknown ids', () => {
    expect(getMonographField('pk', 'cmax')).toBeNull();
    expect(getMonographField('pk', 'no_such_field')).toBeNull();
    // Retired sub-category ids are tracked separately so old field bodies
    // can be merged into parent sections without keeping them targetable.
    expect(getMonographField('effects', 'cardiovascular')).toBeNull();
    expect(getMonographField('effects', 'cardiovasculr')).toBeNull();
  });
});
