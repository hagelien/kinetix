import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  getConfigDb: vi.fn(),
  runInPoolTransaction: vi.fn(),
  withDbRetry: vi.fn(),
  afterTransactionCommit: vi.fn(),
}));

import {
  paramEntryPayloadCitationId,
  validateParameterEntrySubmitterPatch,
} from '../../api/pending-edits.ts';

/**
 * The generic pending-edit PATCH used to write a `param_entry` proposal's
 * payload through unvalidated: only `parameter` and `wiki_fact` were gated.
 * A revision could therefore store a payload the approval will refuse, and
 * the refusal (`param_entry_invalid_payload`) reached a REVIEWER — who cannot
 * fix someone else's payload — instead of its author at the moment they wrote
 * it. This is that gate.
 */

type Edit = Parameters<typeof validateParameterEntrySubmitterPatch>[0];

/** An update proposal on entry #77 (therapeuticConcentration), citing #3283. */
function updateEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    editType: 'param_entry',
    parameter: 'therapeuticConcentration',
    targetId: 77,
    proposedValue: { op: 'update', patch: validPatch() },
    ...overrides,
  } as Edit;
}

function validPatch() {
  return {
    low: 1000,
    high: 4000,
    unit: 'nmol/L',
    matrix: 'serum',
    scenario: 'living_therapeutic',
    comments: 'Diakonhjemmet sykehus, referanseområde for legemiddelmonitorering',
    citationId: 3283,
  };
}

describe('validateParameterEntrySubmitterPatch', () => {
  it('ignores every edit type but param_entry', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        { editType: 'wiki_fact', parameter: null, targetId: 1, proposedValue: {} } as Edit,
        { anything: true },
        null,
      ),
    ).toBeNull();
  });

  it('accepts a well-formed update whose citation the row lists', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit(),
        { op: 'update', patch: validPatch() },
        [3283],
      ),
    ).toBeNull();
  });

  it('accepts a delete revised into an update that brings its reference along', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit({ proposedValue: { op: 'delete' } }),
        { op: 'update', patch: validPatch() },
        [3283],
      ),
    ).toBeNull();
  });

  // The shape an agent produces by copying the live entry into a patch: the
  // API hands back DB nulls for the fields the entry does not use, and the
  // schema's `.optional()` accepts absent, not null. It renders fine on the
  // review card (which tests `!= null`), so nothing showed until approval.
  it('rejects a patch carrying nulls for the fields it leaves alone', () => {
    const result = validateParameterEntrySubmitterPatch(
      updateEdit(),
      {
        op: 'update',
        patch: { ...validPatch(), route: null, n: null, qualifier: null },
      },
      [3283],
    );
    expect(result?.code).toBe('param_entry_invalid_payload');
    expect(result?.message).toContain('route');
  });

  it('rejects a payload that is not a source-value operation at all', () => {
    expect(
      validateParameterEntrySubmitterPatch(updateEdit(), { min: 1, max: 2 }, [
        3283,
      ])?.code,
    ).toBe('param_entry_invalid_payload');
  });

  it('rejects a unit the parameter does not allow', () => {
    const result = validateParameterEntrySubmitterPatch(
      updateEdit(),
      { op: 'update', patch: { ...validPatch(), unit: 'kg' } },
      [3283],
    );
    expect(result?.code).toBe('param_entry_invalid_for_parameter');
  });

  // `targetId` is the drug for a create and the entry for update/delete, so a
  // switch across that boundary silently re-reads the id as the other kind.
  it('refuses to switch a create into an update', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit({
          proposedValue: {
            op: 'create',
            input: { ...validPatch(), drugId: 77, parameter: 'therapeuticConcentration' },
          },
        }),
        { op: 'update', patch: validPatch() },
        [3283],
      )?.code,
    ).toBe('param_entry_target_mismatch');
  });

  it('refuses to switch an update into a create', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit(),
        {
          op: 'create',
          input: { ...validPatch(), drugId: 77, parameter: 'therapeuticConcentration' },
        },
        [3283],
      )?.code,
    ).toBe('param_entry_target_mismatch');
  });

  // Drug ids and entry ids are independent sequences that overlap, so a row
  // whose stored op is unreadable cannot say which kind `targetId` holds —
  // "repairing" it either way could aim the approval at an unrelated row.
  it.each([
    ['a missing op', { patch: validPatch() }],
    ['an unrecognized op', { op: 'replace', patch: validPatch() }],
    ['a payload that is not an object', 'delete'],
    ['no payload at all', null],
  ])('refuses to revise a proposal with %s stored', (_label, stored) => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit({ proposedValue: stored as Edit['proposedValue'] }),
        { op: 'update', patch: validPatch() },
        [3283],
      )?.code,
    ).toBe('param_entry_target_mismatch');
  });

  it('rejects a create retargeted at another drug or parameter', () => {
    const createEdit = updateEdit({
      targetId: 42,
      proposedValue: {
        op: 'create',
        input: { ...validPatch(), drugId: 42, parameter: 'therapeuticConcentration' },
      },
    });
    expect(
      validateParameterEntrySubmitterPatch(
        createEdit,
        {
          op: 'create',
          input: { ...validPatch(), drugId: 43, parameter: 'therapeuticConcentration' },
        },
        [3283],
      )?.code,
    ).toBe('param_entry_target_mismatch');
  });

  // A delete is queued with no reference at all, so a delete→update revision
  // that adds a citation has to send `referenceIds` in the same PATCH — the
  // approval reads the citation gate off the pending row, not the payload.
  it('rejects a citation the proposal does not list', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit({ proposedValue: { op: 'delete' } }),
        { op: 'update', patch: validPatch() },
        null,
      )?.code,
    ).toBe('param_entry_citation_mismatch');
  });

  it('lets a delete stay a delete, which carries no citation', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit({ proposedValue: { op: 'delete' } }),
        { op: 'delete' },
        null,
      ),
    ).toBeNull();
  });
});

/**
 * The reviewer's return-with-changes rewrites `proposedValue` too, and that
 * write was the last `param_entry` payload path with no rules on it. What it
 * stored went back to the AUTHOR, whose own resubmit is gated — so a
 * reviewer's correction could leave a proposal both unapprovable and
 * unresubmittable, refused for a rewrite its author never made. Same checks,
 * same codes; only the advice differs, since a reviewer cannot withdraw
 * someone else's proposal.
 */
describe('validateParameterEntrySubmitterPatch (reviewer audience)', () => {
  it('accepts a reviewer rewrite the approval would accept', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit(),
        { op: 'update', patch: validPatch() },
        [3283],
        'reviewer',
      ),
    ).toBeNull();
  });

  // The shape that reached a reviewer in production: a qualifying sentence
  // written into `qualifier`, which takes only '<', '>', '≤', '≥'.
  it('refuses a reviewer rewrite that puts free text in qualifier', () => {
    const result = validateParameterEntrySubmitterPatch(
      updateEdit(),
      {
        op: 'update',
        patch: { ...validPatch(), qualifier: 'apparent, fm fixed at 0.1' },
      },
      [3283],
      'reviewer',
    );
    expect(result?.code).toBe('param_entry_invalid_payload');
    expect(result?.message).toContain('qualifier');
  });

  it('refuses a reviewer rewrite citing a reference the row does not list', () => {
    expect(
      validateParameterEntrySubmitterPatch(
        updateEdit(),
        { op: 'update', patch: validPatch() },
        [4001],
        'reviewer',
      )?.code,
    ).toBe('param_entry_citation_mismatch');
  });

  it('tells a reviewer to return the proposal, not to withdraw it', () => {
    const result = validateParameterEntrySubmitterPatch(
      updateEdit(),
      {
        op: 'create',
        input: { ...validPatch(), drugId: 77, parameter: 'therapeuticConcentration' },
      },
      [3283],
      'reviewer',
    );
    expect(result?.code).toBe('param_entry_target_mismatch');
    expect(result?.message).toContain('Return it unchanged');
    expect(result?.message).not.toContain('Withdraw');
  });
});

/**
 * The read-in-full gate the PATCH handler runs for a source value reads its
 * citation from the payload, not from the row's `referenceIds` — matching what
 * `applyApprovedParameterEntry` gates. Reading the whole reference set instead
 * would refuse revisions the approval accepts.
 */
describe('paramEntryPayloadCitationId', () => {
  it('reads the citation a create would publish', () => {
    expect(
      paramEntryPayloadCitationId({
        op: 'create',
        input: {
          ...validPatch(),
          drugId: 77,
          parameter: 'therapeuticConcentration',
        },
      }),
    ).toBe(3283);
  });

  it('reads the citation an update would publish', () => {
    expect(
      paramEntryPayloadCitationId({ op: 'update', patch: validPatch() }),
    ).toBe(3283);
  });

  it.each([
    ['a delete, which publishes none', { op: 'delete' }],
    ['a payload that does not parse', { op: 'update', patch: { low: 1 } }],
    ['a payload that is not an operation', { citationId: 3283 }],
    ['no payload', null],
  ])('is null for %s', (_label, payload) => {
    expect(paramEntryPayloadCitationId(payload)).toBeNull();
  });
});
