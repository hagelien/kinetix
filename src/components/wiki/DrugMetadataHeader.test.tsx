/**
 * The monograph's outbound link to Farmakologiportalen.
 *
 * It sits in the metadata strip alongside the PubChem CID and is built from
 * `drugs.farmakologiportalen_path`, so the two things worth pinning are that a
 * stored path becomes a real link and that an absent one leaves no link
 * behind — a monograph the portal does not cover must not show a dead one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18nApp from '@/i18n';
import { DrugMetadataHeader } from './DrugMetadataHeader';

const mockDrug = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

vi.mock('./useDrugSidebarData', () => ({
  useDrugSidebarData: () => ({
    drug: mockDrug.value,
    indicators: { comments: {}, refs: {} },
    pendingCounts: {},
    ownPendingParams: new Set(),
    pendingEditsByParam: {},
    reload: () => {},
  }),
}));

// Non-admin viewer: the strip shows names only, which is exactly the case the
// portal link has to work in — it is the one external reference every reader
// gets, while the PubChem CID row stays admin-only.
vi.mock('@/lib/usePermissions', () => ({ useCan: () => false }));

function drugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    slug: 'morfin-3-glukuronid',
    names: { nb: 'Morfin-3-glukuronid' },
    nameShort: null,
    aliases: ['M3G'],
    pubchemCid: 5484731,
    ...overrides,
  };
}

describe('DrugMetadataHeader — Farmakologiportalen link', () => {
  beforeEach(async () => {
    mockDrug.value = null;
    await i18nApp.changeLanguage('en');
  });

  it('links to the substance page when a portal path is stored', async () => {
    mockDrug.value = drugRow({
      farmakologiportalenPath: '/content/757/Morfin-3-glukuronid-M3G',
    });
    render(<DrugMetadataHeader drugCid={1} />);

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'monograph' }),
    );
    expect(link).toHaveAttribute(
      'href',
      'https://farmakologiportalen.no/content/757/Morfin-3-glukuronid-M3G',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Farmakologiportalen/)).toBeInTheDocument();
  });

  it('renders no link when the drug has no portal counterpart', () => {
    mockDrug.value = drugRow({ farmakologiportalenPath: null });
    render(<DrugMetadataHeader drugCid={1} />);

    expect(screen.queryByText(/Farmakologiportalen/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('renders no link for a path it would not accept', () => {
    // Guards the renderer, not just the builder: a bad value in the column
    // must not reach an href.
    mockDrug.value = drugRow({
      farmakologiportalenPath: 'https://evil.example/content/1/Morfin',
    });
    render(<DrugMetadataHeader drugCid={1} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
