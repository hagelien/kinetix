import { describe, expect, it } from 'vitest';
import {
  changesWikiFactId,
  materializePatchedWikiFactProposedValue,
  factContentPlaintext,
  isOpenPaperReviewConflict,
  sanitizeFactHref,
  sanitizeSubmittedFactContent,
} from '../../api/pending-edits';

describe('pending edit fact content sanitizing', () => {
  it('preserves adjacent inline text boundaries when validating rich fact content', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'morphine',
              marks: [{ type: 'link', attrs: { href: '/wiki/morphine' } }],
            },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };

    expect(factContentPlaintext(content.content)).toBe('morphine.');
    expect(sanitizeSubmittedFactContent(content, 'morphine.')).toEqual(
      content.content,
    );
  });

  it('rejects arbitrary relative fact links while allowing explicit safe links', () => {
    expect(sanitizeFactHref('morphine')).toBeNull();
    expect(sanitizeFactHref('../wiki/morphine')).toBeNull();
    expect(sanitizeFactHref('//example.com/wiki/morphine')).toBeNull();
    expect(sanitizeFactHref('javascript:alert(1)')).toBeNull();

    expect(sanitizeFactHref('/wiki/morphine')).toBe('/wiki/morphine');
    expect(sanitizeFactHref('#kinetics')).toBe('#kinetics');
    expect(sanitizeFactHref('https://example.com/article')).toBe(
      'https://example.com/article',
    );
    expect(sanitizeFactHref('mailto:test@example.com')).toBe(
      'mailto:test@example.com',
    );
  });

  it('rejects /wiki/ paths that traverse out of /wiki/ after normalization', () => {
    // /wiki/../../api/admin resolves to /api/admin — must be rejected.
    expect(sanitizeFactHref('/wiki/../../api/admin')).toBeNull();
    expect(sanitizeFactHref('/wiki/../api')).toBeNull();
    expect(sanitizeFactHref('/wiki/morphine/../../api')).toBeNull();
    // Redundant traversal that stays inside /wiki/ is fine.
    expect(sanitizeFactHref('/wiki/../wiki/morphine')).toBe('/wiki/morphine');
    // Normal /wiki/ paths are unaffected.
    expect(sanitizeFactHref('/wiki/morphine')).toBe('/wiki/morphine');
    expect(sanitizeFactHref('/wiki/drugs/ketamine')).toBe(
      '/wiki/drugs/ketamine',
    );
  });
});

describe('pending edit patch guards', () => {
  it('detects wiki_fact proposedValue factId rewrites', () => {
    const edit = {
      editType: 'wiki_fact',
      proposedValue: { type: 'fact', attrs: { factId: 'original' } },
    };

    expect(
      changesWikiFactId(edit, { type: 'fact', attrs: { factId: 'original' } }),
    ).toBe(false);
    expect(
      changesWikiFactId(edit, { type: 'fact', attrs: { factId: 'changed' } }),
    ).toBe(true);
    expect(
      changesWikiFactId(
        { editType: 'parameter', proposedValue: edit.proposedValue },
        { type: 'fact', attrs: { factId: 'changed' } },
      ),
    ).toBe(false);
  });

  it('canonicalizes patched wiki_fact bodies to the reviewed statement', () => {
    const edit = {
      editType: 'wiki_fact',
      factOperation: 'add',
      factStatement: 'benign reviewed claim',
      proposedValue: { type: 'fact', attrs: { factId: 'original' } },
    };

    const next = materializePatchedWikiFactProposedValue(
      edit,
      {
        type: 'fact',
        attrs: { factId: 'original', referenceIds: [999] },
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'benign reviewed claim' }],
          },
        ],
      },
      [3, 4],
    ) as { attrs: { factId: string; referenceIds: number[] } };

    expect(next.attrs.factId).toBe('original');
    expect(next.attrs.referenceIds).toEqual([3, 4]);
  });

  it('rejects patched wiki_fact bodies that diverge from the reviewed statement', () => {
    const edit = {
      editType: 'wiki_fact',
      factOperation: 'add',
      factStatement: 'benign reviewed claim',
      proposedValue: { type: 'fact', attrs: { factId: 'original' } },
    };

    expect(() =>
      materializePatchedWikiFactProposedValue(
        edit,
        {
          type: 'fact',
          attrs: { factId: 'original' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'hidden replacement claim' }],
            },
          ],
        },
        [1],
      ),
    ).toThrow(/must match/);
  });

  it('recognizes the open paper-review unique-index conflict through wrapped errors', () => {
    expect(
      isOpenPaperReviewConflict({
        cause: {
          code: '23505',
          constraint: 'pending_edits_open_paper_review_idx',
        },
      }),
    ).toBe(true);

    expect(isOpenPaperReviewConflict({ code: '23505' })).toBe(false);
  });
});
