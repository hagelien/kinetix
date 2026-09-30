import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * CV-2c-4c — the drug-editor route selector. A route-optional parameter (absorptionModel) offers an
 * administration-route `<select>` (with a "drug-level" no-route choice), and the chosen route is
 * submitted; an ordinary parameter (halfLife) shows no route control and submits no route.
 */

const createParameterEntry = vi.fn().mockResolvedValue({ id: 42 });
const updateParameterEntry = vi.fn().mockResolvedValue({ id: 42 });

vi.mock('@/lib/parameterEntriesApi', () => ({
  createParameterEntry: (...args: unknown[]) => createParameterEntry(...args),
  updateParameterEntry: (...args: unknown[]) => updateParameterEntry(...args),
}));

// The citation picker makes its own network calls; stub it to a button that reports a chosen id.
vi.mock('@/components/wiki/ReferenceInput', () => ({
  ReferenceInput: ({ onReferenceCreated }: { onReferenceCreated: (r: { id: number }) => void }) => (
    <button type="button" onClick={() => onReferenceCreated({ id: 5 })}>
      pick-citation
    </button>
  ),
}));

import { ParameterEntryEditor } from '@/components/wiki/ParameterEntryEditor';

/** Find the `<select>` whose options include an option with the given value. */
function selectWithOptionValue(value: string): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
  const match = selects.find((s) =>
    Array.from(s.querySelectorAll('option')).some((o) => o.value === value),
  );
  if (!match) throw new Error(`no <select> with an option value "${value}"`);
  return match;
}

afterEach(() => {
  createParameterEntry.mockClear();
  updateParameterEntry.mockClear();
});

/** An existing numeric entry, as the edit form would be opened on. */
function storedRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    parameter: 'halfLife',
    low: 8,
    high: 10,
    // A labelled row: its centre is a mean, stored as `centralValue`.
    median: null,
    doseContext: { centralValue: 9, centralStatistic: 'arithmetic_mean', intervalKind: 'range' },
    qualifier: null,
    categoricalValue: null,
    unit: 'h',
    route: null,
    matrix: null,
    scenario: null,
    n: null,
    comments: null,
    observationContext: null,
    sourceQuote: 'The mean terminal half-life was 9 h.',
    origin: 'contributor',
    citationId: 5,
    citation: null,
    ...over,
  } as never;
}

/**
 * The server preserves an omitted quote only while the reading it is evidence
 * for is unchanged, and clears it otherwise. That rule is reached only when the
 * field is genuinely ABSENT from the payload — and this form is prefilled from
 * the stored row, so without care it would resubmit the same text as an
 * explicit value on every save. A curator changing the number without touching
 * the quote box would then re-affirm the old sentence as evidence for the new
 * value: the safeguard bypassed by the client meant to honour it.
 */
describe('ParameterEntryEditor — an untouched quote is not re-asserted', () => {
  function openEditor(row: unknown) {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        row={row as never}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
  }

  it('omits the quote when the curator never touched the box', () => {
    openEditor(storedRow());
    // Change the reading and save, leaving the prefilled quote alone. The new
    // median stays inside the entry's own low/high, so the save is not blocked
    // by the interval invariant and the quote is the only thing under test.
    const medianInput = screen.getByDisplayValue('9');
    fireEvent.change(medianInput, { target: { value: '9.5' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(updateParameterEntry).toHaveBeenCalledTimes(1);
    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    // Absent, not the stale text: the server decides whether it still holds,
    // and here it will not, because the reading moved.
    expect(payload.quote).toBeUndefined();
  });

  it('sends an edited quote as the explicit value it is', () => {
    openEditor(storedRow());
    const quoteBox = screen.getByDisplayValue(
      'The mean terminal half-life was 9 h.',
    );
    fireEvent.change(quoteBox, {
      target: { value: 'Corrected: the mean was 11 h.' },
    });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(payload.quote).toBe('Corrected: the mean was 11 h.');
  });

  it('omits a quote that differs only in whitespace from the stored one', () => {
    openEditor(storedRow());
    const quoteBox = screen.getByDisplayValue(
      'The mean terminal half-life was 9 h.',
    );
    // What a curator gets by clicking into the box, or what a browser hands
    // back from a textarea that wrapped the sentence across lines. Not an edit:
    // the server normalizes whitespace away, so this is the same sentence.
    fireEvent.change(quoteBox, {
      target: { value: '  The mean terminal\n  half-life was 9 h. ' },
    });
    const medianInput = screen.getByDisplayValue('9');
    fireEvent.change(medianInput, { target: { value: '9.5' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    // Sending it would read as a freshly authored quote and switch off the
    // server's preserve-or-clear rule, leaving the old sentence standing as
    // evidence for the new number.
    expect(payload.quote).toBeUndefined();
  });

  it('sends null when the curator clears the box', () => {
    openEditor(storedRow());
    const quoteBox = screen.getByDisplayValue(
      'The mean terminal half-life was 9 h.',
    );
    fireEvent.change(quoteBox, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    // An explicit removal is a statement, not silence.
    expect(payload.quote).toBeNull();
  });
});

/**
 * #1257 — observation context (facts about the reading) is a separate field
 * from comments (curator commentary about the row), both in the form and in
 * what gets submitted.
 */
describe('ParameterEntryEditor — observation context is distinct from comments', () => {
  it('submits observationContext and comments as separate fields', () => {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(
      screen.getByLabelText('parameterEntries.editor.observationContext'),
      { target: { value: 'Fasted, single dose, healthy volunteers.' } },
    );
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.comments'), {
      target: { value: 'Double-checked against table 3.' },
    });
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.low'), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.high'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.centralValue'), {
      target: { value: '9' },
    });
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.centralStatistic'), {
      target: { value: 'median' },
    });
    fireEvent.change(screen.getByLabelText('parameterEntries.editor.intervalKind'), {
      target: { value: 'range' },
    });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
    const arg = createParameterEntry.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg.observationContext).toBe(
      'Fasted, single dose, healthy volunteers.',
    );
    expect(arg.comments).toBe('Double-checked against table 3.');
  });

  it('prefills observationContext from the stored row, independent of comments', () => {
    openEditorRow(
      storedRow({
        observationContext: 'Fasted, single dose, healthy volunteers.',
        comments: 'Double-checked against table 3.',
      }),
    );
    expect(
      screen.getByDisplayValue('Fasted, single dose, healthy volunteers.'),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Double-checked against table 3.'),
    ).toBeInTheDocument();
  });
});

/**
 * The same omit/edit/clear distinction `submittedQuote` makes, and for the
 * same reason: the box is prefilled from the stored row, so an untouched save
 * must not resubmit the same text as a fresh assertion, and a save that
 * genuinely empties a previously-set box must not be indistinguishable from
 * one that never had anything in it — the server preserves an omitted
 * `observationContext` (a stored quote survives with it) and clears an
 * explicit `null` (detaching the quote), so sending the wrong one either
 * traps a curator who cannot ever clear the field, or drops context nobody
 * asked to remove.
 */
describe('ParameterEntryEditor — an untouched observationContext is not re-asserted', () => {
  function openEditor(row: unknown) {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        row={row as never}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
  }

  it('omits observationContext when the curator never touched the box', () => {
    openEditor(
      storedRow({ observationContext: 'Fasted, single dose, healthy volunteers.' }),
    );
    const medianInput = screen.getByDisplayValue('9');
    fireEvent.change(medianInput, { target: { value: '9.5' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(payload.observationContext).toBeUndefined();
  });

  it('sends an edited observationContext as the explicit value it is', () => {
    openEditor(
      storedRow({ observationContext: 'Fasted, single dose, healthy volunteers.' }),
    );
    const box = screen.getByDisplayValue(
      'Fasted, single dose, healthy volunteers.',
    );
    fireEvent.change(box, { target: { value: 'Fed, single dose.' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(payload.observationContext).toBe('Fed, single dose.');
  });

  it('sends null, not undefined, when the curator clears a box that had a value', () => {
    openEditor(
      storedRow({ observationContext: 'Fasted, single dose, healthy volunteers.' }),
    );
    const box = screen.getByDisplayValue(
      'Fasted, single dose, healthy volunteers.',
    );
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    const payload = updateParameterEntry.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    // Omitting here would read as "no change" to the server and silently keep
    // both the old context and the quote it is evidence for.
    expect(payload.observationContext).toBeNull();
  });
});

function openEditorRow(row: unknown) {
  render(
    <ParameterEntryEditor
      drugId={1}
      parameter="halfLife"
      isAdmin
      row={row as never}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe('CV-2c-4c — ParameterEntryEditor route selector', () => {
  it('offers a route selector for a route-optional absorption declaration and submits the route', () => {
    render(
      <ParameterEntryEditor
        drugId={7}
        parameter="absorptionModel"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );

    // The route select carries the drug-level (empty) option plus the RouteId vocabulary.
    const routeSelect = selectWithOptionValue('oral');
    const modelSelect = selectWithOptionValue('first-order');
    const values = Array.from(routeSelect.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain(''); // drug-level (route-optional, not required)
    expect(values).toEqual(expect.arrayContaining(['oral', 'intranasal', 'iv', 'other']));

    // Pick a route + a citation, then save.
    fireEvent.change(routeSelect, { target: { value: 'intranasal' } });
    fireEvent.change(modelSelect, { target: { value: 'first-order' } });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /save|lagre/i }));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
    const arg = createParameterEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      drugId: 7,
      parameter: 'absorptionModel',
      categoricalValue: 'first-order',
      route: 'intranasal',
    });
  });

  it('submits no route when the drug-level option is kept', () => {
    render(
      <ParameterEntryEditor
        drugId={7}
        parameter="absorptionModel"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /save|lagre/i }));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
    const arg = createParameterEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.route).toBeUndefined();
  });

  // A categorical (model-structure) entry is still a reading — e.g. an
  // absorption model inferred from a specific dosing regimen — so it can carry
  // study context exactly like a numeric entry, and the categorical form must
  // not silently drop the field a curator can see and fill in on every other
  // entry type.
  it('exposes and submits observationContext for a categorical entry', () => {
    render(
      <ParameterEntryEditor
        drugId={7}
        parameter="absorptionModel"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(
      screen.getByLabelText('parameterEntries.editor.observationContext'),
      { target: { value: 'Inferred from a single oral dose.' } },
    );
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /save|lagre/i }));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
    const arg = createParameterEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.observationContext).toBe('Inferred from a single oral dose.');
  });

  it('shows no route control for an ordinary drug-level parameter', () => {
    render(
      <ParameterEntryEditor
        drugId={7}
        parameter="halfLife"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    // No select carries a RouteId option.
    const selects = screen.queryAllByRole('combobox') as HTMLSelectElement[];
    const hasRouteSelect = selects.some((s) =>
      Array.from(s.querySelectorAll('option')).some((o) => o.value === 'oral'),
    );
    expect(hasRouteSelect).toBe(false);
  });
});

/**
 * The reported statistic: a central value says what it is (mean, median, …)
 * and the bounds what they are (SD, range, …), for every numeric parameter —
 * not only Cmax. Before this, the form's only slot for the centre was
 * "median", so a source's "0.54 (0.12) h, mean (SD)" was filed as a median.
 */
describe('ParameterEntryEditor — the reported statistic', () => {
  function openNew() {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
  }
  function type(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  it('sends a labelled mean ± SD as centralValue with its statistic and interval kind', () => {
    openNew();
    type('parameterEntries.editor.low', '0.42');
    type('parameterEntries.editor.high', '0.66');
    type('parameterEntries.editor.centralValue', '0.54');
    type('parameterEntries.editor.centralStatistic', 'arithmetic_mean');
    type('parameterEntries.editor.intervalKind', 'sd');
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
    const arg = createParameterEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      low: 0.42,
      high: 0.66,
      centralValue: 0.54,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
    });
    expect(arg.median).toBeUndefined();
  });

  it('refuses a new central value that does not say what it is', () => {
    openNew();
    type('parameterEntries.editor.centralValue', '0.54');
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'parameterEntries.editor.errorStatisticRequired',
    );
  });

  it('refuses an SD interval that is not symmetric around its centre', () => {
    openNew();
    type('parameterEntries.editor.low', '0.40');
    type('parameterEntries.editor.high', '0.66');
    type('parameterEntries.editor.centralValue', '0.54');
    type('parameterEntries.editor.centralStatistic', 'arithmetic_mean');
    type('parameterEntries.editor.intervalKind', 'sd');
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'parameterEntries.editor.errorIntervalSymmetric',
    );
  });

  it('refuses a labelled centre beside bounds whose kind is not said', () => {
    openNew();
    type('parameterEntries.editor.low', '0.42');
    type('parameterEntries.editor.high', '0.66');
    type('parameterEntries.editor.centralValue', '0.54');
    type('parameterEntries.editor.centralStatistic', 'arithmetic_mean');
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'parameterEntries.editor.errorIntervalKindRequired',
    );
  });

  it('accepts an SD interval symmetric at stored precision, as the server does', () => {
    // One numeric(14,6) tick apart: exact in decimal, a hair over 1e-6 in floats.
    openNew();
    type('parameterEntries.editor.low', '0');
    type('parameterEntries.editor.high', '0.200001');
    type('parameterEntries.editor.centralValue', '0.100001');
    type('parameterEntries.editor.centralStatistic', 'arithmetic_mean');
    type('parameterEntries.editor.intervalKind', 'sd');
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(createParameterEntry).toHaveBeenCalledTimes(1);
  });

  it('lets a legacy unlabelled row be saved without relabelling its untouched centre', () => {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        row={storedRow({ median: 9, doseContext: null })}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    type('parameterEntries.editor.comments', 'Checked against table 2.');
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(updateParameterEntry).toHaveBeenCalledTimes(1);
    const payload = updateParameterEntry.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.median).toBe(9);
    expect(payload.centralValue).toBeUndefined();
    expect(payload.centralStatistic).toBeUndefined();
  });

  // Codex P1 on #1452: naming what low–high is makes the entry labelled, and
  // the server would then read the untouched legacy centre as a median.
  it('requires the centre statistic when a legacy row gains an interval kind', () => {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        row={storedRow({ median: 9, doseContext: null })}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    type('parameterEntries.editor.intervalKind', 'range');
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));

    expect(updateParameterEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'parameterEntries.editor.errorStatisticRequired',
    );
  });

  it('prefills a labelled row from its stored statistic', () => {
    render(
      <ParameterEntryEditor
        drugId={1}
        parameter="halfLife"
        isAdmin
        row={storedRow({
          low: 0.42,
          high: 0.66,
          doseContext: {
            centralValue: 0.54,
            centralStatistic: 'arithmetic_mean',
            intervalKind: 'sd',
          },
        })}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText('parameterEntries.editor.centralValue')).toHaveValue(0.54);
    expect(screen.getByLabelText('parameterEntries.editor.centralStatistic')).toHaveValue(
      'arithmetic_mean',
    );
    expect(screen.getByLabelText('parameterEntries.editor.intervalKind')).toHaveValue('sd');
  });
});
