import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ParameterEntryList } from '@/components/wiki/ParameterEntryList';
import type { ParameterEntryRow } from '@/lib/parameterEntriesApi';
import { useAuthStore } from '@/stores/authStore';

function row(over: Partial<ParameterEntryRow> = {}): ParameterEntryRow {
  return {
    id: 1,
    parameter: 'therapeuticConcentration',
    low: 10,
    high: 30,
    median: null,
    qualifier: null,
    categoricalValue: null,
    unit: 'mg/L',
    route: null,
    matrix: 'serum',
    scenario: 'living_therapeutic',
    n: 12,
    comments: null,
    observationContext: null,
    sourceQuote: null,
    origin: 'contributor',
    citationId: 7,
    citation: { id: 7, type: 'doi', identifier: '10.1/x', metadata: { title: 'Key study' } },
    ...over,
  };
}

function mockItems(items: ParameterEntryRow[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) });
}

describe('ParameterEntryList', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ isAuthenticated: false });
  });

  it('renders entries grouped by parameter with a citation link', async () => {
    vi.stubGlobal('fetch', mockItems([row()]));
    render(<ParameterEntryList drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText('10–30 mg/L')).toBeInTheDocument(),
    );
    // Matrix meta (raw key) and citation link.
    expect(
      screen.getByText(/referenceConc\.matrix\.serum/),
    ).toBeInTheDocument();
    const link = screen.getByText('Key study').closest('a');
    expect(link).toHaveAttribute('href', '/references/7');
  });

  // The durable half of what the quote is for. Surfacing it only in the review
  // queue would mean the sentence backing a PUBLISHED value is visible to
  // whoever approved it and to nobody afterwards — so a reader auditing a live
  // number would still have to go and re-read the paper, which is the cost the
  // field exists to remove.
  it('renders a stored source quote beside the citation', async () => {
    const quote = 'Therapeutic serum concentrations ranged from 10 to 30 mg/L.';
    vi.stubGlobal('fetch', mockItems([row({ sourceQuote: quote })]));
    render(<ParameterEntryList drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText(quote)).toBeInTheDocument(),
    );
  });

  it('renders nothing for a row with no quote', async () => {
    vi.stubGlobal('fetch', mockItems([row({ sourceQuote: null })]));
    render(<ParameterEntryList drugId={42} />);
    await waitFor(() =>
      expect(screen.getByText('10–30 mg/L')).toBeInTheDocument(),
    );
    // No empty quotation block for the overwhelming majority of rows, which
    // predate the field and can never be given one.
    expect(document.querySelector('.italic')).toBeNull();
  });

  it('shows add/edit/delete controls when editable', async () => {
    vi.stubGlobal('fetch', mockItems([row()]));
    render(<ParameterEntryList drugId={42} canEdit />);
    await waitFor(() =>
      expect(screen.getByText('10–30 mg/L')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('parameterEntries.editor.add'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('parameterEntries.editor.edit'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('parameterEntries.editor.delete'),
    ).toBeInTheDocument();
  });

  it('hides edit/delete controls on a grandfathered placeholder row', async () => {
    vi.stubGlobal('fetch', mockItems([row({ origin: 'grandfathered' })]));
    render(<ParameterEntryList drugId={42} canEdit />);
    await waitFor(() =>
      expect(screen.getByText('10–30 mg/L')).toBeInTheDocument(),
    );
    // Add is still offered (to create a real source), but the placeholder itself
    // is not editable/removable.
    expect(screen.getByText('parameterEntries.editor.add')).toBeInTheDocument();
    expect(
      screen.queryByText('parameterEntries.editor.edit'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('parameterEntries.editor.delete'),
    ).not.toBeInTheDocument();
  });

  it('exposes an add affordance for a scoped parameter with no entries', async () => {
    vi.stubGlobal('fetch', mockItems([]));
    render(
      <ParameterEntryList drugId={42} parameter="toxicConcentration" canEdit />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('parameterEntries.editor.add'),
      ).toBeInTheDocument(),
    );
  });

  it('renders the pooled summary line when a summary is provided', async () => {
    vi.stubGlobal('fetch', mockItems([row()]));
    render(
      <ParameterEntryList
        drugId={42}
        summaries={{
          therapeuticConcentration: {
            representative: 20,
            iqrLow: 15,
            iqrHigh: 25,
            min: 10,
            max: 30,
            unit: 'mg/L',
            points: [],
            entryCount: 1,
            pooledCount: 1,
            normalizedToWholeBlood: false,
            contributingCitationIds: [7],
            byMatrix: [],
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('parameterEntries.summary.line'),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces a localized error when the entry load fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<ParameterEntryList drugId={42} />);
    await waitFor(() =>
      expect(
        screen.getByText('parameterEntries.loadError'),
      ).toBeInTheDocument(),
    );
  });

  it('requests the drug scoped endpoint and renders nothing when empty', async () => {
    const fetchMock = mockItems([]);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <ParameterEntryList drugId={42} parameter="toxicConcentration" />,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/parameter-entries?drugId=42&parameter=toxicConcentration',
        {},
      ),
    );
    expect(container.querySelector('dl')).toBeNull();
  });
  it("shows values in the reader's preferred unit, authored figures in the tooltip", async () => {
    vi.stubGlobal('fetch', mockItems([row()]));
    // Default preference is µmol/L; with a molecular weight the mass→molar
    // conversion becomes possible, so the row must follow the preference.
    const { container } = render(
      <ParameterEntryList drugId={42} molecularWeight={200} />,
    );
    // The unit is its own element (it carries the tooltip trigger), so assert on
    // the row's text rather than a single text node.
    await waitFor(() =>
      expect(container.textContent).toContain('50–150 µmol/L'),
    );
    // The source's own numbers stay one hover away. The tooltip lays its rows
    // out in a decimal-alignment grid (#1188), so the value and its unit are
    // separate cells — assert on the tooltip's text, not a single text node.
    expect(screen.getByRole('tooltip')).toHaveTextContent('10–30 mg/L');
  });

  it('reports the hovered row and marks the row the plot points at', async () => {
    vi.stubGlobal('fetch', mockItems([row({ id: 5 })]));
    const seen: (number | null)[] = [];
    const { rerender } = render(
      <ParameterEntryList drugId={42} onHighlightEntry={(id) => seen.push(id)} />,
    );
    await waitFor(() =>
      expect(screen.getByText('10–30 mg/L')).toBeInTheDocument(),
    );
    fireEvent.mouseEnter(screen.getByText('10–30 mg/L').closest('div')!);
    expect(seen).toContain(5);

    rerender(
      <ParameterEntryList
        drugId={42}
        highlightedEntryId={5}
        onHighlightEntry={(id) => seen.push(id)}
      />,
    );
    expect(document.querySelector('[data-highlighted]')).not.toBeNull();
  });

  it('asks for an uncacheable response on an editable surface', async () => {
    const fetchMock = mockItems([row()]);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ParameterEntryList
        drugId={42}
        parameter="therapeuticConcentration"
        canEdit
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Without this the CDN can serve a pre-write list to the person who just
    // wrote an entry (cache: 'no-store' only covers the browser cache).
    expect(String(fetchMock.mock.calls[0]![0])).toContain('fresh=1');
  });
  it('asks for an uncacheable response for any signed-in reader', async () => {
    // A logged-in user without edit rights still gets live summaries from
    // /api/drugs (it answers every cookie-bearing request no-store), so the
    // source list must not be served from the CDN's stale window underneath one.
    useAuthStore.setState({ isAuthenticated: true });
    const fetchMock = mockItems([row()]);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ParameterEntryList drugId={42} parameter="therapeuticConcentration" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('fresh=1');
  });

  it('leaves an anonymous read on the cached variant', async () => {
    const fetchMock = mockItems([row()]);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ParameterEntryList drugId={42} parameter="therapeuticConcentration" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain('fresh=1');
  });
});
