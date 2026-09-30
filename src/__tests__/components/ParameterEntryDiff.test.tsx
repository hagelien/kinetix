import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ParameterEntryDiff } from '@/components/review/ParameterEntryDiff';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

function edit(
  proposedValue: unknown,
  over: Partial<PendingEditRow> = {},
): PendingEditRow {
  return {
    id: 1,
    editType: 'param_entry',
    targetId: 42,
    parameter: 'therapeuticConcentration',
    proposedValue,
    proposedMeta: null,
    referenceId: null,
    referenceIds: null,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    submitter: { id: 1, username: 'u', displayName: 'U', role: 'contributor' },
    verifications: [],
    ...over,
  } as unknown as PendingEditRow;
}

describe('ParameterEntryDiff', () => {
  it('renders a create proposal with the drug name, value and matrix', () => {
    render(
      <ParameterEntryDiff
        edit={edit(
          {
            op: 'create',
            input: {
              parameter: 'therapeuticConcentration',
              low: 10,
              high: 30,
              unit: 'mg/L',
              matrix: 'serum',
              scenario: 'living_therapeutic',
              citationId: 7,
            },
          },
          { drugName: 'Diazepam' },
        )}
      />,
    );
    // The target drug is named so the reviewer knows what changes.
    expect(screen.getByText('Diazepam')).toBeInTheDocument();
    expect(screen.getByText('10–30 mg/L')).toBeInTheDocument();
    // Matrix label (raw key, i18n not loaded).
    expect(
      screen.getByText('referenceConc.matrix.serum'),
    ).toBeInTheDocument();
  });

  it('names the dosed parent on a metabolite Cmax proposal (#1346)', () => {
    // Filed against the metabolite, dosed as its parent: the card has to say
    // which parent, or the reviewer cannot check the one fact that makes the
    // reading interpretable.
    render(
      <ParameterEntryDiff
        edit={edit(
          {
            op: 'create',
            input: {
              drugId: 42,
              parameter: 'cmax',
              valueBasis: 'concentration',
              centralValue: 84,
              centralStatistic: 'arithmetic_mean',
              unit: 'ng/mL',
              matrix: 'plasma',
              route: 'oral',
              doseValue: 2,
              doseUnit: 'mg',
              administeredDrugId: 311,
              coadministrationState: 'with_interacting_drug',
              interactingDrugId: 500,
              citationId: 7,
            },
          },
          {
            parameter: 'cmax',
            drugName: 'Benzoylekgonin',
            doseContextDrugNames: { 311: 'Kokain' },
          },
        )}
      />,
    );
    expect(screen.getByText('Kokain')).toBeInTheDocument();
    // An id the server could not resolve still shows, as a reference.
    expect(screen.getByText(/doseContext\.drugRef/)).toBeInTheDocument();
  });

  it('renders a categorical model-structure create proposal by its value', () => {
    render(
      <ParameterEntryDiff
        edit={edit(
          {
            op: 'create',
            input: {
              parameter: 'dispositionModel',
              categoricalValue: 'two-compartment',
              unit: '',
              citationId: 7,
            },
          },
          { drugName: 'Diazepam', parameter: 'dispositionModel' },
        )}
      />,
    );
    // The reviewer sees the declared shape, not the numeric formatter's em dash.
    expect(screen.getByText('two-compartment')).toBeInTheDocument();
  });

  it('shows the live categorical value on a delete proposal', () => {
    render(
      <ParameterEntryDiff
        edit={edit(
          { op: 'delete' },
          {
            drugName: 'Diazepam',
            parameter: 'eliminationModel',
            currentEntry: {
              id: 77,
              parameter: 'eliminationModel',
              low: null,
              high: null,
              median: null,
              qualifier: null,
              categoricalValue: 'michaelis-menten',
              unit: '',
              route: null,
              matrix: null,
              scenario: null,
              n: null,
              comments: null,
              observationContext: null,
              sourceQuote: null,
              origin: 'contributor',
              citationId: 7,
              citation: null,
            },
          },
        )}
      />,
    );
    expect(screen.getByText('michaelis-menten')).toBeInTheDocument();
  });

  it('shows the live entry contents on a delete proposal', () => {
    render(
      <ParameterEntryDiff
        edit={edit(
          { op: 'delete' },
          {
            drugName: 'Diazepam',
            currentEntry: {
              id: 99,
              parameter: 'therapeuticConcentration',
              low: 5,
              high: 15,
              median: null,
              qualifier: null,
              categoricalValue: null,
              unit: 'mg/L',
              route: null,
              matrix: 'whole_blood',
              scenario: 'living_therapeutic',
              n: 20,
              comments: 'Adult inpatients',
              observationContext: 'Fasted, single dose.',
              sourceQuote: null,
              origin: 'contributor',
              citationId: 7,
              citation: {
                id: 7,
                type: 'doi',
                identifier: '10.1/x',
                metadata: { title: 'Key study' },
              },
            },
          },
        )}
      />,
    );
    expect(screen.getByText(/Remove source value/)).toBeInTheDocument();
    // The value, observation context, comments, and cited source of the entry
    // being removed are shown.
    expect(screen.getByText('5–15 mg/L')).toBeInTheDocument();
    expect(screen.getByText('Fasted, single dose.')).toBeInTheDocument();
    expect(screen.getByText('Adult inpatients')).toBeInTheDocument();
    const link = screen.getByText('Key study').closest('a');
    expect(link).toHaveAttribute('href', '/references/7');
  });

  it('shows current beside proposed on an update proposal', () => {
    render(
      <ParameterEntryDiff
        edit={edit(
          {
            op: 'update',
            patch: {
              parameter: 'therapeuticConcentration',
              median: 100,
              unit: 'mg/L',
              matrix: 'urine',
              scenario: 'living_therapeutic',
              citationId: 8,
            },
          },
          {
            drugName: 'Diazepam',
            currentEntry: {
              id: 99,
              parameter: 'therapeuticConcentration',
              low: 10,
              high: null,
              median: 10,
              qualifier: null,
              categoricalValue: null,
              unit: 'mg/L',
              route: null,
              matrix: 'whole_blood',
              scenario: 'living_therapeutic',
              n: null,
              comments: null,
              observationContext: null,
              sourceQuote: null,
              origin: 'contributor',
              citationId: 7,
              citation: {
                id: 7,
                type: 'doi',
                identifier: '10.1/x',
                metadata: { title: 'Key study' },
              },
            },
          },
        )}
      />,
    );
    // Both the live value (10) and the proposed value (100) are visible.
    expect(screen.getByText('10 mg/L')).toBeInTheDocument();
    expect(screen.getByText('100 mg/L')).toBeInTheDocument();
    // The current entry's matrix (whole_blood) and the proposed matrix (urine).
    expect(
      screen.getByText('referenceConc.matrix.whole_blood'),
    ).toBeInTheDocument();
    expect(screen.getByText('referenceConc.matrix.urine')).toBeInTheDocument();
  });

  /**
   * The card must show what the entry will carry AFTER approval, not what the
   * patch happens to say. The editor omits an untouched quote deliberately and
   * the update preserves the stored one while the evidence it attests to is
   * unchanged — so a card rendering the sparse patch straight shows no quote on
   * a proposal that keeps one, and a reviewer reads that as the quotation being
   * removed. That is the opposite of what approving it does, and it is the one
   * field on the card whose whole purpose is to be read and checked.
   */
  describe('an inherited source quote', () => {
    const QUOTE = 'Serum levels of 10 mg/L were therapeutic.';
    const storedEntry = {
      id: 99,
      parameter: 'therapeuticConcentration',
      low: 10,
      high: null,
      median: 10,
      qualifier: null,
      categoricalValue: null,
      unit: 'mg/L',
      route: null,
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      n: null,
      comments: null,
      observationContext: null,
      sourceQuote: QUOTE,
      origin: 'contributor',
      citationId: 7,
      citation: null,
    };
    /** A patch that omits `quote`, as the editor sends when it is untouched. */
    const patch = (over: Record<string, unknown> = {}) => ({
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        low: 10,
        median: 10,
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_therapeutic',
        citationId: 7,
        ...over,
      },
    });

    it('is shown, and labelled as carried over, when the reading is unchanged', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ comments: 'Typo fixed.' }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // Twice: once in the current column, once in the proposed one.
      expect(screen.getAllByText(QUOTE)).toHaveLength(2);
      expect(
        screen.getByText('Kept from the current entry'),
      ).toBeInTheDocument();
    });

    it('is not shown when the write would detach it', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ median: 20, low: 20 }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // Only the current column still carries it: the reading moved, so the
      // approval will clear it, and the card must not promise otherwise.
      expect(screen.getAllByText(QUOTE)).toHaveLength(1);
      expect(
        screen.queryByText('Kept from the current entry'),
      ).not.toBeInTheDocument();
    });

    // The write treats a quote equal to the stored one as asserting nothing, so
    // a moved reading clears it. A card that displays the echoed sentence tells
    // the reviewer the opposite of what approving will do — the same lie as
    // hiding an inherited quote, in a quieter register.
    it('is not shown when the payload merely echoes it and the reading moved', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ median: 20, low: 20, quote: QUOTE }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      expect(screen.getAllByText(QUOTE)).toHaveLength(1);
      expect(
        screen.queryByText('Kept from the current entry'),
      ).not.toBeInTheDocument();
    });

    it('is labelled as carried over when an echo rides an unchanged reading', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ comments: 'Typo fixed.', quote: QUOTE }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // The write preserves it here, and it did not come from this proposal.
      expect(screen.getAllByText(QUOTE)).toHaveLength(2);
      expect(
        screen.getByText('Kept from the current entry'),
      ).toBeInTheDocument();
    });

    it('shows a genuinely rewritten quote as the statement it is', () => {
      const rewritten = 'Corrected: serum levels were 20 mg/L.';
      render(
        <ParameterEntryDiff
          edit={edit(patch({ median: 20, low: 20, quote: rewritten }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      expect(screen.getByText(rewritten)).toBeInTheDocument();
      expect(
        screen.queryByText('Kept from the current entry'),
      ).not.toBeInTheDocument();
    });

    it('is not shown when the author explicitly cleared it', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ quote: null }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // An explicit removal is a statement, and must keep reading as removal.
      expect(screen.getAllByText(QUOTE)).toHaveLength(1);
    });
  });

  /**
   * `observationContext` has the same omission-means-preserve rule as the
   * quote above, unconditionally (no echo/staleness complexity): rendering the
   * sparse patch straight would show the context as gone on an update that
   * never touched it, indistinguishable from an explicit clear.
   */
  describe('an inherited observation context', () => {
    const CONTEXT = 'Fasted, single dose, healthy volunteers.';
    const storedEntry = {
      id: 99,
      parameter: 'therapeuticConcentration',
      low: 10,
      high: null,
      median: 10,
      qualifier: null,
      categoricalValue: null,
      unit: 'mg/L',
      route: null,
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      n: null,
      comments: null,
      observationContext: CONTEXT,
      sourceQuote: null,
      origin: 'contributor',
      citationId: 7,
      citation: null,
    };
    const patch = (over: Record<string, unknown> = {}) => ({
      op: 'update',
      patch: {
        parameter: 'therapeuticConcentration',
        low: 10,
        median: 10,
        unit: 'mg/L',
        matrix: 'whole_blood',
        scenario: 'living_therapeutic',
        citationId: 7,
        ...over,
      },
    });

    it('is shown, carried over, when the patch never mentions it', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ comments: 'Typo fixed.' }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // Once in the current column, once in the inherited proposed one.
      expect(screen.getAllByText(CONTEXT)).toHaveLength(2);
    });

    it('shows a genuinely rewritten context as the statement it is', () => {
      const rewritten = 'Fed, single dose, healthy volunteers.';
      render(
        <ParameterEntryDiff
          edit={edit(patch({ observationContext: rewritten }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      expect(screen.getByText(rewritten)).toBeInTheDocument();
      expect(screen.queryAllByText(CONTEXT)).toHaveLength(1); // current column only
    });

    it('is not shown on the proposed side when the author explicitly cleared it', () => {
      render(
        <ParameterEntryDiff
          edit={edit(patch({ observationContext: null }), {
            currentEntry: storedEntry as never,
          })}
        />,
      );
      // Current column still shows what is stored; nothing renders it as proposed.
      expect(screen.getAllByText(CONTEXT)).toHaveLength(1);
    });
  });

  it('falls back to the id hint when the entry could not be hydrated', () => {
    render(<ParameterEntryDiff edit={edit({ op: 'delete' })} />);
    // The delete label + hint use defaultValue (English) since i18n isn't loaded.
    expect(screen.getByText(/Remove source value/)).toBeInTheDocument();
    // The bare id hint (interpolation not run under the test i18n stub).
    expect(screen.getByText(/Removes entry/)).toBeInTheDocument();
  });

  // A proposal the approval will refuse used to look exactly like any other:
  // the details grid prints whatever the payload holds, so a whole qualifying
  // sentence written into `qualifier` (which takes only '<', '>', '≤', '≥')
  // rendered as an ordinary value and the refusal came only on approve.
  describe('unpublishable payloads', () => {
    const validCreate = {
      op: 'create',
      input: {
        drugId: 42,
        parameter: 'therapeuticConcentration',
        low: 10,
        high: 30,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
        citationId: 7,
      },
    };

    it('warns when the payload does not satisfy the source-value rules', () => {
      render(
        <ParameterEntryDiff
          edit={edit(
            {
              op: 'create',
              input: {
                ...validCreate.input,
                low: 3.34,
                high: 3.34,
                qualifier: 'apparent Vd (Vss/(F×fm)); fm=0.1 FIXED in the model',
              },
            },
            { referenceIds: [7] },
          )}
        />,
      );
      expect(
        screen.getByText(/cannot be approved as it stands/),
      ).toBeInTheDocument();
      // The localized refusal (raw key here — i18n is not loaded in tests) is
      // the same one the approval's error code maps to.
      expect(
        screen.getByText('review.errors.paramEntryInvalidPayload'),
      ).toBeInTheDocument();
      // …and the offending field is named (interpolation is not run under the
      // test i18n stub, so the line renders with its placeholder intact).
      expect(screen.getByText(/Fields to correct/)).toBeInTheDocument();
      // The validator's English prose stays out of the card: a Norwegian
      // reviewer reads the localized sentence, not a zod message.
      expect(
        screen.queryByText(/Invalid source-value payload/),
      ).not.toBeInTheDocument();
    });

    it('keeps a free-text qualifier out of the figure it is not part of', () => {
      render(
        <ParameterEntryDiff
          edit={edit(
            {
              op: 'create',
              input: {
                ...validCreate.input,
                low: 3.34,
                high: 3.34,
                qualifier:
                  'tilsynelatende Vd (Vss/(F×fm)); fm=0,1 FIKSERT i modellen',
              },
            },
            { referenceIds: [7] },
          )}
        />,
      );
      // The number reads as the number, never with the prose in front of it as
      // a censoring operator. The text itself is still on the card, behind the
      // figure, in a sentence that goes through `t()` (so the interpolation is
      // left as its placeholder here, as elsewhere in this file).
      expect(screen.getByText(/^3\.34 mg\/L · /)).toBeInTheDocument();
      expect(
        screen.queryByText(/^tilsynelatende Vd/),
      ).not.toBeInTheDocument();
    });

    it('does not let a free-text qualifier hide a low–high span', () => {
      render(
        <ParameterEntryDiff
          edit={edit(
            {
              op: 'create',
              input: { ...validCreate.input, qualifier: 'voksen po' },
            },
            { referenceIds: [7] },
          )}
        />,
      );
      // The old formatter took the qualifier as a censored threshold and showed
      // `high` alone, so a 10–30 range printed as "voksen po 30 mg/L".
      expect(screen.getByText(/^10–30 mg\/L · /)).toBeInTheDocument();
    });

    it('warns when the payload cites a source the proposal does not list', () => {
      render(
        <ParameterEntryDiff edit={edit(validCreate, { referenceIds: [9] })} />,
      );
      expect(
        screen.getByText('review.errors.paramEntryCitationMismatch'),
      ).toBeInTheDocument();
    });

    it('stays quiet on a payload the approval would accept', () => {
      render(
        <ParameterEntryDiff edit={edit(validCreate, { referenceIds: [7] })} />,
      );
      expect(
        screen.queryByText(/cannot be approved as it stands/),
      ).not.toBeInTheDocument();
    });

    it('reads a legacy row’s singular reference when the array is empty', () => {
      // `reference_ids = '{}'` means "never set", not "cites nothing": every
      // reader on the server falls back to `reference_id`. Treating the empty
      // array as the reference set would refuse the payload for citing the very
      // source the row lists.
      render(
        <ParameterEntryDiff
          edit={edit(validCreate, { referenceIds: [], referenceId: 7 })}
        />,
      );
      expect(
        screen.queryByText(/cannot be approved as it stands/),
      ).not.toBeInTheDocument();
    });

    it('stays quiet on an already-decided edit', () => {
      render(
        <ParameterEntryDiff
          edit={edit(
            { op: 'create', input: { ...validCreate.input, qualifier: 'about' } },
            { referenceIds: [7], status: 'approved' },
          )}
        />,
      );
      expect(
        screen.queryByText(/cannot be approved as it stands/),
      ).not.toBeInTheDocument();
    });
  });
});
