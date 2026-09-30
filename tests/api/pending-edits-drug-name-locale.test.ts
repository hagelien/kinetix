import { describe, expect, it } from 'vitest';

import { enrichFromMaps } from '../../api/pending-edits.ts';

type Row = Parameters<typeof enrichFromMaps>[0];
type Maps = Parameters<typeof enrichFromMaps>[1];

// Regression for the /review queue showing English drug names on a
// Norwegian-default site: a `parameter` (or `metabolism`) pending edit must
// surface the drug's Norwegian (`nb`) name — the site's primary language —
// not its English (`en`) name. See AGENTS.md "Bilingual data columns" (nb is
// primary) and `activeLangCode` defaulting to `nb`.
describe('pending-edits enrichment — drug name localisation', () => {
  function makeMaps(drug: { id: number; names: Record<string, string> }): Maps {
    return {
      userMap: new Map(),
      citationMap: new Map(),
      drugMap: new Map([[drug.id, drug]]),
      pageMap: new Map(),
      monographSlugMap: new Map(),
      drugParamsMap: new Map(),
      currentParamReferencesMap: new Map(),
      verificationMap: new Map(),
    } as unknown as Maps;
  }

  function makeRow(
    editType: 'parameter' | 'metabolism',
    targetId: number,
  ): Row {
    return {
      id: 1,
      editType,
      targetId,
      parameter: null,
      proposedValue: null,
      proposedMeta: null,
      referenceId: null,
      referenceIds: null,
      status: 'pending',
      submittedBy: 7,
      reviewedBy: null,
      submittedAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as Row;
  }

  it('resolves a parameter edit drug name in Norwegian, not English', () => {
    const drug = {
      id: 42,
      slug: 'etylglukuronid',
      names: { nb: 'Etylglukuronid', en: 'Ethyl glucuronide' },
    };
    const enriched = enrichFromMaps(makeRow('parameter', 42), makeMaps(drug));
    expect(enriched.drugName).toBe('Etylglukuronid');
    expect(enriched.drugSlug).toBe('etylglukuronid');
  });

  it('resolves a metabolism edit drug name in Norwegian, not English', () => {
    const drug = {
      id: 99,
      slug: 'morfin',
      names: { nb: 'Morfin', en: 'Morphine' },
    };
    const enriched = enrichFromMaps(makeRow('metabolism', 99), makeMaps(drug));
    expect(enriched.drugName).toBe('Morfin');
  });

  it('falls back to English when no Norwegian name exists', () => {
    const drug = {
      id: 7,
      slug: 'ethyl-glucuronide',
      names: { en: 'Ethyl glucuronide' },
    };
    const enriched = enrichFromMaps(makeRow('parameter', 7), makeMaps(drug));
    expect(enriched.drugName).toBe('Ethyl glucuronide');
  });

  it('returns the wiki page slug for wiki fact review cards', () => {
    const row = {
      ...makeRow('parameter', 12),
      editType: 'wiki_fact',
      targetId: 12,
      factOperation: 'add',
      factTargetAnchor: null,
    } as unknown as Row;
    const maps = {
      userMap: new Map(),
      citationMap: new Map(),
      drugMap: new Map(),
      pageMap: new Map([
        [
          12,
          {
            id: 12,
            title: 'Ethyl glucuronide',
            slug: 'ethyl-glucuronide',
            content: null,
            contentHtml: null,
            pageType: 'drug_monograph',
            drugCid: null,
          },
        ],
      ]),
      drugParamsMap: new Map(),
      currentParamReferencesMap: new Map(),
      verificationMap: new Map(),
    } as unknown as Maps;

    const enriched = enrichFromMaps(row, maps);

    expect(enriched.pageTitle).toBe('Ethyl glucuronide');
    expect(enriched.pageSlug).toBe('ethyl-glucuronide');
  });

  it('resolves the Norwegian drug name for a wiki_fact monograph card', () => {
    // Regression: the review queue showed the monograph page's stored English
    // title ("Valproic acid") for an atomic-fact edit instead of the drug's
    // canonical Norwegian name ("Valproat"). The card prefers drugName over
    // pageTitle, so drugName must be resolved from the linked drug.
    const row = {
      ...makeRow('parameter', 55),
      editType: 'wiki_fact',
      targetId: 55,
      factOperation: 'add',
      factTargetAnchor: null,
    } as unknown as Row;
    const maps = {
      userMap: new Map(),
      citationMap: new Map(),
      drugMap: new Map([
        [
          800,
          {
            id: 800,
            slug: 'valproat',
            names: { nb: 'Valproat', en: 'Valproic acid' },
          },
        ],
      ]),
      pageMap: new Map([
        [
          55,
          {
            id: 55,
            title: 'Valproic acid',
            slug: 'valproic-acid',
            content: null,
            contentHtml: null,
            pageType: 'drug_monograph',
            drugCid: 800,
          },
        ],
      ]),
      monographSlugMap: new Map(),
      drugParamsMap: new Map(),
      currentParamReferencesMap: new Map(),
      verificationMap: new Map(),
    } as unknown as Maps;

    const enriched = enrichFromMaps(row, maps);

    expect(enriched.drugName).toBe('Valproat');
    expect(enriched.pageTitle).toBe('Valproic acid');
    expect(enriched.pageSlug).toBe('valproic-acid');
  });

  it('leaves drugName unset for a non-monograph wiki_fact card', () => {
    const row = {
      ...makeRow('parameter', 60),
      editType: 'wiki_fact',
      targetId: 60,
      factOperation: 'add',
      factTargetAnchor: null,
    } as unknown as Row;
    const maps = {
      userMap: new Map(),
      citationMap: new Map(),
      drugMap: new Map(),
      pageMap: new Map([
        [
          60,
          {
            id: 60,
            title: 'Alkoholmetabolisme',
            slug: 'alkoholmetabolisme',
            content: null,
            contentHtml: null,
            pageType: 'topic',
            drugCid: null,
          },
        ],
      ]),
      monographSlugMap: new Map(),
      drugParamsMap: new Map(),
      currentParamReferencesMap: new Map(),
      verificationMap: new Map(),
    } as unknown as Maps;

    const enriched = enrichFromMaps(row, maps);

    expect(enriched.drugName).toBeUndefined();
    expect(enriched.pageTitle).toBe('Alkoholmetabolisme');
  });
});
