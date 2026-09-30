/**
 * The entity monograph's reverse metabolism view: every drug the metabolism
 * database routes through this bio entity, behind an expandable heading.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18nApp from '@/i18n';
import { EntityMetabolismDrugs } from './EntityMetabolismDrugs';
import { fetchEntityMetabolismDrugs } from '@/lib/bioEntitiesApi';
import type { EntityMetabolismDrug } from '@/lib/metabolism';

vi.mock('@/lib/bioEntitiesApi', () => ({
  fetchEntityMetabolismDrugs: vi.fn(),
}));

const LINKED: EntityMetabolismDrug[] = [
  {
    routeId: 11,
    drug: {
      id: 3,
      slug: 'diazepam',
      names: { nb: 'Diazepam', en: 'Diazepam' },
      pubchemCid: 3016,
    },
    fraction: { min: null, median: 0.33, max: null },
    note: null,
  },
  {
    routeId: 12,
    drug: {
      id: 8,
      slug: 'warfarin',
      names: { nb: 'Warfarin', en: 'Warfarin' },
      pubchemCid: 54678486,
    },
    fraction: null,
    note: 'S-enantiomer only',
  },
];

function renderSection() {
  return render(
    <MemoryRouter>
      <EntityMetabolismDrugs entityId={7} />
    </MemoryRouter>,
  );
}

describe('EntityMetabolismDrugs', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18nApp.changeLanguage('en');
  });

  it('shows the linked-drug count collapsed and reveals the list on expand', async () => {
    vi.mocked(fetchEntityMetabolismDrugs).mockResolvedValue(LINKED);
    renderSection();

    const toggle = await screen.findByRole('button', {
      name: /drugs metabolised via this entity/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('(2)');
    // Collapsed: the drugs themselves are not in the document yet.
    expect(screen.queryByText('Diazepam')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Each drug links to its monograph, and the dose share is rendered.
    expect(screen.getByText('Diazepam').closest('a')).toHaveAttribute(
      'href',
      '/wiki/drug/3',
    );
    expect(screen.getByText('33%')).toBeInTheDocument();
    // A route note rides along; a fraction-less route simply shows no percent.
    expect(screen.getByText('S-enantiomer only')).toBeInTheDocument();
  });

  it('renders nothing when no drug is linked to the entity', async () => {
    vi.mocked(fetchEntityMetabolismDrugs).mockResolvedValue([]);
    const { container } = renderSection();

    await waitFor(() =>
      expect(fetchEntityMetabolismDrugs).toHaveBeenCalledWith(
        7,
        expect.anything(),
      ),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the lookup fails', async () => {
    vi.mocked(fetchEntityMetabolismDrugs).mockRejectedValue(
      new Error('network'),
    );
    const { container } = renderSection();

    await waitFor(() =>
      expect(fetchEntityMetabolismDrugs).toHaveBeenCalled(),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
