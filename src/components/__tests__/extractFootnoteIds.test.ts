import { describe, expect, it } from 'vitest';
import { extractFootnoteIds } from '../wiki/WikiRenderer';
import type { MonographContentV2 } from '@/lib/monographContent';

const FOOTNOTED_BODY = {
  type: 'doc' as const,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Claim' },
        { type: 'footnote', attrs: { referenceId: 7 } },
      ],
    },
  ],
};

describe('extractFootnoteIds', () => {
  it('walks v1 free-form docs', () => {
    expect(extractFootnoteIds(FOOTNOTED_BODY)).toEqual([7]);
  });

  it('walks v2 monograph envelopes across section bodies and field bodies', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: { body: FOOTNOTED_BODY },
        effects: {
          fields: {
            cardiovascular: {
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'footnote', attrs: { referenceId: 13 } }],
                  },
                ],
              },
            },
          },
        },
      },
    };
    expect(extractFootnoteIds(content).sort((a, b) => a - b)).toEqual([7, 13]);
  });

  it('walks fact-node referenceIds (issue #284) so the bibliography sees them', () => {
    const content: MonographContentV2 = {
      version: 2,
      sections: {
        pd: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'fact',
                attrs: { factId: 'aaaa', referenceIds: [12, 34] },
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'claim' }] },
                ],
              },
            ],
          },
        },
      },
    };
    expect(extractFootnoteIds(content).sort((a, b) => a - b)).toEqual([12, 34]);
  });

  it('returns [] for null/undefined/non-object input', () => {
    expect(extractFootnoteIds(null)).toEqual([]);
    expect(extractFootnoteIds(undefined)).toEqual([]);
    expect(extractFootnoteIds('not a doc')).toEqual([]);
  });

  it('skips refs that live under field slots removed by #396 (e.g. pk.half_life)', () => {
    // The PK section is still authored; its `half_life` / `bioavailability`
    // / `tmax` / … parameter fields are not. Refs that live exclusively
    // under those orphaned field slots must be ignored so the references
    // panel doesn't list sources whose inline marker has been dropped.
    const content = {
      version: 2 as const,
      sections: {
        pd: { body: FOOTNOTED_BODY },
        pk: {
          fields: {
            half_life: {
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'footnote', attrs: { referenceId: 201 } }],
                  },
                ],
              },
            },
            bioavailability: {
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'fact',
                    attrs: { factId: 'orphan-pk', referenceIds: [202] },
                    content: [{ type: 'paragraph' }],
                  },
                ],
              },
            },
            // `cmax` survives — its refs must still be collected.
            cmax: {
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'footnote', attrs: { referenceId: 203 } }],
                  },
                ],
              },
            },
          },
        },
      },
    } as unknown as MonographContentV2;
    expect(extractFootnoteIds(content).sort((a, b) => a - b)).toEqual([7, 203]);
  });

  it('skips refs that live under sections removed by #396', () => {
    // Existing rows may still have footnotes/fact refs stored under
    // `summary` / `key_facts` / `chemistry`. The renderer strips those
    // section blocks from the rendered HTML, so the bibliography panel
    // must skip their refs too — otherwise the references list would
    // show orphan sources whose inline marker is no longer visible.
    const content = {
      version: 2 as const,
      sections: {
        pd: { body: FOOTNOTED_BODY },
        // Cast through unknown — the removed ids are no longer in the
        // `MonographSectionId` union, but real DB rows authored before
        // #396 can still carry them.
        summary: {
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'footnote', attrs: { referenceId: 99 } }],
              },
            ],
          },
        },
        chemistry: {
          fields: {
            iupac_name: {
              refs: [101],
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'fact',
                    attrs: { factId: 'orphan', referenceIds: [102] },
                    content: [{ type: 'paragraph' }],
                  },
                ],
              },
            },
          },
        },
      },
    } as unknown as MonographContentV2;
    expect(extractFootnoteIds(content).sort((a, b) => a - b)).toEqual([7]);
  });
});
