import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReferenceConcentrationsList } from '@/components/wiki/ReferenceConcentrationsList';
import type { ReferenceConcentrationRow } from '@/lib/referenceConcentrationsApi';

function row(
  partial: Partial<ReferenceConcentrationRow> & {
    scenario: ReferenceConcentrationRow['scenario'];
    matrix: ReferenceConcentrationRow['matrix'];
    unit: ReferenceConcentrationRow['unit'];
  },
  id = 1,
): ReferenceConcentrationRow {
  return {
    id,
    drugId: 1,
    low: null,
    high: null,
    n: null,
    comments: null,
    citationId: null,
    citation: null,
    createdBy: null,
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...partial,
  };
}

function mockItems(items: ReferenceConcentrationRow[]) {
  (
    globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue({ items }),
  });
}

function getByTextContent(text: string): HTMLElement {
  return screen.getByText((_content, element) => element?.textContent === text);
}

describe('ReferenceConcentrationsList', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when there are no rows', async () => {
    mockItems([]);
    const { container } = render(<ReferenceConcentrationsList drugId={1} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Component returns null, so the rendered container should be empty.
    expect(container.textContent).toBe('');
  });

  it('groups rows by scenario and shows low–high', async () => {
    mockItems([
      row(
        {
          scenario: 'living_therapeutic',
          matrix: 'serum',
          unit: 'ng/mL',
          low: 120,
          high: 250,
        },
        1,
      ),
      row(
        {
          scenario: 'living_toxic',
          matrix: 'serum',
          unit: 'ng/mL',
          low: 500,
          n: 14,
        },
        2,
      ),
    ]);
    render(<ReferenceConcentrationsList drugId={1} />);

    await screen.findByText('referenceConc.title');
    expect(
      screen.getByText('referenceConc.scenario.living_therapeutic'),
    ).toBeTruthy();
    expect(getByTextContent('120–250 ng/mL')).toBeTruthy();

    expect(
      screen.getByText('referenceConc.scenario.living_toxic'),
    ).toBeTruthy();
    expect(getByTextContent('≥ 500 ng/mL')).toBeTruthy();
    // Meta line includes matrix and n
    expect(screen.getByText(/serum · n = 14/)).toBeTruthy();
  });

  it('renders ≤ upper bound when only high is present', async () => {
    mockItems([
      row({
        scenario: 'living_toxic',
        matrix: 'whole_blood',
        unit: 'ng/mL',
        high: 300,
      }),
    ]);
    render(<ReferenceConcentrationsList drugId={1} />);
    await screen.findByText('referenceConc.title');
    expect(getByTextContent('≤ 300 ng/mL')).toBeTruthy();
  });

  it('shows comments muted below the value', async () => {
    mockItems([
      row({
        scenario: 'living_therapeutic',
        matrix: 'serum',
        unit: 'ng/mL',
        low: 10,
        high: 20,
        comments: 'Diakonhjemmet reference range',
      }),
    ]);
    render(<ReferenceConcentrationsList drugId={1} />);
    expect(
      await screen.findByText('Diakonhjemmet reference range'),
    ).toBeTruthy();
  });

  it('routes citation links through the reference module', async () => {
    mockItems([
      row({
        scenario: 'living_therapeutic',
        matrix: 'serum',
        unit: 'ng/mL',
        low: 10,
        high: 20,
        comments: 'Diakonhjemmet',
        citationId: 7,
        citation: {
          id: 7,
          type: 'url',
          identifier: 'https://example.com/diakonhjemmet',
          metadata: null,
        },
      }),
    ]);
    render(<ReferenceConcentrationsList drugId={1} />);
    const link = (await screen.findByRole('link', {
      name: 'Diakonhjemmet',
    })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/references/7');
    expect(link.target).toBe('');
  });

  it('does not expose citation identifiers as direct links', async () => {
    mockItems([
      row({
        scenario: 'living_therapeutic',
        matrix: 'serum',
        unit: 'ng/mL',
        low: 10,
        high: 20,
        comments: 'Suspicious source',
        citationId: 8,
        citation: {
          id: 8,
          type: 'url',
          identifier: 'javascript:alert(document.cookie)',
          metadata: null,
        },
      }),
    ]);
    render(<ReferenceConcentrationsList drugId={1} />);
    const link = await screen.findByRole('link', {
      name: 'Suspicious source',
    });
    expect(link.getAttribute('href')).toBe('/references/8');
  });

  it('requests the correct endpoint', async () => {
    mockItems([]);
    render(<ReferenceConcentrationsList drugId={42} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reference-concentrations?drugId=42',
      );
    });
  });
});
