import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ParameterEntryRow } from '@/lib/parameterEntriesApi';

// The section fetches per-axis and writes through the parameter-entries client;
// mock the module so the test drives it without a network. fetchParameterEntries
// filters by the requested parameter, exactly as the real endpoint does.
const store: ParameterEntryRow[] = [];
let failLoads = false;
let holdLoads = false;
const createParameterEntry = vi.fn().mockResolvedValue({ id: 99 });
const deleteParameterEntry = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/parameterEntriesApi', () => ({
  fetchParameterEntries: vi.fn(async (_drugId: number, opts?: { parameter?: string }) => {
    if (holdLoads) await new Promise(() => {}); // never resolves — stay pending
    if (failLoads) throw new Error('network');
    return store.filter((e) => !opts?.parameter || e.parameter === opts.parameter);
  }),
  createParameterEntry: (...args: unknown[]) => createParameterEntry(...args),
  updateParameterEntry: vi.fn(),
  deleteParameterEntry: (...args: unknown[]) => deleteParameterEntry(...args),
}));

// The citation picker makes its own network calls; stub it to a button that
// reports a chosen reference id, which is all the section/editor needs.
vi.mock('@/components/wiki/ReferenceInput', () => ({
  ReferenceInput: ({ onReferenceCreated }: { onReferenceCreated: (r: { id: number }) => void }) => (
    <button type="button" onClick={() => onReferenceCreated({ id: 5 })}>
      pick-citation
    </button>
  ),
}));

import { ModelStructureSection } from '@/components/wiki/ModelStructureSection';
import { fetchParameterEntries } from '@/lib/parameterEntriesApi';

const fetchMock = fetchParameterEntries as unknown as ReturnType<typeof vi.fn>;

function entry(over: Partial<ParameterEntryRow>): ParameterEntryRow {
  return {
    id: 1,
    parameter: 'dispositionModel',
    low: null,
    high: null,
    median: null,
    qualifier: null,
    categoricalValue: 'two-compartment',
    unit: '',
    route: null,
    matrix: null,
    scenario: null,
    n: null,
    comments: null,
    observationContext: null,
    sourceQuote: null,
    origin: 'contributor',
    citationId: 5,
    citation: null,
    ...over,
  };
}

describe('ModelStructureSection', () => {
  afterEach(() => {
    store.length = 0;
    failLoads = false;
    holdLoads = false;
    createParameterEntry.mockClear();
    deleteParameterEntry.mockClear();
    fetchMock.mockClear();
  });

  it('uses the cached endpoint for read-only viewers and no-store for editors', async () => {
    const { unmount } = render(<ModelStructureSection drugId={42} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Anonymous reader: no `fresh` flag, so the public CDN cache is used.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ fresh: false });
    }
    unmount();
    fetchMock.mockClear();
    render(<ModelStructureSection drugId={42} canEdit />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Editor: `fresh` so a just-written declaration isn't hidden by a stale edge copy.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ fresh: true });
    }
  });

  it('shows a declared axis value with its citation link', async () => {
    store.push(entry({ id: 10, categoricalValue: 'two-compartment', citationId: 7 }));
    render(<ModelStructureSection drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText('two-compartment')).toBeInTheDocument(),
    );
    // The heading is shown when the section has content.
    expect(screen.getByText('modelStructure.heading')).toBeInTheDocument();
    expect(screen.getByText('#7').closest('a')).toHaveAttribute(
      'href',
      '/references/7',
    );
  });

  // A model-structure axis is entry-backed, so it drives calculations and is
  // high-risk for auto-apply exactly like a numeric parameter. A quote that is
  // required to publish a declaration but invisible once published is
  // provenance nobody can audit.
  it('shows the source quote behind a declaration, labelled with its value', async () => {
    const quote = 'Plasma concentrations declined bi-exponentially.';
    store.push(
      entry({ id: 10, categoricalValue: 'two-compartment', sourceQuote: quote }),
    );
    render(<ModelStructureSection drugId={42} />);
    await waitFor(() => expect(screen.getByText(quote)).toBeInTheDocument());
    // Labelled, because an axis can carry several declarations (one per route)
    // and an unattributed sentence would not say which it backs.
    expect(screen.getByText('two-compartment · #5:')).toBeInTheDocument();
  });

  it('shows no quote block for a declaration without one', async () => {
    store.push(entry({ id: 10, categoricalValue: 'two-compartment' }));
    render(<ModelStructureSection drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText('two-compartment')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/two-compartment ·/)).toBeNull();
  });

  // Two declarations may legitimately share a categorical value and differ only
  // by route, and two papers may back the same route. The value alone would
  // print identical prefixes, and since quote-less entries are filtered out of
  // this list the reader cannot recover the mapping by counting against the
  // chips either — so each label has to pick out exactly one declaration.
  it('distinguishes same-value declarations by route and citation', async () => {
    store.push(
      entry({
        id: 11,
        parameter: 'absorptionModel',
        categoricalValue: 'first-order',
        route: 'oral',
        citationId: 7,
        sourceQuote: 'Oral absorption followed first-order kinetics.',
      }),
      entry({
        id: 12,
        parameter: 'absorptionModel',
        categoricalValue: 'first-order',
        route: 'intranasal',
        citationId: 9,
        sourceQuote: 'Intranasal uptake was also first-order.',
      }),
    );
    render(<ModelStructureSection drugId={42} />);
    await waitFor(() =>
      expect(
        screen.getByText('Oral absorption followed first-order kinetics.'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText('first-order · parameters.route.oral · #7:'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('first-order · parameters.route.intranasal · #9:'),
    ).toBeInTheDocument();
  });

  // The hole this closes: the categorical branch returned before the quote
  // control was rendered and its payload never carried one, so an agent using
  // the model-structure editor could not supply the evidence its own
  // publication gate demands — every such proposal would sit pending forever.
  it('sends a source quote from the categorical editor', async () => {
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getAllByText('modelStructure.undeclared').length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByTitle('modelStructure.declare')[0]!);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'one-compartment' } });
    const quote = 'A two-compartment model best described the data.';
    // The quote box comes first; observationContext (#1257) added a second
    // textarea to the categorical form beside it.
    fireEvent.change(screen.getAllByRole('textbox')[0]!, {
      target: { value: quote },
    });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));
    await waitFor(() => expect(createParameterEntry).toHaveBeenCalledTimes(1));
    expect(createParameterEntry).toHaveBeenCalledWith(
      expect.objectContaining({ categoricalValue: 'one-compartment', quote }),
    );
  });

  it('shows a loading state, not "undeclared", while the first load is pending', async () => {
    holdLoads = true;
    render(<ModelStructureSection drugId={42} canEdit />);
    await waitFor(() =>
      expect(screen.getByText('common.loading')).toBeInTheDocument(),
    );
    // No axis is claimed "not declared" and no add control is offered yet.
    expect(screen.queryByText('modelStructure.undeclared')).not.toBeInTheDocument();
    expect(screen.queryByTitle('modelStructure.declare')).not.toBeInTheDocument();
  });

  it('marks the undeclared axes as not declared', async () => {
    render(<ModelStructureSection drugId={42} canEdit />);
    // Three axes, all empty → three "not declared" markers.
    await waitFor(() =>
      expect(screen.getAllByText('modelStructure.undeclared')).toHaveLength(3),
    );
  });

  it('renders nothing (no heading) when there are no entries and the viewer cannot edit', async () => {
    const { container } = render(<ModelStructureSection drugId={42} />);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="model-structure-section"]')).toBeNull(),
    );
    // The heading lives inside the section, so an empty read-only monograph
    // shows no bordered "Model structure" box at all.
    expect(screen.queryByText('modelStructure.heading')).not.toBeInTheDocument();
  });

  it('declares a shape through the categorical editor', async () => {
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getAllByText('modelStructure.undeclared').length).toBeGreaterThan(0),
    );
    // Open the add form for the first axis (disposition).
    fireEvent.click(screen.getAllByTitle('modelStructure.declare')[0]!);
    // The categorical picker offers the disposition vocabulary.
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'one-compartment' } });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByText('parameterEntries.editor.save'));
    await waitFor(() => expect(createParameterEntry).toHaveBeenCalledTimes(1));
    expect(createParameterEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        drugId: 42,
        parameter: 'dispositionModel',
        categoricalValue: 'one-compartment',
        unit: '',
        citationId: 5,
      }),
    );
  });

  it('shows an error with retry when the load fails, not a false absence', async () => {
    failLoads = true;
    // A reader (no edit rights) must still see the failure, not a hidden section.
    render(<ModelStructureSection drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText('modelStructure.loadError')).toBeInTheDocument(),
    );
    // No axis is claimed "not declared" on a failed load.
    expect(screen.queryByText('modelStructure.undeclared')).not.toBeInTheDocument();
    // Retry recovers once the fetch succeeds again.
    failLoads = false;
    store.push(entry({ id: 12, categoricalValue: 'two-compartment' }));
    fireEvent.click(screen.getByText('common.retry'));
    await waitFor(() =>
      expect(screen.getByText('two-compartment')).toBeInTheDocument(),
    );
  });

  it('deletes a declaration after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    store.push(entry({ id: 11, categoricalValue: 'first-order', parameter: 'eliminationModel' }));
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getByText('first-order')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('common.delete'));
    await waitFor(() => expect(deleteParameterEntry).toHaveBeenCalledWith(11, { submitForReview: false }));
    confirmSpy.mockRestore();
  });

  it('shows the administration route on a per-route absorption declaration (CV-2c-4d)', async () => {
    store.push(
      entry({
        id: 21,
        categoricalValue: 'first-order',
        parameter: 'absorptionModel',
        route: 'oral',
      }),
    );
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getByText('first-order')).toBeInTheDocument(),
    );
    // The route badge renders its label key (translated at the i18n boundary).
    expect(screen.getByText('parameters.route.oral')).toBeInTheDocument();
  });

  it('surfaces an error when a delete is rejected', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteParameterEntry.mockRejectedValueOnce(new Error('409'));
    store.push(entry({ id: 14, categoricalValue: 'first-order', parameter: 'eliminationModel' }));
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getByText('first-order')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('common.delete'));
    await waitFor(() =>
      expect(screen.getByText('modelStructure.actionError')).toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it('closes an open add form when the drug changes', async () => {
    const { rerender } = render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getAllByText('modelStructure.undeclared').length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByTitle('modelStructure.declare')[0]!);
    // The editor is open (its citation picker is mounted).
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    // Navigating to another drug (sidebar reused) must discard the editor and
    // its hook state, not carry the previous drug's citation into the new one.
    rerender(<ModelStructureSection drugId={43} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument(),
    );
  });

  it('does not delete when the confirm is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    store.push(entry({ id: 13, categoricalValue: 'first-order', parameter: 'eliminationModel' }));
    render(<ModelStructureSection drugId={42} canEdit isAdmin />);
    await waitFor(() =>
      expect(screen.getByText('first-order')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('common.delete'));
    expect(deleteParameterEntry).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
