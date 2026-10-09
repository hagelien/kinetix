/**
 * Behaviour tests for DrugMonographSidebar:
 * - category boxes expand one at a time (chemistry by default)
 * - tab mode renders a single section without its box
 * - active section is remembered across navigation
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18nApp from '@/i18n';
import {
  DrugMonographSidebar,
  type SidebarSectionId,
} from './DrugMonographSidebar';
import { useAuthStore } from '@/stores/authStore';
import { useAppStore } from '@/stores/appStore';
import {
  cancelPriorityFlag,
  createPriorityFlag,
  fetchPriorityFlags,
} from '@/lib/parameterPriorityFlagsApi';
import { fetchDrugReferences } from '@/lib/referencesApi';
import { fetchMethodLimitsForDrug } from '@/lib/drugApi';
import type { OrderedReference } from '@/lib/useDrugBibliography';

const SIDEBAR_SECTION_STORAGE_KEY = 'kinetix.monographSidebar.expandedSection';
const mockDrugState = vi.hoisted(() => ({
  id: 1,
  pubchemCid: 100,
  molecularWeight: 151.16,
  receptorTargets: [] as Array<Record<string, unknown>>,
  metabolism: null as Record<string, unknown> | null,
  indicatorRefs: {} as Record<string, number[]>,
  parameterSummaries: undefined as Record<string, unknown> | undefined,
  parameterRouteSummaries: undefined as Record<string, unknown> | undefined,
}));

vi.mock('./useDrugSidebarData', () => ({
  useDrugSidebarData: () => ({
    drugMatchesRequest: true,
    drug: {
      id: mockDrugState.id,
      pubchemCid: mockDrugState.pubchemCid,
      slug: 'paracetamol',
      names: { en: 'Paracetamol' },
      molecularWeight: mockDrugState.molecularWeight,
      // halfLife etc. are populated by the merge in api/drugs.ts; the
      // sidebar reads them off the drug row via readDrugMetadataValue.
      halfLife: { min: 1.5, max: 3, unit: 'h' },
      volumeOfDistribution: { min: 0.7, max: 1.0, unit: 'L/kg' },
      bioavailability: { min: 0.6, max: 0.9, unit: 'fraction' },
      proteinBinding: { min: 0.05, max: 0.2, unit: 'fraction' },
      pKa: { median: 9.5 },
      therapeuticConcentration: { min: 10000, max: 20000, unit: 'µmol/L' },
      receptorTargets: mockDrugState.receptorTargets,
      metabolism: mockDrugState.metabolism,
      parameterSummaries: mockDrugState.parameterSummaries,
      parameterRouteSummaries: mockDrugState.parameterRouteSummaries,
    },
    indicators: { comments: {}, refs: mockDrugState.indicatorRefs },
    pendingCounts: {},
    ownPendingParams: new Set(),
    pendingEditsByParam: {},
    reload: vi.fn(),
  }),
}));

vi.mock('@/lib/parameterPriorityFlagsApi', () => ({
  fetchPriorityFlags: vi.fn(),
  createPriorityFlag: vi.fn(),
  cancelPriorityFlag: vi.fn(),
}));

vi.mock('@/lib/referencesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/referencesApi')>()),
  fetchDrugReferences: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/drugApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/drugApi')>()),
  fetchMethodLimitsForDrug: vi.fn().mockResolvedValue({ methods: [] }),
}));

vi.mock('@/lib/parameterEntriesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/parameterEntriesApi')>()),
  fetchParameterEntries: vi.fn().mockResolvedValue([]),
}));

function setUser(
  favoriteParameters: string[] | null,
  role: 'authenticated' | 'contributor' | 'editor' | 'admin' = 'contributor',
) {
  if (favoriteParameters === null) {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    return;
  }
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role,
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters,
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

function renderSidebar(
  sharedReferences?: OrderedReference[] | null,
  section?: SidebarSectionId,
) {
  return render(
    <MemoryRouter>
      <DrugMonographSidebar
        drugCid={mockDrugState.pubchemCid}
        sharedReferences={sharedReferences}
        section={section}
      />
    </MemoryRouter>,
  );
}

/** Pre-select the accordion section a test reads rows from. */
function openSection(section: SidebarSectionId) {
  localStorage.setItem(SIDEBAR_SECTION_STORAGE_KEY, JSON.stringify(section));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('DrugMonographSidebar', () => {
  const originalState = useAuthStore.getState();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    const storage = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation(
      (key: string) => storage.get(key) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation(
      (key: string, value: string) => {
        storage.set(key, value);
      },
    );
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      storage.clear();
    });
    vi.mocked(fetchPriorityFlags).mockResolvedValue({ flags: [] });
    vi.mocked(createPriorityFlag).mockResolvedValue({
      flag: {
        id: 10,
        drugId: 1,
        parameter: 'halfLife',
        status: 'active',
        note: null,
        flaggedBy: 1,
        resolvedBy: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      },
    });
    vi.mocked(cancelPriorityFlag).mockResolvedValue(undefined);
    vi.mocked(fetchDrugReferences).mockResolvedValue([]);
    vi.mocked(fetchMethodLimitsForDrug).mockResolvedValue({ methods: [] });
    mockDrugState.id = 1;
    mockDrugState.pubchemCid = 100;
    mockDrugState.molecularWeight = 151.16;
    useAppStore.setState({ enabledUnits: ['µmol/L', 'mg/L'], ethanolUnit: '‰' });
    mockDrugState.receptorTargets = [];
    mockDrugState.metabolism = null;
    mockDrugState.indicatorRefs = {};
    mockDrugState.parameterSummaries = undefined;
    mockDrugState.parameterRouteSummaries = undefined;
    localStorage.removeItem(SIDEBAR_SECTION_STORAGE_KEY);
    // Pin English so the label-based assertions don't depend on the
    // browser's detected language (which falls back to nb for the
    // Norwegian-default app).
    await i18nApp.changeLanguage('en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalState);
  });

  // Matchers built off the live i18n bundle (loaded via `@/i18n`) so we
  // assert against what the user actually sees rather than the raw key.
  const HALF_LIFE_LABEL = /elimination half-life/i;
  const VD_LABEL = /volume of distribution/i;

  it('opens the parameter dialog a notification link points at', async () => {
    setUser([]);
    render(
      <MemoryRouter initialEntries={['/wiki/x?param=halfLife&view=discussion&comment=5']}>
        <DrugMonographSidebar drugCid={mockDrugState.pubchemCid} />
      </MemoryRouter>,
    );
    // A source-value parameter's discussion lives at the bottom of its
    // sources dialog, so the comment link opens that dialog.
    const dialog = await screen.findByRole('dialog', {
      name: /source values for elimination half-life/i,
    });
    expect(
      within(dialog).getByTestId('parameter-sources-discussion'),
    ).toBeInTheDocument();
  });

  it('opens the discussion dialog for a parameter without source values', async () => {
    setUser([]);
    render(
      <MemoryRouter initialEntries={['/wiki/x?param=molecularWeight&view=discussion&comment=5']}>
        <DrugMonographSidebar drugCid={mockDrugState.pubchemCid} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('dialog', { name: /— discussion/i }),
    ).toBeInTheDocument();
  });

  it('ignores a link to a parameter it does not know', () => {
    setUser([]);
    render(
      <MemoryRouter initialEntries={['/wiki/x?param=notAParameter&view=history']}>
        <DrugMonographSidebar drugCid={mockDrugState.pubchemCid} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows ethanol concentrations in the ethanol unit (‰ by default)', () => {
    mockDrugState.pubchemCid = 702;
    mockDrugState.molecularWeight = 46.07;
    setUser([]);
    openSection('interpretive_concentrations');
    const { container } = renderSidebar();
    // 10 000–20 000 µmol/L × 46.07 g/mol = 0.461–0.921 g/L = ‰. The unit sits
    // in its own tooltip trigger, so match on the text content.
    expect(container.textContent).toMatch(/0\.461–0\.921 ‰/);
  });

  it('follows a changed ethanol unit, and leaves other drugs alone', () => {
    mockDrugState.pubchemCid = 702;
    mockDrugState.molecularWeight = 46.07;
    useAppStore.setState({ ethanolUnit: '%' });
    setUser([]);
    openSection('interpretive_concentrations');
    const first = renderSidebar();
    expect(first.container.textContent).toMatch(/0\.0461–0\.0921 %/);
    first.unmount();

    mockDrugState.pubchemCid = 100;
    const second = renderSidebar();
    expect(second.container.textContent).not.toContain('‰');
    expect(second.container.textContent).toMatch(/10\D000–20\D000 µmol\/L/);
  });

  it('prefixes a parameter value with its symbol', () => {
    setUser(['halfLife', 'bloodPlasmaRatio']);
    openSection('pharmacokinetics');
    renderSidebar();
    // The half-life row renders its conventional symbol (t½) in
    // front of the value so the number reads as a recognisable quantity.
    expect(screen.getByText('t½')).toBeInTheDocument();
  });

  it('shows a route-scoped pool under its route when the drug-level value is empty', () => {
    // Curating a drug's only Tmax sources onto `oral` empties the drug-level aggregate by design
    // (a route's Tmax is not the molecule's). The field must then read the route value, not "—".
    mockDrugState.parameterRouteSummaries = {
      tmax: {
        oral: {
          representative: 3.3,
          iqrLow: null,
          iqrHigh: null,
          min: 2,
          max: 4,
          unit: 'h',
          entryCount: 3,
          pooledCount: 3,
          contributingCitationIds: [],
          byMatrix: [],
          points: [],
          normalizedToWholeBlood: false,
        },
      },
    };
    setUser(['tmax']);
    openSection('pharmacokinetics');
    renderSidebar();
    // The whole pharmacokinetics section is open, so read the Tmax row only.
    const row = screen
      .getByText(/time to peak concentration/i)
      .closest('.group') as HTMLElement;
    expect(within(row).getByText('Oral')).toBeInTheDocument();
    // The pooled SPAN, as the drug-level line would render it — not a bare median, which
    // would imply a point estimate where the sources report an interval.
    expect(within(row).getByText(/2–4 h/)).toBeInTheDocument();
    // …and the em dash the empty drug-level value would otherwise print is gone.
    expect(within(row).queryByText('—')).toBeNull();
  });

  it('opens chemistry by default and shows no favorites box', () => {
    setUser(['halfLife', 'molecularWeight']);
    renderSidebar();
    expect(screen.queryByTestId('parameter-group-favorites')).toBeNull();
    expect(
      screen.getByRole('button', { name: /chemistry/i }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(HALF_LIFE_LABEL)).toBeNull();
    expect(screen.queryByText(VD_LABEL)).toBeNull();
  });

  it('expands one parameter category at a time', async () => {
    setUser([]);
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /pharmacokinetics/i }));
    expect(screen.getByText(VD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(HALF_LIFE_LABEL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /chemistry/i }));
    expect(screen.queryByText(VD_LABEL)).toBeNull();
    await waitFor(() =>
      expect(localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY)).toBe(
        JSON.stringify('chemistry'),
      ),
    );
  });

  it('renders one section without its box in tab mode', () => {
    setUser([]);
    renderSidebar(undefined, 'pharmacokinetics');
    expect(
      screen.getByTestId('drug-monograph-section-pharmacokinetics'),
    ).toBeInTheDocument();
    // No accordion: the rows show directly and no other section is offered.
    expect(screen.getByText(VD_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /chemistry/i })).toBeNull();
    // The tab is the page's choice; the accordion's memory is left alone.
    expect(localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY)).toBeNull();
  });


  it('keeps category boxes collapsed for anonymous visitors', () => {
    setUser(null);
    renderSidebar();
    expect(screen.queryByText(VD_LABEL)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /pharmacokinetics/i }));
    expect(screen.getByText(VD_LABEL)).toBeInTheDocument();
  });

  it('groups receptor-target mechanisms by tier in the pharmacodynamics section', () => {
    mockDrugState.receptorTargets = [
      {
        id: 12,
        drugId: 1,
        receptorTargetId: 7,
        interactionType: 'full_agonist',
        tier: 'primary',
        affinity: null,
        potency: null,
        efficacy: null,
        ki: { median: 2.4, unit: 'nmol/L' },
        ic50: null,
        ec50: null,
        emax: { median: 0.95, unit: 'fraction' },
        selectivityRatio: null,
        referenceIds: [3],
        evidenceNote: null,
        target: {
          id: 7,
          slug: 'mor',
          symbol: 'MOR',
          name: 'Mu opioid receptor',
          nameEn: 'Mu opioid receptor',
          targetClass: 'receptor',
          organism: 'Homo sapiens',
        },
      },
      {
        id: 13,
        drugId: 1,
        receptorTargetId: 9,
        interactionType: 'antagonist',
        tier: null,
        affinity: null,
        potency: null,
        efficacy: null,
        ki: null,
        ic50: null,
        ec50: null,
        emax: null,
        selectivityRatio: null,
        referenceIds: [],
        evidenceNote: null,
        target: {
          id: 9,
          slug: 'dor',
          symbol: 'DOR',
          name: 'Delta opioid receptor',
          nameEn: 'Delta opioid receptor',
          targetClass: 'receptor',
          organism: 'Homo sapiens',
        },
      },
    ];
    setUser([]);
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /pharmacodynamics/i }));

    // Ranked mechanism appears under its tier heading, phrased as
    // "<interaction> at <SYMBOL>".
    expect(screen.getByText(/primary mechanism/i)).toBeInTheDocument();
    expect(screen.getByText(/full agonist at MOR/i)).toBeInTheDocument();
    expect(screen.getByText(/mu opioid receptor/i)).toBeInTheDocument();
    expect(screen.getByText(/ki 2.4 nmol\/L/i)).toBeInTheDocument();
    // Unranked mechanism falls under "Other mechanism(s)".
    expect(screen.getByText(/other mechanism/i)).toBeInTheDocument();
    expect(screen.getByText(/antagonist at DOR/i)).toBeInTheDocument();
    // Contributors get an inline editor entry point.
    expect(
      screen.getByRole('button', { name: /edit mechanisms/i }),
    ).toBeInTheDocument();
  });

  it('renders mechanism citations as linked [n] markers like parameter values', async () => {
    vi.mocked(fetchDrugReferences).mockResolvedValue([
      {
        id: 3,
        drugId: 1,
        type: 'freetext',
        identifier: 'Smith 2020',
        metadata: null,
        createdBy: null,
        createdAt: new Date().toISOString(),
      } as unknown as Awaited<ReturnType<typeof fetchDrugReferences>>[number],
    ]);
    mockDrugState.receptorTargets = [
      {
        id: 12,
        drugId: 1,
        receptorTargetId: 7,
        interactionType: 'antagonist',
        tier: 'primary',
        affinity: null,
        potency: null,
        efficacy: null,
        ki: null,
        ic50: null,
        ec50: null,
        emax: null,
        selectivityRatio: null,
        referenceIds: [3],
        evidenceNote: null,
        target: {
          id: 7,
          slug: 'sert',
          symbol: 'SERT',
          name: 'Serotonin transporter',
          nameEn: 'Serotonin transporter',
          targetClass: 'transporter',
          organism: 'Homo sapiens',
        },
      },
    ];
    setUser([]);
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /pharmacodynamics/i }));

    // The citation renders as the shared ParameterBadges [n] anchor, not a
    // plain "#3" — a mechanism-only reference is numbered as a trailing entry.
    const link = await screen.findByRole('link', { name: /reference 1/i });
    expect(link).toHaveAttribute('href', '#param-ref-1');
  });

  it('numbers a parameter citation against the page-level ordering when supplied', async () => {
    // The same source is footnote [3] in the monograph prose and also backs
    // the plasma-protein-binding value. When the page hands its ordering down,
    // the sidebar must render [3] here too — not a divergent parameter-first
    // number — so a marker means the same bibliography entry everywhere on the
    // page. It must also skip its own reference fetch.
    // A reader who can't add source values, on a value with none yet: no
    // sources dialog to open, so the [n] marker is still how it cites.
    mockDrugState.indicatorRefs = { proteinBinding: [42] };
    setUser(['proteinBinding'], 'authenticated');
    renderSidebar(
      [
      {
        index: 3,
        row: {
          id: 42,
          drugId: 1,
          type: 'freetext',
          identifier: 'Paracetamol 1973',
          metadata: null,
          createdAt: new Date().toISOString(),
        } as unknown as OrderedReference['row'],
      },
      ],
      'pharmacokinetics',
    );

    const link = await screen.findByRole('link', { name: /reference 3/i });
    expect(link).toHaveAttribute('href', '#param-ref-3');
    expect(fetchDrugReferences).not.toHaveBeenCalled();
  });

  it('falls back to its own parameter-first numbering with no shared ordering', async () => {
    // Standalone (e.g. the drug-preview pane): with no page-level ordering the
    // sidebar self-fetches and numbers the first parameter citation as [1].
    mockDrugState.indicatorRefs = { proteinBinding: [42] };
    vi.mocked(fetchDrugReferences).mockResolvedValue([
      {
        id: 42,
        drugId: 1,
        type: 'freetext',
        identifier: 'Paracetamol 1973',
        metadata: null,
        createdAt: new Date().toISOString(),
      } as unknown as Awaited<ReturnType<typeof fetchDrugReferences>>[number],
    ]);
    setUser(['proteinBinding'], 'authenticated');
    openSection('pharmacokinetics');
    renderSidebar();

    const link = await screen.findByRole('link', { name: /reference 1/i });
    expect(link).toHaveAttribute('href', '#param-ref-1');
    expect(fetchDrugReferences).toHaveBeenCalledWith(1);
  });

  it('offers an "add mechanisms" button to contributors when none exist', () => {
    mockDrugState.receptorTargets = [];
    setUser([]);
    renderSidebar();

    // The pharmacodynamics box surfaces even with no mechanisms so a
    // contributor can add the first one.
    fireEvent.click(screen.getByRole('button', { name: /pharmacodynamics/i }));
    expect(screen.getByText(/no mechanisms recorded/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add mechanisms/i }),
    ).toBeInTheDocument();
  });

  it('keeps the metabolism and mechanism edit buttons hidden until hover or focus', () => {
    mockDrugState.metabolism = null;
    mockDrugState.receptorTargets = [];
    setUser([]);
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /metabolism/i }));
    const metabolismButton = screen.getByRole('button', {
      name: /add metabolism data/i,
    });
    expect(metabolismButton).toHaveClass('opacity-0');
    expect(metabolismButton).toHaveClass('group-hover/section:opacity-100');
    expect(metabolismButton).toHaveClass('focus-visible:opacity-100');

    fireEvent.click(screen.getByRole('button', { name: /pharmacodynamics/i }));
    const mechanismButton = screen.getByRole('button', {
      name: /add mechanisms/i,
    });
    expect(mechanismButton).toHaveClass('opacity-0');
    expect(mechanismButton).toHaveClass('group-hover/section:opacity-100');
    expect(mechanismButton).toHaveClass('focus-visible:opacity-100');
  });

  it('reveals the section actions on hover of the tab itself, and outright on touch', () => {
    mockDrugState.metabolism = null;
    setUser([]);
    renderSidebar(undefined, 'metabolism');

    // A tab has no section box around it, so the tab's root has to be the
    // hover group the section actions listen to — or they never show.
    expect(screen.getByTestId('drug-monograph-section-metabolism')).toHaveClass(
      'group/section',
    );
    const metabolismButton = screen.getByRole('button', {
      name: /add metabolism data/i,
    });
    expect(metabolismButton).toHaveClass('group-hover/section:opacity-100');
    // `hover-actions` shows the button outright where the device can't hover.
    expect(metabolismButton).toHaveClass('hover-actions');
  });

  it('hides the mechanism editor entry point from anonymous viewers', () => {
    mockDrugState.receptorTargets = [];
    setUser(null);
    renderSidebar();

    // No params + no mechanisms + cannot edit ⇒ no pharmacodynamics box.
    expect(
      screen.queryByRole('button', { name: /pharmacodynamics/i }),
    ).not.toBeInTheDocument();
  });

  it('shows method-derived reporting limits in the analytics & detection section', async () => {
    vi.mocked(fetchMethodLimitsForDrug).mockResolvedValue({
      methods: [
        {
          id: 42,
          code: '9001',
          name: 'Synthetic screening panel A',
          methodType: 'screening',
          matrices: ['blood'],
          lor: 0.5,
          mkk: 1,
          lod: 0.3,
          unit: 'ng/mL',
          measurementUncertainty: null,
        },
      ],
    });
    setUser([], 'admin');
    renderSidebar();

    fireEvent.click(
      screen.getByRole('button', { name: /analytics & detection/i }),
    );

    // The method code links to its detail page, and the lower limit of
    // reporting (Påvisn./lor) for this drug is surfaced as a derived row.
    // `mkk` and `lod` are deliberately not shown here — they belong to the
    // method detail page, and neither is a limit to read off a monograph.
    const methodLink = await screen.findByRole('link', { name: '9001' });
    expect(methodLink).toHaveAttribute('href', '/methods/42');
    // The figures are wrapped in UnitTooltip spans (so hovering shows the value
    // in other units), which splits the label text across several elements —
    // assert on the row's normalized text content rather than a single node.
    const rowText = (methodLink.closest('li')?.textContent ?? '').replace(
      /\s+/g,
      ' ',
    );
    expect(rowText).toContain('Påvisn. 0.5 ng/mL');
    // Neither the MKK figure (1 ng/mL) nor the Terskel one (0.3 ng/mL) may
    // appear, and above all neither may be relabelled as an LOD or an LOQ.
    expect(rowText).not.toContain('1 ng/mL');
    expect(rowText).not.toContain('0.3 ng/mL');
    expect(rowText).not.toMatch(/LOD|LOQ/);
  });

  it('omits the method-derived rows for viewers without method access', async () => {
    vi.mocked(fetchMethodLimitsForDrug).mockResolvedValue({
      methods: [
        {
          id: 42,
          code: '9001',
          name: 'Synthetic screening panel A',
          methodType: 'screening',
          matrices: ['blood'],
          lor: 0.5,
          mkk: 1,
          lod: 0.3,
          unit: 'ng/mL',
          measurementUncertainty: null,
        },
      ],
    });
    // A plain contributor is not in a granted group and is not admin, so
    // analytical-method figures must not be requested or shown.
    setUser([], 'contributor');
    renderSidebar();

    fireEvent.click(
      screen.getByRole('button', { name: /analytics & detection/i }),
    );

    expect(fetchMethodLimitsForDrug).not.toHaveBeenCalled();
    expect(screen.queryByTestId('method-derived-limits')).toBeNull();
  });

  it('links a missing metabolite to the new-monograph flow', () => {
    mockDrugState.metabolism = {
      routes: [],
      evidenceNote: null,
      precursors: [],
      metabolites: [
        {
          id: 1,
          parentDrugId: 1,
          metaboliteDrugId: 5,
          metaboliteName: 'Morphine-6-glucuronide',
          conversionFraction: null,
          activity: 'unknown',
          sortOrder: 0,
          evidenceNote: null,
          referenceIds: null,
          drug: {
            id: 5,
            slug: 'morphine-6-glucuronide',
            names: { en: 'Morphine-6-glucuronide' },
            pubchemCid: 5360621,
          },
        },
        {
          id: 2,
          parentDrugId: 1,
          metaboliteDrugId: null,
          metaboliteName: 'Normorphine',
          conversionFraction: null,
          activity: 'unknown',
          sortOrder: 1,
          evidenceNote: null,
          referenceIds: null,
          drug: null,
        },
      ],
    };
    setUser(['halfLife'], 'admin');
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /metabolism/i }));

    // The metabolite already in the database points at its monograph.
    const existing = screen.getByText('morphine-6-glucuronide').closest('a');
    expect(existing).toHaveAttribute('href', '/wiki/drug/5');

    // The missing one is still clickable and seeds the new-monograph
    // search with its name.
    const missing = screen.getByText('Normorphine').closest('a');
    expect(missing).toHaveAttribute(
      'href',
      '/wiki/new?type=drug_monograph&q=Normorphine',
    );
  });

  it('links a catalogued elimination route to its bio entity page', () => {
    mockDrugState.metabolism = {
      routes: [
        {
          id: 1,
          kind: 'enzyme',
          enzymeId: 7,
          enzyme: {
            id: 7,
            slug: 'cyp2c19',
            symbol: 'CYP2C19',
            name: 'Cytokrom P450 2C19',
            nameEn: 'Cytochrome P450 2C19',
            enzymeClass: null,
            rank: 'gene',
          },
          label: null,
          fraction: { min: null, median: 0.33, max: null },
          note: null,
          referenceIds: null,
          sortOrder: 0,
        },
        // Renal excretion carries no entity — it stays plain text.
        {
          id: 2,
          kind: 'renal_unchanged',
          enzymeId: null,
          enzyme: null,
          label: null,
          fraction: { min: null, median: 0.2, max: null },
          note: null,
          referenceIds: null,
          sortOrder: 1,
        },
      ],
      evidenceNote: null,
      metabolites: [],
      precursors: [],
    };
    setUser(['halfLife'], 'admin');
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /metabolism/i }));

    expect(screen.getByText('CYP2C19').closest('a')).toHaveAttribute(
      'href',
      '/wiki/entity/cyp2c19',
    );
    expect(screen.getByText(/renal/i).closest('a')).toBeNull();
  });

  it('offers contributors a metabolism editor even when no data exists', () => {
    mockDrugState.metabolism = null;
    setUser(['halfLife'], 'contributor');
    renderSidebar();

    // The metabolism box renders for contributors so they can start one.
    fireEvent.click(screen.getByRole('button', { name: /metabolism/i }));
    expect(
      screen.getByText(/no metabolism data recorded yet/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /add metabolism data/i }),
    );
    expect(
      screen.getByRole('heading', { name: /edit metabolism — paracetamol/i }),
    ).toBeInTheDocument();
  });

  it('hides the empty metabolism box from anonymous visitors', () => {
    mockDrugState.metabolism = null;
    setUser(null);
    renderSidebar();
    expect(
      screen.queryByTestId('parameter-group-metabolism'),
    ).toBeNull();
  });

  it('restores the last expanded section from localStorage', () => {
    localStorage.setItem(
      SIDEBAR_SECTION_STORAGE_KEY,
      JSON.stringify('pharmacokinetics'),
    );
    setUser(['halfLife']);
    renderSidebar();
    expect(screen.getByText(VD_LABEL)).toBeInTheDocument();
  });

  it('offers no favorite star on parameter rows', () => {
    setUser(['halfLife']);
    renderSidebar(undefined, 'pharmacokinetics');
    expect(screen.getByText(HALF_LIFE_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
  });


  it('keeps per-parameter action buttons hidden until hover or focus', () => {
    setUser([]);
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /pharmacokinetics/i }));
    const actions = screen.getByTestId('parameter-actions-halfLife');
    expect(actions).toHaveClass('opacity-0');
    expect(actions).toHaveClass('group-hover:opacity-100');
    expect(actions).toHaveClass('focus-within:opacity-100');
    // …but a coarse pointer never hovers, so the row opts into the
    // `(hover: none)` override in index.css that reveals it outright.
    expect(actions).toHaveClass('hover-actions');
  });

  it('lets editors flag a parameter for the agent queue', async () => {
    setUser(['halfLife'], 'editor');
    openSection('pharmacokinetics');
    renderSidebar();

    fireEvent.click(
      within(screen.getByTestId('parameter-actions-halfLife')).getByRole(
        'button',
        { name: /flag for agent/i },
      ),
    );
    expect(
      screen.getByRole('heading', { name: /flag for kinetix-agent/i }),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByPlaceholderText(/optional hint for the agent/i),
      { target: { value: 'Prioritize recent overdose studies' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /^flag$/i }));

    await waitFor(() =>
      expect(createPriorityFlag).toHaveBeenCalledWith({
        drugId: 1,
        parameter: 'halfLife',
        note: 'Prioritize recent overdose studies',
      }),
    );
  });

  it('lets editors flag metabolism, which has no parameter row to flag', async () => {
    // The gap this closes: metabolism and pharmacodynamics are the two
    // monograph sections with no `drug_parameters` id, so before coverage
    // areas existed there was no control anywhere that could queue either for
    // an agent.
    mockDrugState.metabolism = null;
    setUser([], 'editor');
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /^metabolism$/i }));
    fireEvent.click(
      screen.getByRole('button', { name: /flag metabolism for agent/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^flag$/i }));

    await waitFor(() =>
      expect(createPriorityFlag).toHaveBeenCalledWith({
        drugId: 1,
        parameter: 'metabolism',
        note: undefined,
      }),
    );
  });

  it('lets editors flag pharmacodynamics', async () => {
    mockDrugState.receptorTargets = [];
    setUser([], 'editor');
    renderSidebar();

    fireEvent.click(
      screen.getByRole('button', { name: /^pharmacodynamics$/i }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /flag pharmacodynamics for agent/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^flag$/i }));

    await waitFor(() =>
      expect(createPriorityFlag).toHaveBeenCalledWith({
        drugId: 1,
        parameter: 'pharmacodynamics',
        note: undefined,
      }),
    );
  });

  it('shows and clears an active coverage-area flag', async () => {
    vi.mocked(fetchPriorityFlags).mockResolvedValue({
      flags: [
        {
          id: 77,
          drugId: 1,
          parameter: 'metabolism',
          status: 'active',
          note: 'Mangler CYP-ruter',
          flaggedBy: 1,
          resolvedBy: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
    });
    mockDrugState.metabolism = null;
    setUser([], 'editor');
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /^metabolism$/i }));
    expect(
      await screen.findByText(/flagged for kinetix-agent/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /clear metabolism flag/i }),
    );

    await waitFor(() => expect(cancelPriorityFlag).toHaveBeenCalledWith(77));
  });

  it('shows and clears active parameter flags for editors', async () => {
    vi.mocked(fetchPriorityFlags).mockResolvedValue({
      flags: [
        {
          id: 42,
          drugId: 1,
          parameter: 'halfLife',
          status: 'active',
          note: 'Check latest literature',
          flaggedBy: 1,
          resolvedBy: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
    });
    setUser(['halfLife'], 'editor');
    openSection('pharmacokinetics');
    renderSidebar();

    expect(
      await screen.findByText(/flagged for kinetix-agent/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear flag/i }));

    await waitFor(() => expect(cancelPriorityFlag).toHaveBeenCalledWith(42));
  });

  it('loads active parameter flags after editor auth becomes available', async () => {
    vi.mocked(fetchPriorityFlags).mockResolvedValue({
      flags: [
        {
          id: 42,
          drugId: 1,
          parameter: 'halfLife',
          status: 'active',
          note: 'Check latest literature',
          flaggedBy: 1,
          resolvedBy: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
    });
    setUser(null);
    openSection('pharmacokinetics');
    renderSidebar();

    expect(fetchPriorityFlags).not.toHaveBeenCalled();
    setUser(['halfLife'], 'editor');

    await waitFor(() =>
      expect(fetchPriorityFlags).toHaveBeenCalledWith({
        drugId: 1,
        status: 'active',
      }),
    );
    expect(
      await screen.findByText(/flagged for kinetix-agent/i),
    ).toBeInTheDocument();
  });

  it('ignores stale priority flag responses after the displayed drug changes', async () => {
    const first = deferred<{
      flags: Awaited<ReturnType<typeof fetchPriorityFlags>>['flags'];
    }>();
    const second = deferred<{
      flags: Awaited<ReturnType<typeof fetchPriorityFlags>>['flags'];
    }>();
    vi.mocked(fetchPriorityFlags)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    setUser(['halfLife'], 'editor');
    const { rerender } = renderSidebar();

    mockDrugState.id = 2;
    mockDrugState.pubchemCid = 200;
    rerender(
      <MemoryRouter>
        <DrugMonographSidebar drugCid={mockDrugState.pubchemCid} />
      </MemoryRouter>,
    );

    second.resolve({ flags: [] });
    await waitFor(() =>
      expect(fetchPriorityFlags).toHaveBeenLastCalledWith({
        drugId: 2,
        status: 'active',
      }),
    );

    first.resolve({
      flags: [
        {
          id: 42,
          drugId: 1,
          parameter: 'halfLife',
          status: 'active',
          note: 'Stale result',
          flaggedBy: 1,
          resolvedBy: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
    });

    await waitFor(() =>
      expect(screen.queryByText(/flagged for kinetix-agent/i)).toBeNull(),
    );
  });

  it('clears active parameter flags while loading a different drug', async () => {
    const second = deferred<{
      flags: Awaited<ReturnType<typeof fetchPriorityFlags>>['flags'];
    }>();
    vi.mocked(fetchPriorityFlags)
      .mockResolvedValueOnce({
        flags: [
          {
            id: 42,
            drugId: 1,
            parameter: 'halfLife',
            status: 'active',
            note: 'Current result',
            flaggedBy: 1,
            resolvedBy: null,
            createdAt: new Date().toISOString(),
            resolvedAt: null,
          },
        ],
      })
      .mockReturnValueOnce(second.promise);

    setUser(['halfLife'], 'editor');
    openSection('pharmacokinetics');
    const { rerender } = renderSidebar();
    expect(
      await screen.findByText(/flagged for kinetix-agent/i),
    ).toBeInTheDocument();

    mockDrugState.id = 2;
    mockDrugState.pubchemCid = 200;
    rerender(
      <MemoryRouter>
        <DrugMonographSidebar drugCid={mockDrugState.pubchemCid} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/flagged for kinetix-agent/i)).toBeNull(),
    );
    expect(fetchPriorityFlags).toHaveBeenLastCalledWith({
      drugId: 2,
      status: 'active',
    });
  });

  // The source-value affordance is an action, not a permanently expanded
  // block: it lives in the parameter's hover row and opens the forest plot
  // in a dialog. Nothing about it renders inline any more.
  it('offers source values as a hover action rather than an inline expander', async () => {
    mockDrugState.parameterSummaries = {
      halfLife: {
        parameter: 'halfLife',
        unit: 'h',
        representative: 2.2,
        iqrLow: 1.8,
        iqrHigh: 2.8,
        entryCount: 3,
        pooledCount: 3,
        points: [],
      },
    };
    setUser(['halfLife']);
    openSection('pharmacokinetics');
    renderSidebar();

    // No always-visible summary line under the value.
    expect(screen.queryByText(/add source values/i)).toBeNull();

    const actions = screen.getByTestId('parameter-actions-halfLife');
    const openSources = within(actions).getByRole('button', {
      name: /3 source values/i,
    });
    fireEvent.click(openSources);

    expect(
      await screen.findByRole('heading', { name: /source values/i }),
    ).toBeInTheDocument();
    // The dialog leads with the graph of the pooled sources.
    expect(screen.getByTestId('parameter-forest-plot')).toBeInTheDocument();
  });

  // A source-value parameter cites through its source values: the figure
  // itself opens the sources dialog, and no `[n]` markers trail it.
  it('opens the sources dialog from the value instead of showing [n] markers', async () => {
    mockDrugState.indicatorRefs = { halfLife: [42] };
    vi.mocked(fetchDrugReferences).mockResolvedValue([
      {
        id: 42,
        drugId: 1,
        type: 'freetext',
        identifier: 'Paracetamol 1973',
        metadata: null,
        createdAt: new Date().toISOString(),
      } as unknown as Awaited<ReturnType<typeof fetchDrugReferences>>[number],
    ]);
    mockDrugState.parameterSummaries = {
      halfLife: {
        parameter: 'halfLife',
        unit: 'h',
        representative: 2.2,
        iqrLow: 1.8,
        iqrHigh: 2.8,
        entryCount: 3,
        pooledCount: 3,
        points: [],
      },
    };
    setUser(['halfLife']);
    openSection('pharmacokinetics');
    renderSidebar();

    const value = await screen.findByTestId('parameter-value-sources-halfLife');
    await waitFor(() => expect(fetchDrugReferences).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /reference 1/i })).toBeNull();

    fireEvent.click(value);
    expect(
      await screen.findByRole('heading', { name: /source values/i }),
    ).toBeInTheDocument();
  });

  it('offers the sources action to contributors before any entry exists', () => {
    setUser(['halfLife'], 'contributor');
    openSection('pharmacokinetics');
    renderSidebar();
    const actions = screen.getByTestId('parameter-actions-halfLife');
    expect(
      within(actions).getByRole('button', { name: /add source values/i }),
    ).toBeInTheDocument();
  });

  // A summarizable parameter has no authored value to edit — the number shown
  // is the aggregate of its source values. The direct editor used to stay
  // available until the first entry arrived, which is precisely the window in
  // which a typed-in value landed outside the source-value system. It is gone
  // now whether or not the pool has anything in it.
  it('offers no direct editor for a source-value-backed parameter', () => {
    setUser(['halfLife'], 'editor');
    openSection('pharmacokinetics');
    renderSidebar();
    const actions = screen.getByTestId('parameter-actions-halfLife');
    expect(
      within(actions).queryByRole('button', { name: /edit/i }),
    ).toBeNull();
    // The source-value path is offered in its place.
    expect(
      within(actions).getByRole('button', { name: /add source values/i }),
    ).toBeInTheDocument();
  });

  it('keeps the direct editor for a parameter that is not pooled', () => {
    // Analyte stability is matrix-specific with no valid cross-matrix pool, so
    // it is not source-value-backed and stays hand-authored.
    setUser(['analyteStability'], 'editor');
    openSection('analytics_detection');
    renderSidebar();
    const actions = screen.getByTestId('parameter-actions-analyteStability');
    expect(
      within(actions).getByRole('button', { name: /edit/i }),
    ).toBeInTheDocument();
  });

  // Per the spec ("All fav parameters are always shown by default")
  // favorited rows render even when the value is missing — they show
  // an em dash. The "no favorites apply" hint only fires when none
  // of the favorited ids match a registered parameter at all (e.g.
  // a future PR removes an id from the registry); not exercised here
  // because every #302 P3 id is still registered.

  it('links "Open in simulator" to the unambiguous drug: key for a CID-less drug (#1256)', () => {
    // A bare numeric key here would be indistinguishable from some OTHER
    // drug's PubChem CID. The link must use buildDrugComponentId's
    // `drug:<id>` spelling, not `pubchemCid ?? id`.
    setUser(['halfLife']);
    mockDrugState.id = 803;
    mockDrugState.pubchemCid = null as unknown as number;
    render(
      <MemoryRouter>
        <DrugMonographSidebar drugCid={803} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Open in Simulator' });
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(url.searchParams.get('drugId')).toBe('drug:803');
  });
});
