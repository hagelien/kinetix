import { describe, expect, it } from 'vitest';
import {
  materializePaperReviewForApproval,
  materializeFactForApproval,
  WikiFactApprovalError,
} from '../../api/_lib/pending-edits-helpers';
import type { pendingEdits } from '../../db/schema';
import { createFactNode } from '../../src/lib/monographContent';

type Edit = typeof pendingEdits.$inferSelect;

function makeEdit(overrides: Partial<Edit>): Edit {
  return {
    id: 1,
    editType: 'wiki_fact',
    targetId: 42,
    parameter: null,
    proposedValue: null,
    proposedMeta: null,
    referenceId: null,
    referenceIds: null,
    status: 'pending',
    rejectionReason: null,
    rejectionComment: null,
    sectionId: 'pd',
    fieldId: null,
    factStatement: 'claim',
    factOperation: 'add',
    factTargetAnchor: null,
    submittedBy: 1,
    reviewedBy: null,
    submittedAt: new Date(),
    reviewedAt: null,
    ...overrides,
  } as Edit;
}

describe('materializeFactForApproval', () => {
  it('refreshes embedded referenceIds from the column when PATCH has changed them', () => {
    // POST-time fact had refs [1,2]; submitter then PATCHed referenceIds → [9,10].
    const stored = createFactNode({
      factId: 'fact-uuid',
      statement: 'old claim',
      referenceIds: [1, 2],
    });
    const edit = makeEdit({
      factStatement: 'old claim',
      proposedValue: stored as never,
      referenceIds: [9, 10],
    });

    const node = materializeFactForApproval(edit);

    expect(node.attrs.factId).toBe('fact-uuid');
    expect(node.attrs.referenceIds).toEqual([9, 10]);
    // Body content stays untouched — only refs are resynced.
    expect(node.content).toEqual(stored.content);
  });

  it('falls back to the singular referenceId column when referenceIds is empty', () => {
    const stored = createFactNode({
      factId: 'fact-uuid',
      statement: 'claim',
      referenceIds: [1],
    });
    const edit = makeEdit({
      proposedValue: stored as never,
      referenceIds: null,
      referenceId: 7,
    });

    const node = materializeFactForApproval(edit);
    expect(node.attrs.referenceIds).toEqual([7]);
  });

  it('throws WikiFactApprovalError when proposedValue is not a fact node', () => {
    const edit = makeEdit({
      proposedValue: { type: 'paragraph' } as never,
      referenceIds: [1],
    });
    expect(() => materializeFactForApproval(edit)).toThrow(
      WikiFactApprovalError,
    );
  });

  it('refuses approval when proposedValue text diverges from factStatement', () => {
    const stored = createFactNode({
      factId: 'fact-uuid',
      statement: 'hidden replacement claim',
      referenceIds: [1],
    });
    const edit = makeEdit({
      factStatement: 'benign reviewed claim',
      proposedValue: stored as never,
      referenceIds: [1],
    });

    expect(() => materializeFactForApproval(edit)).toThrow(/does not match/);
  });

  it('rejects an empty/whitespace factId so anchoring stays well-formed', () => {
    const empty = createFactNode({
      factId: '   ',
      statement: 'claim',
      referenceIds: [1],
    });
    const edit = makeEdit({ proposedValue: empty as never, referenceIds: [1] });
    expect(() => materializeFactForApproval(edit)).toThrow(/non-empty string/);
  });

  it('on replace ops, refuses a factId that drifted from the anchor', () => {
    // PATCH could rewrite proposedValue and break the contract that the
    // embedded factId must equal factTargetAnchor.factId. Catch it
    // early at materialize for a clearer reviewer-facing error.
    const stored = createFactNode({
      factId: 'drifted',
      statement: 'claim',
      referenceIds: [1],
    });
    const edit = makeEdit({
      factOperation: 'replace',
      factTargetAnchor: { factId: 'original' } as never,
      proposedValue: stored as never,
      referenceIds: [1],
    });
    expect(() => materializeFactForApproval(edit)).toThrow(/does not match/);
  });
});

describe('materializePaperReviewForApproval', () => {
  it('normalizes nullable optional fields after schema validation', () => {
    const value = materializePaperReviewForApproval({
      reviewMarkdown: 'Review body',
      overallScore: null,
      conclusionSupport: null,
      reviewConfidence: null,
      readInFull: true,
    });

    expect(value).toEqual({
      reviewMarkdown: 'Review body',
      overallScore: null,
      conclusionSupport: null,
      reviewConfidence: null,
      readInFull: true,
    });
  });

  it('defaults a missing read-in-full attestation to false (legacy pending rows)', () => {
    const value = materializePaperReviewForApproval({
      reviewMarkdown: 'Legacy review with no attestation',
    });

    expect(value.readInFull).toBe(false);
  });

  it('rejects out-of-contract pending review payloads', () => {
    expect(() =>
      materializePaperReviewForApproval({
        reviewMarkdown: 'Review body',
        overallScore: 101,
        reviewConfidence: 'certain',
      }),
    ).toThrow(WikiFactApprovalError);
  });
});

describe('WikiFactApprovalError', () => {
  it('defaults statusHint to 400 and accepts an override', () => {
    const a = new WikiFactApprovalError('boom');
    expect(a.statusHint).toBe(400);
    const b = new WikiFactApprovalError('not found', 404);
    expect(b.statusHint).toBe(404);
    expect(b.message).toBe('not found');
    expect(b instanceof Error).toBe(true);
  });
});
