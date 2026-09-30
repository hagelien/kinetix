import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CommandPalette } from '@/components/CommandPalette';
import { fetchDrugSearchResults } from '@/lib/drugApi';
import { loadMethods } from '@/data';
import { useDrugStore } from '@/stores/drugStore';
import { useAuthStore } from '@/stores/authStore';

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">{location.pathname + location.search}</span>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/drugApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/drugApi')>('@/lib/drugApi');
  return {
    ...actual,
    fetchDrugSearchResults: vi.fn(),
  };
});

vi.mock('@/data', async () => {
  const actual = await vi.importActual<typeof import('@/data')>('@/data');
  return {
    ...actual,
    loadMethods: vi.fn(),
  };
});

describe('CommandPalette', () => {
  const originalDrugState = useDrugStore.getState();

  beforeEach(() => {
    vi.mocked(fetchDrugSearchResults).mockResolvedValue({ drugs: [] });
    vi.mocked(loadMethods).mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              slug: 'alprazolam',
              title: 'Alprazolam',
              pageType: 'drug_monograph',
            },
            {
              slug: 'forensic-toxicology',
              title: 'Forensic Toxicology',
              pageType: 'article',
            },
          ],
        }),
      }),
    );
  });

  const originalAuthState = useAuthStore.getState();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    useDrugStore.setState(originalDrugState);
    useAuthStore.setState(originalAuthState);
  });

  it('renders non-monograph wiki results and skips drug_monograph duplicates', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'alp' },
    });

    await waitFor(() => {
      expect(screen.getByText('Forensic Toxicology')).toBeInTheDocument();
    });
    // Every drug owns a monograph, so the drug_monograph wiki hit is a
    // duplicate of the drug result and must not appear as its own row.
    expect(screen.queryByText('Alprazolam')).not.toBeInTheDocument();
    expect(screen.queryByText('search.drugMonograph')).not.toBeInTheDocument();
    expect(screen.getByText('search.wikiPage')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      '/api/wiki/search?q=alp&limit=6&view=compact',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ranks an exact drug-name match above an approximate one', async () => {
    // Backend returns the substring match first; the palette should re-rank so
    // the exact "etanol" hit floats to the top of the list.
    vi.mocked(fetchDrugSearchResults).mockResolvedValue({
      drugs: [
        { id: 1, names: { en: 'Metanol' }, aliases: ['etanol-related'] },
        { id: 2, names: { en: 'Etanol' } },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'etanol' },
    });

    // formatGenericDrugName lowercases the leading letter for display.
    await waitFor(() => {
      expect(screen.getByText('etanol')).toBeInTheDocument();
    });
    const titles = screen
      .getAllByText(/^(etanol|metanol)$/)
      .map((el) => el.textContent);
    expect(titles[0]).toBe('etanol');
  });

  it('shows aliases and the short name beside the English name in gray subtitle', async () => {
    // User typed a substring that only appears in an alias — the row's bold
    // title and English name don't contain it, so the alias must be surfaced.
    vi.mocked(fetchDrugSearchResults).mockResolvedValue({
      drugs: [
        {
          id: 7,
          names: { nb: '2-propyl-2-pentensyre', en: '2-Propyl-2-pentenoic acid' },
          nameShort: 'VPA',
          aliases: ['valproinsyre', '2-propyl-2-pentenoic acid 2-ene'],
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: '2-ene' },
    });

    // The test i18n is pinned to English, so the English name is the bold
    // title and the alternate (Norwegian) name leads the gray subtitle. The
    // matched alias floats ahead of the others; the short name + remaining
    // alias still appear.
    const subtitle = await screen.findByText(/valproinsyre/);
    expect(subtitle.textContent).toBe(
      '2-propyl-2-pentensyre · 2-propyl-2-pentenoic acid 2-ene · VPA · valproinsyre',
    );
  });

  it('finds a cited source by its DOI and opens the reference page', async () => {
    // The user pastes the identifier straight out of a PDF — no drug or wiki
    // page carries that string, so before #references-search this returned
    // "no results" and offered to create a drug named after the DOI.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () =>
            String(url).includes('view=search')
              ? {
                  references: [
                    {
                      id: 42,
                      drugId: null,
                      type: 'doi',
                      identifier: '10.1093/jat/bkaa107',
                      metadata: {
                        title: 'Postmortem drug redistribution',
                        authors: ['Mantinieks D'],
                        year: 2021,
                      },
                      createdAt: '2026-05-12T00:00:00.000Z',
                      matchRank: 0,
                      matchSource: 'identifier',
                      reviewSnippet: null,
                    },
                  ],
                }
              : { results: [] },
        }),
      ),
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'doi:10.1093/jat/bkaa107' },
    });

    const hit = await screen.findByText('Postmortem drug redistribution');
    fireEvent.click(hit);

    expect(screen.getByTestId('location').textContent).toBe('/references/42');
  });

  it('surfaces a source matched only inside its paper review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () =>
            String(url).includes('view=search')
              ? {
                  references: [
                    {
                      id: 9,
                      drugId: null,
                      type: 'pmid',
                      identifier: '33245119',
                      metadata: { title: 'Femoral blood sampling' },
                      createdAt: '2026-05-12T00:00:00.000Z',
                      matchRank: 5,
                      matchSource: 'review',
                      reviewSnippet: 'kohorten er liten, men konsistent',
                    },
                  ],
                }
              : { results: [] },
        }),
      ),
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'kohorten' },
    });

    expect(await screen.findByText('Femoral blood sampling')).toBeInTheDocument();
    // The whole subtitle comes from one interpolated key (the test i18n stub
    // echoes key names), not from concatenated fragments.
    expect(
      screen.getByText('search.referenceReviewSubtitle'),
    ).toBeInTheDocument();
  });

  it('keeps a partial identifier match below an exact drug hit', async () => {
    // matchSource is 'identifier' whenever the query appears ANYWHERE in the
    // identifier, so a fragment like "etano" occurring in a DOI must not be
    // promoted to an exact hit ahead of the drug whose name starts with it —
    // only the server's rank 0 means "the query IS this identifier".
    vi.mocked(fetchDrugSearchResults).mockResolvedValue({
      drugs: [{ id: 2, names: { en: 'Etanol' } }],
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () =>
            String(url).includes('view=search')
              ? {
                  references: [
                    {
                      id: 5,
                      drugId: null,
                      type: 'doi',
                      identifier: '10.1000/etano-supplement',
                      metadata: { title: 'Supplementary appendix' },
                      createdAt: '2026-05-12T00:00:00.000Z',
                      matchRank: 2,
                      matchSource: 'identifier',
                      reviewSnippet: null,
                    },
                  ],
                }
              : { results: [] },
        }),
      ),
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'etano' },
    });

    await waitFor(() => {
      expect(screen.getByText('Supplementary appendix')).toBeInTheDocument();
    });
    const titles = screen
      .getAllByText(/^(etanol|Supplementary appendix)$/)
      .map((el) => el.textContent);
    expect(titles[0]).toBe('etanol');
  });

  it('offers admins a shortcut to create a drug when nothing matches', async () => {
    // No hits from either source.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }),
    );
    useAuthStore.setState({
      user: { role: 'admin' } as never,
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'morfin-6-glukuronid' },
    });

    const createButton = await screen.findByRole('button', {
      name: /search.createDrug/i,
    });
    fireEvent.click(createButton);

    expect(screen.getByTestId('location').textContent).toBe(
      '/wiki/new?type=drug_monograph&q=morfin-6-glukuronid',
    );
  });

  it('does not offer the create shortcut to non-admins', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }),
    );
    useAuthStore.setState({
      user: { role: 'contributor' } as never,
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'morfin-6-glukuronid' },
    });

    await waitFor(() => {
      expect(screen.getByText('search.noResults')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /search.createDrug/i }),
    ).not.toBeInTheDocument();
  });

  it('does not reload analytical methods on subsequent palette opens', async () => {
    useAuthStore.setState({
      user: { role: 'admin' } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(loadMethods).mockResolvedValue([
      {
        id: '9001',
        dbId: 17,
        name: 'LC-MS panel',
        description: 'LC-MS panel',
        components: [],
        drugIds: [],
        matrices: ['blood'],
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    await waitFor(() => expect(loadMethods).toHaveBeenCalled());
    const callsAfterFirstOpen = vi.mocked(loadMethods).mock.calls.length;
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /nav.search/i }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText('search.placeholder'),
      ).toBeInTheDocument(),
    );

    expect(loadMethods).toHaveBeenCalledTimes(callsAfterFirstOpen);
  });

  it('opens a CID-less drug in the simulator under its unambiguous drug: key', async () => {
    // #1256 item 6: a bare numeric key here would be indistinguishable from
    // some OTHER drug's PubChem CID. Selecting a drug result while the
    // simulator is the active context must use buildDrugComponentId's
    // `drug:<id>` spelling, not `pubchemCid ?? drugId`.
    vi.mocked(fetchDrugSearchResults).mockResolvedValue({
      drugs: [{ id: 803, names: { en: 'Shadow Drug' }, pubchemCid: null }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/modeling']}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /nav.search/i }));
    fireEvent.change(screen.getByPlaceholderText('search.placeholder'), {
      target: { value: 'Shadow Drug' },
    });

    const hit = await screen.findByText('shadow Drug');
    fireEvent.click(hit);

    const location = screen.getByTestId('location').textContent ?? '';
    expect(new URLSearchParams(location.split('?')[1]).get('drugId')).toBe(
      'drug:803',
    );
  });
});
