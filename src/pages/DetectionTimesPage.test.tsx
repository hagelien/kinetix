import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { DetectionTimesPage } from './DetectionTimesPage';
import { useAuthStore } from '@/stores/authStore';
import { useDrugStore } from '@/stores/drugStore';
import { resetRefsDetectionCache } from '@/lib/refsDetectionApi';
import { SYNTHETIC_REFS_PAYLOAD } from '@/lib/__tests__/fixtures/refsSyntheticGuideline';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';

const fetchMock = vi.fn();

/** Sign in as an admin, whose source-value writes apply directly (no review queue). */
function signInAsAdmin() {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'admin',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

/**
 * Sign in as a member of the Rettstoks group holding nothing else — the
 * audience the guideline section exists for, and the one that proves the gate
 * opens on group membership rather than on role.
 */
function signInAsRettstoksMember() {
  useAuthStore.setState({
    user: {
      id: 42,
      email: 'r@b.com',
      username: 'rita',
      role: 'authenticated',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
      groups: [{ id: 1, slug: 'rettstoks', name: 'Rettstoks' }],
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

/**
 * What the gated route answers a reader who may read the guideline — a
 * synthetic table, since the real one is restricted and lives only in the DB.
 */
const REFS_PAYLOAD = SYNTHETIC_REFS_PAYLOAD;

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location">{location.search}</span>
      {/* Navigating away is the router's job, not the page's — this stands in
          for the browser's back/forward or a pasted link. */}
      <button type="button" onClick={() => navigate('/detection-times?drug=8')}>
        goto-oxazepam
      </button>
    </>
  );
}

function renderPage(entry = '/detection-times') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<span data-testid="landing" />} />
        <Route
          path="/detection-times"
          element={
            <>
              <DetectionTimesPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function summary(over: Partial<ParameterSummary>): ParameterSummary {
  return {
    representative: null,
    iqrLow: null,
    iqrHigh: null,
    min: null,
    max: null,
    unit: 'h',
    entryCount: 0,
    pooledCount: 0,
    contributingCitationIds: [],
    byMatrix: [],
    points: [],
    normalizedToWholeBlood: false,
    ...over,
  };
}

const DIAZEPAM = {
  id: 7,
  slug: 'diazepam',
  names: { nb: 'Diazepam', en: 'Diazepam' },
  nameShort: null,
  aliases: null,
  pubchemCid: 3016,
  molecularWeight: 284.7,
  bloodPlasmaRatio: null,
  parameterSummaries: {
    bloodDetectionWindow: summary({
      min: 12,
      max: 48,
      representative: 24,
      entryCount: 3,
      pooledCount: 3,
      contributingCitationIds: [1, 2],
    }),
    urineDetectionWindow: summary({
      min: 96,
      max: 336,
      representative: 168,
      entryCount: 5,
      pooledCount: 5,
      contributingCitationIds: [1, 2, 3],
    }),
  },
  metabolism: {
    routes: [],
    evidenceNote: null,
    precursors: [],
    metabolites: [
      {
        id: 91,
        parentDrugId: 7,
        metaboliteDrugId: 8,
        metaboliteName: 'Oxazepam',
        conversionFraction: null,
        activity: 'active',
        sortOrder: 0,
        evidenceNote: null,
        referenceIds: null,
        drug: {
          id: 8,
          slug: 'oxazepam',
          names: { nb: 'Oxazepam', en: 'Oxazepam' },
          pubchemCid: 4616,
        },
      },
    ],
  },
};

const OXAZEPAM = {
  id: 8,
  slug: 'oxazepam',
  names: { nb: 'Oxazepam', en: 'Oxazepam' },
  nameShort: null,
  aliases: null,
  pubchemCid: 4616,
  molecularWeight: 286.7,
  bloodPlasmaRatio: null,
  parameterSummaries: {
    urineDetectionWindow: summary({
      min: 120,
      max: 168,
      representative: 150,
      entryCount: 2,
      pooledCount: 2,
      contributingCitationIds: [4],
    }),
  },
  metabolism: null,
};

/**
 * What `/api/drugs?ids=` returns: the same drug with its `drug_parameters`
 * values merged in — the recomputed cache of the source values, marked
 * `derivedFromEntries`. No `parameterSummaries` on the list path.
 */
const OXAZEPAM_LIST_ROW = {
  id: 8,
  slug: 'oxazepam',
  names: { nb: 'Oxazepam', en: 'Oxazepam' },
  nameShort: null,
  aliases: null,
  pubchemCid: 4616,
  molecularWeight: 286.7,
  urineDetectionWindow: {
    min: 120,
    max: 168,
    median: 150,
    unit: 'h',
    note: 'Aggregated from 2 source entries',
    derivedFromEntries: true,
  },
};

/** One cited source value behind diazepam's urine window. */
const ENTRY_ROW = {
  id: 55,
  parameter: 'urineDetectionWindow',
  low: 96,
  high: 336,
  median: null,
  qualifier: null,
  unit: 'h',
  matrix: null,
  scenario: null,
  n: null,
  comments: null,
  origin: 'manual',
  citationId: 1,
  citation: {
    id: 1,
    type: 'doi',
    identifier: '10.1/x',
    metadata: { title: 'Urinary excretion study' },
  },
};

/** Route each request by URL so ordering between the parallel calls is irrelevant. */
function routeFetch(overrides: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url in overrides) {
      return { ok: true, json: async () => overrides[url] };
    }
    if (url.includes('/api/refs-detection-times')) {
      return { ok: true, json: async () => REFS_PAYLOAD };
    }
    if (url.includes('view=search')) {
      return {
        ok: true,
        json: async () => ({
          drugs: [
            {
              id: 7,
              slug: 'diazepam',
              names: { nb: 'Diazepam', en: 'Diazepam' },
              nameShort: null,
              aliases: null,
              pubchemCid: 3016,
            },
          ],
        }),
      };
    }
    if (url.includes('ids=')) {
      return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
    }
    if (url.includes('/api/drugs?id=7')) {
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    }
    if (url.includes('/api/drugs?id=8')) {
      return { ok: true, json: async () => ({ drug: OXAZEPAM }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

describe('DetectionTimesPage', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // The guideline payload is cached per identity for the module's lifetime;
    // without this, the next test inherits the previous reader's copy.
    resetRefsDetectionCache();
    useDrugStore.setState({ pendingColumnPreset: null, tableView: 'sidebar' });
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    await i18n.changeLanguage('nb');
  });

  it('asks for a component before it shows anything', () => {
    routeFetch();
    renderPage();

    expect(
      screen.getByText('Search for a component to see its detection times.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('detection-matrix-urine')).toBeNull();
  });

  it('shows every matrix for the substance in the URL, empty ones included', async () => {
    routeFetch();
    renderPage('/detection-times?drug=7');

    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });

    // Blood: 12–48 h pools to a "last few days" band, shown in days because
    // the window outgrew a couple of days.
    const blood = screen.getByTestId('detection-matrix-blood');
    expect(within(blood).getByTestId('detection-band-blood').textContent).toBe(
      'Last few days',
    );
    expect(within(blood).getByTestId('detection-span-blood').textContent).toBe(
      '0.5–2 days',
    );

    const urine = screen.getByTestId('detection-matrix-urine');
    expect(within(urine).getByTestId('detection-band-urine').textContent).toBe(
      'Last couple of weeks',
    );
    expect(within(urine).getByTestId('detection-span-urine').textContent).toBe(
      '0.6–2 weeks',
    );

    // Oral fluid has no source values. The matrix still gets a card — an
    // absent column would read as "not applicable" rather than "not recorded".
    const oralFluid = screen.getByTestId('detection-matrix-oralFluid');
    expect(within(oralFluid).getByText('No source values')).toBeTruthy();
    expect(screen.queryByTestId('detection-band-oralFluid')).toBeNull();
  });

  it('attributes every window to the source values behind it', async () => {
    routeFetch();
    renderPage('/detection-times?drug=7');

    const urine = await screen.findByTestId('detection-matrix-urine');
    // The count is the entry count, and the citation line counts distinct papers.
    expect(within(urine).getByText('5 source values')).toBeTruthy();
    expect(within(urine).getByText('3 sources behind this window')).toBeTruthy();
  });

  it('opens the source values behind a matrix without leaving the page', async () => {
    routeFetch();
    renderPage('/detection-times?drug=7');

    const urine = await screen.findByTestId('detection-matrix-urine');
    fireEvent.click(within(urine).getByText('5 source values'));

    expect(
      await screen.findByText('Urine detection window — source values'),
    ).toBeTruthy();
  });

  it('resolves each metabolite so the parent page answers for the whole chain', async () => {
    routeFetch();
    renderPage('/detection-times?drug=7');

    const row = await screen.findByTestId('detection-metabolite-row');
    expect(within(row).getByRole('button', { name: 'Oxazepam' })).toBeTruthy();
    // Oxazepam's own urine window (120–168 h) reads as "last week"; blood and
    // oral fluid have nothing recorded.
    await waitFor(() => expect(within(row).getByText('Last week')).toBeTruthy());
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('reads every metabolite in one request rather than one per link', async () => {
    routeFetch();
    renderPage('/detection-times?drug=7');

    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('ids=8')),
      ).toBe(true),
    );
    // The substance the reader asked for is fetched on its own; the metabolites
    // arrive together, never one single-drug request per link.
    const singleReads = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => /[?&]id=\d/.test(url));
    expect(singleReads).toEqual(['/api/drugs?id=7']);
  });

  it('does not band a metabolite value that is not derived from source values', async () => {
    // A grandfathered legacy value predates the entry store. Elsewhere it is
    // shown with its provenance visible; in this table there is no room to say
    // so, and an unattributable band is worse than no band.
    routeFetch({
      '/api/drugs?ids=8&limit=1': {
        drugs: [
          {
            ...OXAZEPAM_LIST_ROW,
            urineDetectionWindow: {
              min: 120,
              max: 168,
              unit: 'h',
              note: 'legacy import',
            },
          },
        ],
      },
    });
    renderPage('/detection-times?drug=7');

    const row = await screen.findByTestId('detection-metabolite-row');
    expect(within(row).getByRole('button', { name: 'Oxazepam' })).toBeTruthy();
    await waitFor(() => expect(within(row).getAllByText('—')).toHaveLength(3));
  });

  it('shows the parent without waiting for its metabolites', async () => {
    let releaseMetabolites = () => {};
    const held = new Promise<void>((resolve) => {
      releaseMetabolites = resolve;
    });
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('ids=')) {
        await held;
        return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
      }
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    });
    renderPage('/detection-times?drug=7');

    // The substance the reader asked for is on screen — with its bands — while
    // the metabolite lookup is still outstanding.
    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
    expect(screen.getByTestId('detection-band-urine').textContent).toBe(
      'Last couple of weeks',
    );
    const row = screen.getByTestId('detection-metabolite-row');
    expect(within(row).getAllByText('—')).toHaveLength(3);

    releaseMetabolites();
    await waitFor(() => expect(within(row).getByText('Last week')).toBeTruthy());
  });

  it('keeps the looked-up substance in the URL so it can be shared', async () => {
    routeFetch();
    renderPage();

    fireEvent.change(screen.getByLabelText('Search for a component'), {
      target: { value: 'diaz' },
    });
    fireEvent.click(await screen.findByText('diazepam'));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('?drug=7'),
    );
    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });

    // Selecting a metabolite navigates the same way, so back/forward work.
    fireEvent.click(await screen.findByRole('button', { name: 'Oxazepam' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('?drug=8'),
    );
    expect(
      await screen.findByRole('heading', { name: 'Oxazepam', level: 2 }),
    ).toBeTruthy();
  });

  it('keeps the sources dialog open while the write it made is refreshing', async () => {
    // Writing several readings from one paper is the module's whole editing
    // loop. Each save asks the page to reload the pooled aggregate; if that
    // reload blanks the page, the dialog goes with it and the editor reopens it
    // per reading.
    signInAsAdmin();
    vi.stubGlobal('confirm', vi.fn(() => true));

    let releaseReload = () => {};
    const heldReload = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let drugReads = 0;

    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/parameter-entries')) {
        if (init?.method === 'DELETE') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ items: [ENTRY_ROW] }) };
      }
      if (url.includes('ids=')) {
        return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
      }
      // The sources dialog's discussion thread — not a drug read.
      if (url.includes('/api/drug-discussions')) {
        return { ok: true, json: async () => ({ discussions: [] }) };
      }
      // The reload triggered by the delete is held open, so the assertions
      // below run in exactly the window that used to unmount the dialog.
      drugReads += 1;
      if (drugReads > 1) await heldReload;
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    });

    renderPage('/detection-times?drug=7');

    const urine = await screen.findByTestId('detection-matrix-urine');
    fireEvent.click(within(urine).getByText('5 source values'));
    const dialogTitle = await screen.findByText(
      'Urine detection window — source values',
    );
    fireEvent.click(await screen.findByText('Remove'));

    await waitFor(() => expect(drugReads).toBe(2));
    expect(dialogTitle).toBeInTheDocument();
    // …and the values behind it stay put rather than flashing a loading state.
    expect(screen.getByTestId('detection-band-urine')).toBeTruthy();

    releaseReload();
    await waitFor(() => expect(screen.getByTestId('detection-band-urine')).toBeTruthy());
  });

  it('ignores a write that settles after the reader moved to another substance', async () => {
    // The editor's callback belongs to the substance that was on screen when
    // the dialog opened, and `reload()` fires it from the write's continuation
    // even after the dialog is unmounted. Reloading then would claim the newest
    // request token and paint the old substance under the new URL.
    signInAsAdmin();
    vi.stubGlobal('confirm', vi.fn(() => true));

    let releaseDelete = () => {};
    const heldDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/parameter-entries')) {
        if (init?.method === 'DELETE') {
          await heldDelete;
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ items: [ENTRY_ROW] }) };
      }
      if (url.includes('ids=')) {
        return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
      }
      if (url.includes('/api/drugs?id=8')) {
        return { ok: true, json: async () => ({ drug: OXAZEPAM }) };
      }
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    });

    renderPage('/detection-times?drug=7');

    const urine = await screen.findByTestId('detection-matrix-urine');
    fireEvent.click(within(urine).getByText('5 source values'));
    await screen.findByText('Urine detection window — source values');
    fireEvent.click(await screen.findByText('Remove'));

    // The reader moves on while the delete is still in flight.
    fireEvent.click(screen.getByText('goto-oxazepam'));
    await screen.findByRole('heading', { name: 'Oxazepam', level: 2 });
    const readsBefore = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/drugs?id=7'),
    ).length;

    releaseDelete();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Still Oxazepam, and diazepam was never re-read on its behalf.
    expect(screen.getByRole('heading', { name: 'Oxazepam', level: 2 })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('?drug=8');
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/api/drugs?id=7'),
      ).length,
    ).toBe(readsBefore);
  });

  it('translates the substance in place instead of fetching it again', async () => {
    // `t` is rebound on every language change. When the fetch callback depended
    // on it, a language toggle re-ran the selection effect: the page cleared and
    // refetched, and a transient failure then threw away data that only needed
    // translating.
    routeFetch();
    renderPage('/detection-times?drug=7');

    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
    await waitFor(() =>
      expect(screen.getByTestId('detection-band-urine').textContent).toBe(
        'Last couple of weeks',
      ),
    );
    const callsBefore = fetchMock.mock.calls.length;

    await i18n.changeLanguage('nb');

    // Same data, new language, no request and no loading flash.
    await waitFor(() =>
      expect(screen.getByTestId('detection-band-urine').textContent).toBe(
        'Siste par ukene',
      ),
    );
    expect(screen.getByRole('heading', { name: 'Diazepam', level: 2 })).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('says the substance has nothing recorded rather than showing empty cards alone', async () => {
    routeFetch({
      '/api/drugs?id=7': {
        drug: { ...DIAZEPAM, parameterSummaries: {}, metabolism: null },
      },
    });
    renderPage('/detection-times?drug=7');

    expect(
      await screen.findByText(
        'No detection times are recorded for this component yet.',
      ),
    ).toBeTruthy();
  });

  it('surfaces a failed lookup instead of an empty page', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    renderPage('/detection-times?drug=7');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the detection times. Try again.',
    );
  });

  it('offers a way to actually try again after a failed lookup', async () => {
    // Re-picking the same substance writes the same `?drug=`, which moves no
    // selection and starts no request, and the Clear button lives inside the
    // block that never mounted — so without this the error was a dead end that
    // only a page reload escaped.
    let failNext = true;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('ids=')) {
        return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
      }
      if (failNext) {
        failNext = false;
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    });
    renderPage('/detection-times?drug=7');

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { name: 'Diazepam', level: 2 }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries when the reader picks the substance already in the URL', async () => {
    let failNext = true;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('view=search')) {
        return {
          ok: true,
          json: async () => ({
            drugs: [
              {
                id: 7,
                slug: 'diazepam',
                names: { nb: 'Diazepam', en: 'Diazepam' },
                nameShort: null,
                aliases: null,
                pubchemCid: 3016,
              },
            ],
          }),
        };
      }
      if (url.includes('ids=')) {
        return { ok: true, json: async () => ({ drugs: [OXAZEPAM_LIST_ROW] }) };
      }
      if (failNext) {
        failNext = false;
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
    });
    renderPage('/detection-times?drug=7');

    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Search for a component'), {
      target: { value: 'diaz' },
    });
    fireEvent.click(await screen.findByText('diazepam'));

    expect(
      await screen.findByRole('heading', { name: 'Diazepam', level: 2 }),
    ).toBeTruthy();
  });

  describe('Rettstoks guideline section', () => {
    it('is not there at all for a reader outside the group', async () => {
      // Not empty, not locked — absent. A visible-but-empty section would tell
      // a reader outside the section that a different answer exists and that
      // Kinetix is not showing it to them.
      routeFetch();
      renderPage('/detection-times?drug=7');

      await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
      expect(screen.queryByTestId('refs-detection-section')).toBeNull();
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes('/api/refs-detection-times'),
        ),
      ).toBe(false);
    });

    it("shows a member REFS's own band, separately from the pooled windows", async () => {
      signInAsRettstoksMember();
      routeFetch();
      renderPage('/detection-times?drug=7');

      await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
      const section = await screen.findByTestId('refs-detection-section');

      // The (synthetic) guideline's row for diazepam.
      const row = within(section).getByTestId('refs-row-diazepam');
      expect(within(row).getByText('Last week')).toBeTruthy();
      expect(within(row).getByText(/Metabolites:/)).toBeTruthy();

      // Which document it came from, on the same screen as the band.
      expect(
        within(section).getByText(/document ID SYNTH-0001, version 1/),
      ).toBeTruthy();

      // And the pooled cards are now labelled as the other kind of answer,
      // so the two are not read as one.
      expect(
        screen.getByText('Pooled literature (available to everyone)'),
      ).toBeTruthy();
      expect(screen.getByTestId('detection-matrix-urine')).toBeTruthy();
    });

    it('says so when the guideline does not name the substance', async () => {
      signInAsRettstoksMember();
      routeFetch({
        '/api/drugs?id=7': {
          drug: { ...DIAZEPAM, names: { nb: 'Paracetamol', en: 'Paracetamol' } },
        },
      });
      renderPage('/detection-times?drug=7');

      const notice = await screen.findByTestId('refs-detection-no-match');
      expect(notice.textContent).toContain('Paracetamol');
    });

    it('opens the whole guideline table on request', async () => {
      signInAsRettstoksMember();
      routeFetch();
      renderPage('/detection-times');

      const toggle = await screen.findByRole('button', {
        name: /Show the whole table/,
      });
      fireEvent.click(toggle);

      // A row nothing on this page selected — the table stands on its own.
      expect(await screen.findByTestId('refs-table-row-thc')).toBeTruthy();
      expect(screen.getByText('Use the curves')).toBeTruthy();
    });
  });

  describe('the link to every substance', () => {
    it('opens the register full, on the detection-time axis alone', async () => {
      routeFetch();
      renderPage('/detection-times?drug=7');

      fireEvent.click(screen.getByTestId('detection-all-substances'));

      await screen.findByTestId('landing');
      const state = useDrugStore.getState();
      expect(state.tableView).toBe('full');
      expect(state.pendingColumnPreset).toEqual([
        'name',
        'bloodDetectionWindow',
        'oralFluidDetectionWindow',
        'urineDetectionWindow',
      ]);
    });

    it("adds REFS's own column for a member", async () => {
      signInAsRettstoksMember();
      routeFetch();
      renderPage('/detection-times?drug=7');

      fireEvent.click(screen.getByTestId('detection-all-substances'));

      await screen.findByTestId('landing');
      expect(useDrugStore.getState().pendingColumnPreset).toContain(
        'refsUrineDetection',
      );
    });
  });

  it('keeps the parent visible when the metabolite lookup fails', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('ids=')) throw new Error('network down');
      if (url.includes('/api/drugs?id=7')) {
        return { ok: true, json: async () => ({ drug: DIAZEPAM }) };
      }
      return { ok: true, json: async () => ({ drugs: [] }) };
    });
    renderPage('/detection-times?drug=7');

    await screen.findByRole('heading', { name: 'Diazepam', level: 2 });
    const row = await screen.findByTestId('detection-metabolite-row');
    // The metabolite is still named — only its bands are missing.
    expect(within(row).getByRole('button', { name: 'Oxazepam' })).toBeTruthy();
    expect(within(row).getAllByText('—')).toHaveLength(3);
    expect(screen.getByTestId('detection-band-urine')).toBeTruthy();
  });
});
