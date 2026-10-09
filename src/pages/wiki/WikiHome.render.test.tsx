/**
 * A hub page with many subpages (e.g. "Bioentiteter") lists only the first few
 * in its wiki-home card and links to the hub for the rest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { MAX_CARD_SUBPAGES, WikiHome } from './WikiHome';

vi.mock('@/lib/usePermissions', () => ({ useCan: () => false }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WikiHome subpage cap', () => {
  it('shows the first subpages and links to the hub for the rest', async () => {
    const total = MAX_CARD_SUBPAGES + 5;
    const pages = [
      { id: 1, slug: 'bioentiteter', title: 'Bioentiteter', pageType: 'topic', parentId: null },
      ...Array.from({ length: total }, (_, i) => ({
        id: 100 + i,
        slug: `entity-${String(i).padStart(2, '0')}`,
        title: `Entity ${String(i).padStart(2, '0')}`,
        pageType: 'entity_monograph',
        parentId: 1,
      })),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ pages, hasMore: false }) })),
    );

    render(
      <MemoryRouter>
        <WikiHome />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Entity 00')).toBeInTheDocument();
    expect(screen.queryByText(`Entity ${MAX_CARD_SUBPAGES}`)).toBeNull();
    const more = screen.getByRole('link', { name: /\+ 5/ });
    expect(more).toHaveAttribute('href', '/wiki/bioentiteter');
  });
});
