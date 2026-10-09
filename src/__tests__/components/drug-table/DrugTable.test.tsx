import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { DrugTable } from '@/components/DrugTable';
import { loadComponents, loadMethods } from '@/data';
import { useDrugStore } from '@/stores/drugStore';
import { useAuthStore } from '@/stores/authStore';
import { useAppStore } from '@/stores/appStore';
import { STORAGE_KEYS } from '@/types';
import { resetRefsDetectionCache } from '@/lib/refsDetectionApi';
import { SYNTHETIC_REFS_SOURCE } from '@/lib/__tests__/fixtures/refsSyntheticGuideline';
import {
  DETECTION_COLUMN_PRESET,
  REFS_DETECTION_COLUMN_PRESET,
} from '@/lib/detectionColumnPresets';

/** The catalog every case starts from; one test swaps it for its own. */
const DEFAULT_COMPONENTS = [
  {
    id: '1',
    _dbId: 1,
    names: { nb: 'Teststoff', en: 'Test drug' },
    molecularWeight: 250,
    toxicConcentration: { min: 2, max: 4, unit: 'mg/L' },
  },
];

/**
 * The server-side search path. The preloaded catalog is capped by popularity,
 * so a search can surface a substance the store never held — the case the REFS
 * column has to answer for too.
 */
const fetchDrugSearchResultsMock = vi.fn();
const fetchDrugsMock = vi.fn();

vi.mock('@/lib/drugApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drugApi')>();
  return {
    ...actual,
    trackDrugInteraction: vi.fn(),
    fetchDrugSearchResults: (...args: unknown[]) =>
      fetchDrugSearchResultsMock(...args),
    fetchDrugs: (...args: unknown[]) => fetchDrugsMock(...args),
  };
});

vi.mock('@/data', () => ({
  loadComponents: vi.fn(),
  loadMethods: vi.fn().mockResolvedValue([]),
  // The auth store clears the methods cache whenever a sign-in changes who may
  // read them — which the granted member below does.
  clearMethodsCache: vi.fn(),
}));

describe('DrugTable columns', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const localStorageValues = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation(
      (key: string) => localStorageValues.get(key) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (key: string, value: string) => {
        localStorageValues.set(key, value);
      },
    );
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      localStorageValues.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      localStorageValues.clear();
    });
    // `clearAllMocks` keeps implementations, so the case that swaps the
    // catalog would otherwise hand its fixture to every case after it.
    vi.mocked(loadComponents).mockResolvedValue(DEFAULT_COMPONENTS as never);
    fetchDrugSearchResultsMock.mockResolvedValue({ drugs: [] });
    fetchDrugsMock.mockResolvedValue({ drugs: [] });
    await i18n.changeLanguage('en');
    act(() => {
      useAuthStore.setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
      useDrugStore.setState({
        components: [],
        methods: [],
        activeDrug: null,
        searchQuery: '',
        selectedMethod: null,
        sortColumn: '_popularityScore',
        sortDirection: 'desc',
        tableView: 'full',
        pendingColumnPreset: null,
      });
    });
    resetRefsDetectionCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('/api/refs-detection-times')) {
          return {
            ok: true,
            json: async () => ({
              source: SYNTHETIC_REFS_SOURCE,
              preamble: '',
              rows: [
                {
                  key: 'teststoff',
                  parent: 'Teststoff',
                  metabolites: [],
                  readings: [
                    { scope: 'both', statement: { kind: 'band', band: 'week' } },
                  ],
                },
                {
                  // A row that answers only for its parent, like the
                  // guideline's metadon/EDDP cell.
                  key: 'moderstoff',
                  parent: 'Moderstoff',
                  metabolites: ['Metabolitten'],
                  readings: [
                    {
                      scope: 'parent',
                      statement: { kind: 'band', band: 'twoWeeks' },
                    },
                  ],
                },
              ],
              gated: false,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
  });

  it('shows the standard name inline with shortname and aliases in a hover tooltip', async () => {
    vi.mocked(loadComponents).mockResolvedValue([
      {
        id: '1',
        _dbId: 1,
        names: { nb: 'Tetrahydrocannabinol', en: 'Tetrahydrocannabinol' },
        nameShort: 'THC',
        aliases: ['Cannabis', 'weed'],
        molecularWeight: 314,
      },
    ] as never);

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    // The row shows the standard name, not the shortname it used to render.
    // It appears both inline and as the tooltip header, so at least one match.
    expect(
      (await screen.findAllByText('Tetrahydrocannabinol')).length,
    ).toBeGreaterThan(0);

    // The shortname and aliases live in the row's tooltip.
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('THC');
    expect(tooltip).toHaveTextContent('Cannabis');
    expect(tooltip).toHaveTextContent('weed');
  });

  it('does not request analytical methods for users without method access', async () => {
    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    expect(loadMethods).not.toHaveBeenCalled();
  });

  it('lets users show any registered drug parameter as a persisted column', async () => {
    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const toxicColumnToggle = screen.getByRole('checkbox', {
      name: 'Toxic conc.',
    });
    fireEvent.click(toxicColumnToggle);

    expect(
      screen.getByRole('columnheader', {
        name: 'Toxic concentration range [mg/L]',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2.*4/)).toBeInTheDocument();

    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem(STORAGE_KEYS.drugTableColumns) ?? '[]'),
      ).toContain('toxicConcentration');
    });
  });

  it('writes fractions the way the user asked for them', async () => {
    // Bioavailability is stored as the 0–1 fraction; the preference decides
    // only how it is written.
    vi.mocked(loadComponents).mockResolvedValue([
      {
        ...DEFAULT_COMPONENTS[0],
        bioavailability: { min: 0.25, max: 0.4 },
        proteinBinding: { median: 0.99 },
      },
    ] as never);

    act(() => {
      useAppStore.setState({ fractionDisplay: 'decimal' });
    });

    const { unmount } = render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');
    expect(screen.getByText('0.25–0.4')).toBeInTheDocument();
    expect(screen.getByText('0.99')).toBeInTheDocument();

    unmount();
    act(() => {
      useAppStore.setState({ fractionDisplay: 'percent' });
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');
    expect(screen.getByText('25–40%')).toBeInTheDocument();
    expect(screen.getByText('99%')).toBeInTheDocument();
    // …and the decimal notation is gone, not merely joined by the percentage.
    expect(screen.queryByText('0.25–0.4')).not.toBeInTheDocument();
  });

  it('keeps unit conversion out of the standard view but offers it in the picker', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    expect(
      screen.queryByRole('columnheader', { name: 'Unit Conversion' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unit Conversion' }));

    expect(
      screen.getByRole('columnheader', { name: 'Unit Conversion' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem(STORAGE_KEYS.drugTableColumns) ?? '[]'),
      ).toContain('conversion');
    });

    // An explicit opt-in survives a reload — the one-time retirement below
    // must not keep clawing the column back out.
    unmount();
    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );
    await screen.findByText('Test drug');
    expect(
      screen.getByRole('columnheader', { name: 'Unit Conversion' }),
    ).toBeInTheDocument();
  });

  it('drops unit conversion once from a column set persisted before it became opt-in', async () => {
    localStorage.setItem(
      STORAGE_KEYS.drugTableColumns,
      JSON.stringify(['name', 'conversion', 'molecularWeight']),
    );

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    expect(
      screen.queryByRole('columnheader', { name: 'Unit Conversion' }),
    ).not.toBeInTheDocument();
    // The rest of the persisted selection is untouched.
    expect(
      screen.getByRole('columnheader', { name: /Molecular weight/ }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem(STORAGE_KEYS.drugTableColumns) ?? '[]'),
      ).not.toContain('conversion');
    });
  });

  it('switches to a column axis another surface asked for, once', async () => {
    // The detection-times page's "every substance" link hands the axis over
    // through the store, because the table may not be mounted when it is
    // clicked.
    act(() => {
      useDrugStore.getState().requestColumnPreset([...DETECTION_COLUMN_PRESET]);
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    expect(
      screen.getByRole('columnheader', { name: /Urine detection window/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Molecular weight/ }),
    ).not.toBeInTheDocument();

    // Taken, not left standing: the reader's next column choice must not be
    // overruled by the same request on the following render.
    await waitFor(() => {
      expect(useDrugStore.getState().pendingColumnPreset).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'MW (g/mol)' }));
    expect(
      screen.getByRole('columnheader', { name: /Molecular weight/ }),
    ).toBeInTheDocument();
  });

  it('keeps the REFS column out of the picker for a reader outside the group', async () => {
    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    expect(
      screen.queryByRole('checkbox', { name: 'Urine (REFS)' }),
    ).not.toBeInTheDocument();

    // And a preset naming it cannot smuggle it in either.
    act(() => {
      useDrugStore
        .getState()
        .requestColumnPreset([...REFS_DETECTION_COLUMN_PRESET]);
    });
    await waitFor(() => {
      expect(useDrugStore.getState().pendingColumnPreset).toBeNull();
    });
    expect(
      screen.queryByRole('columnheader', { name: 'Urine (REFS)' }),
    ).not.toBeInTheDocument();
  });

  it("shows a group member REFS's own band next to the pooled windows", async () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: 42,
          email: 'r@b.com',
          username: 'rita',
          role: 'authenticated',
          displayName: null,
          enabledConcentrationUnits: ['µmol/L'],
          notificationSettings: null,
          favoriteParameters: [],
          groups: [{ id: 1, slug: 'lab', name: 'Lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
        },
        isAuthenticated: true,
        isLoading: false,
      });
      useDrugStore
        .getState()
        .requestColumnPreset([...REFS_DETECTION_COLUMN_PRESET]);
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    expect(
      await screen.findByRole('columnheader', { name: 'Urine (REFS)' }),
    ).toBeInTheDocument();
    // The guideline's band for the substance, not a pooled number.
    expect(await screen.findByText('Last week')).toBeInTheDocument();
  });

  it('does not leave a REFS cell behind when the reader may not see the column', async () => {
    // The column set is persisted per BROWSER: a granted member who enables
    // the REFS column leaves its id in local storage for whoever signs in
    // next. Filtering the header alone left an extra cell in every row and
    // shifted the whole table one column out of step with its own headings.
    localStorage.setItem(
      STORAGE_KEYS.drugTableColumns,
      JSON.stringify(['name', 'molecularWeight', 'refsUrineDetection']),
    );

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');

    const headers = screen.getAllByRole('columnheader');
    const cells = screen.getAllByRole('cell').length
      ? screen.getAllByRole('cell')
      : [];
    const rowHeaderCount = headers.length;
    expect(
      screen.queryByRole('columnheader', { name: 'Urine (REFS)' }),
    ).not.toBeInTheDocument();
    // One row in the fixture: its cells must match the headings exactly.
    expect(cells).toHaveLength(rowHeaderCount);
  });

  it("does not hand a metabolite the parent's band", async () => {
    // The guideline's metadon cell reads "siste par ukene (moderstoff)" with
    // EDDP beside it — it states nothing about the metabolite, and answering
    // with the parent's band would invent a forensic statement.
    vi.mocked(loadComponents).mockResolvedValue([
      {
        id: '2',
        _dbId: 2,
        names: { nb: 'Metabolitten', en: 'Metabolitten' },
        molecularWeight: 100,
      },
    ] as never);

    act(() => {
      useAuthStore.setState({
        user: {
          id: 42,
          email: 'r@b.com',
          username: 'rita',
          role: 'authenticated',
          displayName: null,
          enabledConcentrationUnits: ['µmol/L'],
          notificationSettings: null,
          favoriteParameters: [],
          groups: [{ id: 1, slug: 'lab', name: 'Lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
        },
        isAuthenticated: true,
        isLoading: false,
      });
      useDrugStore
        .getState()
        .requestColumnPreset([...REFS_DETECTION_COLUMN_PRESET]);
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Metabolitten');
    await screen.findByRole('columnheader', { name: 'Urine (REFS)' });

    expect(
      await screen.findByText(
        'No detection time stated (as a metabolite of Moderstoff)',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Last couple of weeks/)).not.toBeInTheDocument();
  });

  it('labels a search hit the preloaded catalog never held', async () => {
    // `components` in the store is the popularity-capped preload; a search
    // resolves DB-only substances through the server. Built from the preload,
    // the REFS column showed "—" for those rows — an empty cell claiming the
    // guideline is silent about a substance it names.
    fetchDrugSearchResultsMock.mockResolvedValue({
      drugs: [{ id: 9, slug: 'moderstoff', names: { nb: 'Moderstoff' } }],
    });
    fetchDrugsMock.mockResolvedValue({
      drugs: [
        {
          id: 9,
          slug: 'moderstoff',
          names: { nb: 'Moderstoff', en: 'Moderstoff' },
          nameShort: null,
          aliases: null,
          pubchemCid: null,
          molecularWeight: 300,
          popularityScore: 0,
          searchKey: 'moderstoff',
          createdAt: '',
          updatedAt: '',
        },
      ],
    });

    act(() => {
      useAuthStore.setState({
        user: {
          id: 42,
          email: 'r@b.com',
          username: 'rita',
          role: 'authenticated',
          displayName: null,
          enabledConcentrationUnits: ['µmol/L'],
          notificationSettings: null,
          favoriteParameters: [],
          groups: [{ id: 1, slug: 'lab', name: 'Lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
        },
        isAuthenticated: true,
        isLoading: false,
      });
      useDrugStore
        .getState()
        .requestColumnPreset([...REFS_DETECTION_COLUMN_PRESET]);
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    await screen.findByText('Test drug');
    act(() => {
      useDrugStore.getState().setSearchQuery('moderstoff');
    });

    expect(await screen.findByText('Moderstoff')).toBeInTheDocument();
    // The guideline's band for it, not an em dash.
    await waitFor(() => {
      expect(screen.getByText('Last couple of weeks')).toBeInTheDocument();
    });
  });

  it('switches parameter headers between full and compact labels as width changes', async () => {
    let containerWidth = 900;
    let resizeCallback: ResizeObserverCallback | null = null;
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => containerWidth);
    const originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    try {
      render(
        <MemoryRouter>
          <DrugTable />
        </MemoryRouter>,
      );

      await screen.findByText('Test drug');

      // Compact: only the symbol + unit primary line shows; the
      // descriptive name subtitle is dropped to save horizontal space.
      expect(await screen.findByText('Vd [L/kg]')).toBeInTheDocument();
      expect(
        screen.queryByText('Volume of distribution'),
      ).not.toBeInTheDocument();
      // The full descriptive label always backs the accessible name.
      expect(
        screen.getByRole('columnheader', {
          name: 'Vd (Volume of distribution) [L/kg]',
        }),
      ).toBeInTheDocument();

      containerWidth = 1800;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });

      // Full: the descriptive name returns as a second line beneath the
      // symbol + unit primary.
      await waitFor(() => {
        expect(
          screen.getByText('Volume of distribution'),
        ).toBeInTheDocument();
      });
      expect(screen.getByText('Vd [L/kg]')).toBeInTheDocument();
      expect(
        screen.getByRole('columnheader', {
          name: 'Vd (Volume of distribution) [L/kg]',
        }),
      ).toBeInTheDocument();
    } finally {
      clientWidthSpy.mockRestore();
      window.ResizeObserver = originalResizeObserver;
    }
  });
});
