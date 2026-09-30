import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReferenceConcentrationsAdminSection } from '@/components/admin/ReferenceConcentrationsAdminSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'nb' } }),
}));

interface MockResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

/**
 * Match a concentration display whose text the UnitTooltip wrapper splits
 * across elements — e.g. "100–200 " followed by a dotted-underlined "ng/mL".
 * The inner content span still carries the exact combined textContent, so we
 * match the element that contains the full string but whose children don't
 * each contain it on their own.
 */
function concText(expected: string) {
  return (_content: string, node: Element | null): boolean => {
    if (!node) return false;
    const hasFull = node.textContent === expected;
    const childHasFull = Array.from(node.children).some(
      (child) => child.textContent === expected,
    );
    return hasFull && !childHasFull;
  };
}

function jsonResponse({ ok, status = ok ? 200 : 400, body }: MockResponse) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 99,
    drugId: 42,
    low: 100,
    high: 200,
    unit: 'ng/mL',
    matrix: 'serum',
    scenario: 'living_therapeutic',
    n: null,
    comments: 'Diakonhjemmet',
    citationId: null,
    citation: null,
    createdBy: null,
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('ReferenceConcentrationsAdminSection', () => {
  const fetchMock = vi.fn();
  const confirmMock = vi.fn(() => true);

  beforeEach(() => {
    fetchMock.mockReset();
    confirmMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', confirmMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function queueDrugSearch() {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        body: {
          drugs: [
            {
              id: 42,
              slug: 'alprazolam',
              names: { nb: 'Alprazolam', en: 'Alprazolam' },
              nameShort: null,
              aliases: [],
              pubchemCid: 2118,
            },
          ],
        },
      }),
    );
  }

  async function selectDrug() {
    fireEvent.change(screen.getByPlaceholderText('admin.referenceConc.searchPlaceholder'), {
      target: { value: 'alp' },
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/drugs?view=search'),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    fireEvent.click(await screen.findByText('alprazolam'));
  }

  it('lists rows for the selected drug and adds a new one', async () => {
    render(<ReferenceConcentrationsAdminSection />);

    // Order matches the actual fetch sequence: search → list
    queueDrugSearch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [makeRow()] } }),
    );

    await selectDrug();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reference-concentrations?drugId=42&fresh=1',
        { cache: 'no-store' },
      );
    });
    expect(await screen.findByText(concText('100–200 ng/mL'))).toBeTruthy();

    // Open add form
    fireEvent.click(screen.getByRole('button', { name: 'admin.referenceConc.addRow' }));

    // Set low value
    const lowInputs = screen.getAllByPlaceholderText('admin.referenceConc.blankNonePlaceholder');
    const lowInput = lowInputs[0];
    if (!lowInput) throw new Error('low input not found');
    fireEvent.change(lowInput, { target: { value: '50' } });

    // Mock POST and the subsequent reload
    const created = makeRow({ id: 100, low: 50, high: null, comments: null });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, status: 201, body: { item: created } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [makeRow(), created] } }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reference-concentrations',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"drugId":42'),
        }),
      );
    });
    expect(await screen.findByText(concText('≥ 50 ng/mL'))).toBeTruthy();
  });

  it('shows a validation error when neither low nor high is set', async () => {
    render(<ReferenceConcentrationsAdminSection />);

    queueDrugSearch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [] } }),
    );
    await selectDrug();

    fireEvent.click(await screen.findByRole('button', { name: 'admin.referenceConc.addRow' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(
      await screen.findByText('admin.referenceConc.errorLowOrHighRequired'),
    ).toBeTruthy();
    // No POST request was issued
    const postCalls = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        (call[1] as { method?: string }).method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('ignores stale fetch results after switching drugs', async () => {
    render(<ReferenceConcentrationsAdminSection />);

    // Drug A search response, then a list-fetch promise we control manually.
    queueDrugSearch();
    let resolveA: (value: ReturnType<typeof jsonResponse>) => void = () => {};
    const aPending = new Promise<ReturnType<typeof jsonResponse>>((res) => {
      resolveA = res;
    });
    fetchMock.mockReturnValueOnce(aPending);

    await selectDrug();
    // Make sure A's list fetch has actually been invoked before we switch.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reference-concentrations?drugId=42&fresh=1',
        { cache: 'no-store' },
      );
    });

    // Switch to drug B (id=7) — search response, then list response that
    // resolves immediately.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        body: {
          drugs: [
            {
              id: 7,
              slug: 'diazepam',
              names: { nb: 'Diazepam', en: 'Diazepam' },
              nameShort: null,
              aliases: [],
              pubchemCid: 3016,
            },
          ],
        },
      }),
    );
    const drugBRow = makeRow({
      id: 200,
      drugId: 7,
      low: 5,
      high: 10,
      comments: 'B-only',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [drugBRow] } }),
    );

    fireEvent.change(screen.getByPlaceholderText('admin.referenceConc.searchPlaceholder'), {
      target: { value: 'dia' },
    });
    fireEvent.click(await screen.findByText('diazepam'));

    expect(await screen.findByText(concText('5–10 ng/mL'))).toBeTruthy();

    // Now resolve drug A's stale list fetch — the UI must NOT swap back to A's row.
    const drugARow = makeRow({
      id: 99,
      drugId: 42,
      low: 100,
      high: 200,
      comments: 'A-only',
    });
    resolveA(jsonResponse({ ok: true, body: { items: [drugARow] } }));

    // Let the stale microtask drain.
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText(concText('100–200 ng/mL'))).toBeNull();
    expect(screen.queryByText('A-only')).toBeNull();
    expect(screen.getByText(concText('5–10 ng/mL'))).toBeTruthy();
  });

  it('deletes a row after confirmation', async () => {
    render(<ReferenceConcentrationsAdminSection />);

    queueDrugSearch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [makeRow()] } }),
    );
    await selectDrug();

    await screen.findByText(concText('100–200 ng/mL'));

    // Mock DELETE and the subsequent reload
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { ok: true } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, body: { items: [] } }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reference-concentrations?id=99',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByText('admin.referenceConc.empty'),
      ).toBeTruthy();
    });
  });
});
