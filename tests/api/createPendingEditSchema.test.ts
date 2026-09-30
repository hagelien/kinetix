import { describe, expect, it } from 'vitest';
import {
  createPendingEditSchema,
  patchPendingEditSchema,
} from '../../api/_lib/schemas';

function expectIssue(input: unknown, path: string, fragment: string | RegExp) {
  const result = createPendingEditSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues.find((i) => i.path.join('.') === path);
  if (!issue) {
    throw new Error(
      `expected an issue at "${path}" but got: ` +
        JSON.stringify(result.error.issues, null, 2),
    );
  }
  if (typeof fragment === 'string') {
    expect(issue.message).toContain(fragment);
  } else {
    expect(issue.message).toMatch(fragment);
  }
}

describe('createPendingEditSchema — legacy editTypes still accepted', () => {
  it('parses a parameter edit with the existing field set', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'parameter',
      targetId: 1,
      parameter: 'halfLife',
      proposedValue: { min: 2, max: 4, unit: 'h' },
      referenceId: 99,
    });
    expect(result.success).toBe(true);
  });

  it('parses a wiki_page edit', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_page',
      targetId: 1,
      proposedValue: { type: 'doc', content: [] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts granular reviewer rejection reasons', () => {
    for (const rejectionReason of ['too_general', 'too_detailed'] as const) {
      const result = patchPendingEditSchema.safeParse({
        status: 'rejected',
        rejectionReason,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts returning an edit when the reviewer supplies a comment or payload change', () => {
    expect(
      patchPendingEditSchema.safeParse({
        status: 'returned',
        returnComment: 'Please tighten the wording.',
      }).success,
    ).toBe(true);

    expect(
      patchPendingEditSchema.safeParse({
        status: 'returned',
        proposedValue: { value: 12 },
      }).success,
    ).toBe(true);
  });

  it('rejects returning an edit without reviewer feedback or changes', () => {
    const result = patchPendingEditSchema.safeParse({ status: 'returned' });
    expect(result.success).toBe(false);
  });
});

describe('createPendingEditSchema — wiki_fact', () => {
  it('accepts a valid `add` payload', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 42,
      sectionId: 'pd',
      factOperation: 'add',
      factStatement: 'Morfin er en full agonist på μ-opioidreseptoren',
      referenceIds: [12, 34],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid `replace` payload', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 42,
      sectionId: 'pd',
      factOperation: 'replace',
      factStatement: 'Updated claim',
      referenceIds: [12],
      factTargetAnchor: { factId: 'aaaa-bbbb' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid `remove` payload (no statement, no refs needed)', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 42,
      sectionId: 'pd',
      factOperation: 'remove',
      factTargetAnchor: { factId: 'aaaa-bbbb' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when targetId is missing', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        sectionId: 'pd',
        factOperation: 'add',
        factStatement: 's',
        referenceIds: [1],
      },
      'targetId',
      'targetId',
    );
  });

  it('rejects when sectionId is missing', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        factOperation: 'add',
        factStatement: 's',
        referenceIds: [1],
      },
      'sectionId',
      'sectionId',
    );
  });

  it('rejects when factOperation is missing', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
      },
      'factOperation',
      'factOperation',
    );
  });

  it('rejects `add` without a statement', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
        factOperation: 'add',
        referenceIds: [1],
      },
      'factStatement',
      'factStatement is required for add/replace',
    );
  });

  it('rejects `add` without references', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
        factOperation: 'add',
        factStatement: 's',
      },
      'referenceIds',
      'referenceId is required for add/replace',
    );
  });

  it('accepts `add` with a single referenceId (legacy field)', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 1,
      sectionId: 'pd',
      factOperation: 'add',
      factStatement: 's',
      referenceId: 7,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an anchor on an `add` op (only meaningful for replace/remove)', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
        factOperation: 'add',
        factStatement: 's',
        referenceIds: [1],
        factTargetAnchor: { factId: 'stale-from-another-op' },
      },
      'factTargetAnchor',
      'not allowed on add ops',
    );
  });

  it('rejects `replace` without a target anchor', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
        factOperation: 'replace',
        factStatement: 's',
        referenceIds: [1],
      },
      'factTargetAnchor',
      'factTargetAnchor.factId is required',
    );
  });

  it('rejects `remove` without a target anchor', () => {
    expectIssue(
      {
        editType: 'wiki_fact',
        targetId: 1,
        sectionId: 'pd',
        factOperation: 'remove',
      },
      'factTargetAnchor',
      'factTargetAnchor.factId is required',
    );
  });

  it('parses a `remove` payload without proposedValue (server fills the marker)', () => {
    // The handler builds proposedValue = { removed: true, factId } itself;
    // this test pins that the schema does not require the caller to send it.
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 1,
      sectionId: 'pd',
      factOperation: 'remove',
      factTargetAnchor: { factId: 'aaaa-bbbb' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposedValue).toBeUndefined();
    }
  });

  it('caps factStatement at 400 characters', () => {
    const long = 'x'.repeat(401);
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_fact',
      targetId: 1,
      sectionId: 'pd',
      factOperation: 'add',
      factStatement: long,
      referenceIds: [1],
    });
    expect(result.success).toBe(false);
  });
});

describe('createPendingEditSchema — wiki_section', () => {
  it('accepts a valid `add` payload (sectionId minted at approval)', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_section',
      targetId: 42,
      proposedValue: {
        operation: 'add',
        headingText: 'Half-life',
        headingLevel: 2,
        position: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects `add` with a sectionId (must be minted server-side)', () => {
    expectIssue(
      {
        editType: 'wiki_section',
        targetId: 42,
        sectionId: 'half-life',
        proposedValue: {
          operation: 'add',
          headingText: 'Half-life',
          headingLevel: 2,
          position: 1,
        },
      },
      'sectionId',
      /minted at approval/,
    );
  });

  it('accepts a valid `edit` (rename) payload', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_section',
      targetId: 42,
      sectionId: 'pharmacology',
      proposedValue: {
        operation: 'edit',
        headingText: 'Pharmacology & ADME',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects `edit` without a sectionId', () => {
    expectIssue(
      {
        editType: 'wiki_section',
        targetId: 42,
        proposedValue: { operation: 'edit', headingText: 'X' },
      },
      'sectionId',
      /required/,
    );
  });

  it('accepts a valid `reorder` payload', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_section',
      targetId: 42,
      sectionId: 'pharmacology',
      proposedValue: { operation: 'reorder', position: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid `remove` payload', () => {
    const result = createPendingEditSchema.safeParse({
      editType: 'wiki_section',
      targetId: 42,
      sectionId: 'pharmacology',
      proposedValue: { operation: 'remove' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown operation', () => {
    expectIssue(
      {
        editType: 'wiki_section',
        targetId: 42,
        sectionId: 'pharmacology',
        proposedValue: { operation: 'merge' },
      },
      'proposedValue',
      /invalid proposedValue/,
    );
  });

  it('rejects missing targetId', () => {
    expectIssue(
      {
        editType: 'wiki_section',
        proposedValue: {
          operation: 'add',
          headingText: 'X',
          headingLevel: 2,
          position: 0,
        },
      },
      'targetId',
      /requires targetId/,
    );
  });
});

/**
 * `proposed_meta` is an open column by design — different edit types keep
 * different notes in it — but one key inside it is not commentary.
 *
 * `sourceQuote` is the provenance the consensus gate reads before deciding
 * whether a calculation-driving value may auto-publish. `/api/drug-parameter`
 * has always parsed it through `sourceQuoteSchema`; the pending-edit routes,
 * which are the path a proposal actually takes to publication, accepted
 * whatever was sent. So a proposal could carry — and publish with — a quote the
 * direct endpoint would have refused.
 */
describe('pending-edit proposedMeta — the quote obeys its own contract', () => {
  const OVERSIZE = 'x'.repeat(1001);

  const parameterEdit = (meta: unknown) => ({
    editType: 'parameter' as const,
    targetId: 1,
    parameter: 'halfLife',
    proposedValue: { low: 7, high: 9, unit: 'h' },
    referenceId: 5,
    proposedMeta: meta,
  });

  it.each([
    ['create', createPendingEditSchema],
    ['revise', patchPendingEditSchema],
  ])('rejects an over-long quote on %s', (_name, schema) => {
    const result = schema.safeParse(parameterEdit({ sourceQuote: OVERSIZE }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.path.join('.').endsWith('sourceQuote')),
    ).toBe(true);
  });

  it('rejects a quote that is not a string at all', () => {
    expect(
      patchPendingEditSchema.safeParse(parameterEdit({ sourceQuote: 42 }))
        .success,
    ).toBe(false);
  });

  // Normalized on the way in, so every downstream reader — the fingerprint, the
  // echo comparison, the stale-quote rule, the stored value — sees one form.
  it('stores the quote canonically rather than as typed', () => {
    const result = patchPendingEditSchema.safeParse(
      parameterEdit({ sourceQuote: '  Median Tmax\n\twas 2 h.  ', note: 'k' }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.proposedMeta).toEqual({
      sourceQuote: 'Median Tmax was 2 h.',
      // Everything else passes through: this narrows one key, it does not
      // close the column.
      note: 'k',
    });
  });

  it('folds a quote with nothing visible in it to no quote', () => {
    const result = patchPendingEditSchema.safeParse(
      parameterEdit({ sourceQuote: '​​ ­' }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      (result.data.proposedMeta as { sourceQuote: unknown }).sourceQuote,
    ).toBeNull();
  });

  // The column stays open for everything else, including metadata that has no
  // quote in it at all.
  it('leaves metadata without a quote untouched', () => {
    const meta = { editSummary: 'From the label.', reviewerNote: 'ok' };
    const result = patchPendingEditSchema.safeParse(parameterEdit(meta));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.proposedMeta).toEqual(meta);
  });
});
