import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { ReferencesPage } from './ReferencesPage';

const fetchMock = vi.fn();

/** Surfaces the router's location and a way to walk its history stack —
 *  MemoryRouter keeps its own stack, so window.history.back() would not move
 *  it. */
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location">{location.search}</span>
      <button type="button" onClick={() => navigate(-1)}>
        router-back
      </button>
    </>
  );
}

function renderPage(entry = '/references') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/references"
          element={
            <>
              <ReferencesPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function citation(id: number, title: string, year?: number) {
  return {
    id,
    drugId: null,
    type: 'doi',
    identifier: `10.1/${id}`,
    metadata: { title, authors: ['Doe J'], ...(year ? { year } : {}) },
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

const basePage = {
  buckets: [
    { key: 'drug-7', label: 'diazepam', count: 1 },
    { key: 'wiki-42', label: 'Half-life', count: 1 },
  ],
  groupBy: 'drug' as const,
  bucket: null,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  totalReferences: 2,
  matchedReferences: 2,
  totalRows: 2,
  rangeStart: 1,
  rangeEnd: 2,
  groups: [
    {
      kind: 'drug' as const,
      key: 'drug-7',
      id: 7,
      slug: 'diazepam',
      names: { nb: 'Diazepam', en: 'Diazepam' },
      href: '/wiki/drug/7',
      totalReferences: 1,
      references: [citation(1, 'Diazepam PK study', 2019)],
    },
    {
      kind: 'wiki' as const,
      key: 'wiki-42',
      id: 42,
      slug: 'half-life',
      title: 'Half-life',
      pageType: 'topic',
      href: '/wiki/half-life',
      totalReferences: 1,
      references: [citation(2, 'Elimination kinetics', 2021)],
    },
  ],
};

/** Every fetch call's URL, so tests can assert what the server was asked. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function respondWith(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

describe('ReferencesPage', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('nb');
  });

  it('renders the page of groups the server returned', async () => {
    respondWith(basePage);

    renderPage();

    expect(await screen.findByText('Drug monographs')).toBeTruthy();
    expect(screen.getByText('Wiki pages')).toBeTruthy();

    const drugLink = screen.getByRole('link', { name: /^diazepam$/i });
    expect(drugLink).toHaveAttribute('href', '/wiki/drug/7');
    expect(screen.getByText('Diazepam PK study')).toBeTruthy();

    const wikiLink = screen.getByRole('link', { name: 'Half-life' });
    expect(wikiLink).toHaveAttribute('href', '/wiki/half-life');

    const refLink = screen.getByRole('link', { name: 'Elimination kinetics' });
    expect(refLink).toHaveAttribute('href', '/references/2');

    expect(screen.getByText('Showing 1–2 of 2')).toBeTruthy();
  });

  it('sends the typed query to the server and renders what comes back', async () => {
    respondWith(basePage);
    renderPage();
    await screen.findByText('Drug monographs');

    respondWith({
      ...basePage,
      matchedReferences: 1,
      totalRows: 1,
      rangeEnd: 1,
      buckets: [{ key: 'drug-7', label: 'diazepam', count: 1 }],
      groups: [basePage.groups[0]],
    });

    fireEvent.change(screen.getByPlaceholderText(/search references/i), {
      target: { value: 'doi:10.1093/jat/bkaa107' },
    });

    await waitFor(() =>
      expect(
        requestedUrls().some((url) =>
          url.includes(`q=${encodeURIComponent('doi:10.1093/jat/bkaa107')}`),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText('Elimination kinetics')).toBeNull(),
    );
    expect(screen.getByText('Diazepam PK study')).toBeTruthy();
    // One translated sentence owns the whole summary while a search is
    // active — no fragments joined with hardcoded punctuation in JSX.
    expect(
      screen.getByText('Showing 1–1 of 1 · 1 source matches'),
    ).toBeTruthy();
  });

  it('shows the no-match state for a query with no hits', async () => {
    respondWith(basePage);
    renderPage();
    await screen.findByText('Drug monographs');

    respondWith({
      ...basePage,
      groups: [],
      buckets: [],
      matchedReferences: 0,
      totalRows: 0,
      rangeStart: 0,
      rangeEnd: 0,
    });

    fireEvent.change(screen.getByPlaceholderText(/search references/i), {
      target: { value: 'nothing here' },
    });

    expect(
      await screen.findByText('No references match your search.'),
    ).toBeTruthy();
  });

  it('switches the grouping axis and renders year buckets', async () => {
    respondWith(basePage);
    renderPage();
    await screen.findByText('Drug monographs');

    respondWith({
      ...basePage,
      groupBy: 'year',
      buckets: [
        { key: '2021', label: '2021', count: 1 },
        { key: 'unknown', label: null, count: 1 },
      ],
      groups: [
        {
          kind: 'year' as const,
          key: '2021',
          label: '2021',
          totalReferences: 1,
          references: [citation(2, 'Elimination kinetics', 2021)],
        },
        {
          kind: 'year' as const,
          key: 'unknown',
          label: null,
          totalReferences: 1,
          references: [citation(3, 'Undated report')],
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));

    await waitFor(() =>
      expect(requestedUrls().some((url) => url.includes('groupBy=year'))).toBe(
        true,
      ),
    );
    // "Undated" labels both the jump-index chip and the group heading.
    await waitFor(() =>
      expect(screen.getAllByText('Undated').length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('button', { name: '2021' })).toBeTruthy();
    expect(screen.getByText('Undated report')).toBeTruthy();
  });

  it('switches to the author axis and names the authorless bucket', async () => {
    respondWith(basePage);
    renderPage();
    await screen.findByText('Drug monographs');

    respondWith({
      ...basePage,
      groupBy: 'author',
      buckets: [
        { key: 'H', label: 'H', count: 1 },
        { key: 'unknown', label: null, count: 1 },
      ],
      groups: [
        {
          kind: 'author' as const,
          key: 'H',
          label: 'H',
          totalReferences: 1,
          references: [citation(2, 'Elimination kinetics', 2021)],
        },
        {
          kind: 'author' as const,
          key: 'unknown',
          label: null,
          totalReferences: 1,
          references: [citation(3, 'ISO 17025 accreditation')],
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Author A–Z' }));

    await waitFor(() =>
      expect(
        requestedUrls().some((url) => url.includes('groupBy=author')),
      ).toBe(true),
    );
    // "No author" labels both the jump-index chip and the group heading —
    // never "Undated", which belongs to the year axis.
    await waitFor(() =>
      expect(screen.getAllByText('No author').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Undated')).toBeNull();
    expect(screen.getByRole('button', { name: 'H' })).toBeTruthy();
    expect(screen.getByText('ISO 17025 accreditation')).toBeTruthy();
  });

  it('requests the next page when paginating', async () => {
    respondWith({ ...basePage, totalPages: 3, totalRows: 120, rangeEnd: 50 });
    renderPage();
    await screen.findByText('Page 1 of 3');

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() =>
      expect(requestedUrls().some((url) => url.includes('page=2'))).toBe(true),
    );
  });

  it('honours a bucket and page carried in the URL', async () => {
    respondWith({ ...basePage, groupBy: 'alpha', bucket: 'D', page: 2 });
    renderPage('/references?group=alpha&bucket=D&page=2');

    await waitFor(() => expect(requestedUrls().length).toBeGreaterThan(0));
    const url = requestedUrls()[0]!;
    expect(url).toContain('groupBy=alpha');
    expect(url).toContain('bucket=D');
    expect(url).toContain('page=2');
  });

  it('keeps a history entry for each discrete navigation step', async () => {
    respondWith({ ...basePage, totalPages: 3 });
    renderPage();
    await screen.findByText('Drug monographs');

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain(
        'group=year',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain('page=2'),
    );

    // Back must land on the year view's first page — not skip the whole
    // reference journey because each step replaced the entry before it.
    fireEvent.click(screen.getByRole('button', { name: 'router-back' }));
    await waitFor(() => {
      const search = screen.getByTestId('location').textContent ?? '';
      expect(search).toContain('group=year');
      expect(search).not.toContain('page=2');
    });

    fireEvent.click(screen.getByRole('button', { name: 'router-back' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).not.toContain(
        'group=year',
      ),
    );
  });

  it('normalizes a regional locale before resolving drug names', async () => {
    // `names` is keyed by bare language code, so passing "nb-NO" through would
    // miss names.nb and fall back to English — on the server (which sorts the
    // drug axis) as well as here.
    await i18n.changeLanguage('nb-NO');
    respondWith(basePage);
    renderPage();

    await waitFor(() => expect(requestedUrls().length).toBeGreaterThan(0));
    expect(requestedUrls()[0]).toContain('lang=nb');
    expect(requestedUrls()[0]).not.toContain('lang=nb-NO');
  });

  it('shows an error state when the fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    renderPage();
    expect(await screen.findByText('Could not load references.')).toBeTruthy();
  });

  it('shows an empty state when no references are cited', async () => {
    respondWith({
      ...basePage,
      groups: [],
      buckets: [],
      totalReferences: 0,
      matchedReferences: 0,
      totalRows: 0,
      rangeStart: 0,
      rangeEnd: 0,
    });
    renderPage();
    expect(
      await screen.findByText('No references have been cited yet.'),
    ).toBeTruthy();
  });
});
