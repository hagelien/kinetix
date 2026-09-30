import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { PdfRequestsPage } from './PdfRequestsPage';

// A contributor viewer: holds both `citation.pdf.access` and
// `pdfRequest.create`, so gap rows offer an upload rather than read-only text.
const authState = {
  user: { id: 1, role: 'contributor', username: 'c', displayName: null },
  isAuthenticated: true,
  isLoading: false,
};
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

const {
  fetchPdfQueueMock,
  createPdfRequestMock,
  uploadCitationPdfMock,
  waitForCitationPdfMock,
} = vi.hoisted(() => ({
  fetchPdfQueueMock: vi.fn(),
  createPdfRequestMock: vi.fn(),
  uploadCitationPdfMock: vi.fn(),
  waitForCitationPdfMock: vi.fn(),
}));

vi.mock('@/lib/referencesApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/referencesApi')>(
      '@/lib/referencesApi',
    );
  return {
    ...actual,
    fetchPdfQueue: fetchPdfQueueMock,
    createPdfRequest: createPdfRequestMock,
    uploadCitationPdf: uploadCitationPdfMock,
    waitForCitationPdf: waitForCitationPdfMock,
  };
});

const OPEN_REQUEST = {
  id: 7,
  citationId: 12,
  status: 'open',
  reason: 'Paywalled at the publisher',
  createdAt: '2026-07-01T00:00:00.000Z',
  citationType: 'doi' as const,
  citationIdentifier: '10.1/x',
  citationMetadata: { title: 'A requested paper' },
};

const GAP = {
  citationId: 83,
  citationType: 'pmid' as const,
  citationIdentifier: '8513649',
  citationMetadata: {
    title: 'Clinical pharmacokinetics of alprazolam',
  },
  citationCreatedAt: '2026-01-05T00:00:00.000Z',
  previouslyRequested: false,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <PdfRequestsPage />
    </MemoryRouter>,
  );
}

describe('PdfRequestsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists unrequested full-text gaps in their own section', async () => {
    // The bug this closes: a reference page advertising "full text missing"
    // while the queue showed nothing, because only pdf_requests rows were read.
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [OPEN_REQUEST],
      gaps: [GAP],
      gapTotal: 1,
    });

    renderPage();

    // The title renders in both the link and the citation label line, so
    // assert on presence rather than a single node.
    expect(
      (await screen.findAllByText('A requested paper')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Missing full text')).toBeTruthy();
    expect(
      screen.getAllByText('Clinical pharmacokinetics of alprazolam').length,
    ).toBeGreaterThan(0);
    // A gap has no request to date from, so it is dated by the citation.
    // The trailing date distinguishes the row's stamp from the "Requested"
    // section heading.
    expect(screen.getByText(/^Cited since \S/)).toBeTruthy();
    expect(screen.getByText(/^Requested \S/)).toBeTruthy();
  });

  it('says so when a gap carries a closed request rather than none', async () => {
    // `recordPaperReview` cancels the open request even for a
    // `readInFull: false` review, so this paper lands back in the gap list
    // with a history that contradicts "nobody has asked".
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [],
      gaps: [{ ...GAP, previouslyRequested: true }],
      gapTotal: 1,
    });

    renderPage();

    expect(
      await screen.findByText(
        'A request for this paper was filed earlier and is no longer open.',
      ),
    ).toBeTruthy();
  });

  it('does not claim a prior request when none was filed', async () => {
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [],
      gaps: [GAP],
      gapTotal: 1,
    });

    renderPage();

    await screen.findAllByText('Clinical pharmacokinetics of alprazolam');
    expect(screen.queryByText(/filed earlier/)).toBeNull();
  });

  it('keeps the empty state when neither class has entries', async () => {
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [],
      gaps: [],
      gapTotal: 0,
    });

    renderPage();

    expect(
      await screen.findByText('No open PDF requests — the queue is clear.'),
    ).toBeTruthy();
    expect(screen.queryByText('Missing full text')).toBeNull();
  });

  it('says what it is omitting when the gap list is capped', async () => {
    // No silent truncation: the server limits the gap page, so a contributor
    // must not read the list as the complete set.
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [],
      gaps: [GAP],
      gapTotal: 214,
    });

    renderPage();

    expect(await screen.findByText('Showing 1 of 214.')).toBeTruthy();
  });

  it('self-provisions a request before uploading to a gap row', async () => {
    // The upload routes require an open request; a gap has none, so skipping
    // this step would 403 with `pdf_request_not_open`.
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [],
      gaps: [GAP],
      gapTotal: 1,
    });
    createPdfRequestMock.mockResolvedValue(undefined);
    uploadCitationPdfMock.mockResolvedValue(undefined);
    waitForCitationPdfMock.mockResolvedValue({ request: null, hasPdf: true });

    const { container } = renderPage();

    await screen.findAllByText('Clinical pharmacokinetics of alprazolam');
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const file = new File(['%PDF-1.7'], 'paper.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(input, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => expect(uploadCitationPdfMock).toHaveBeenCalled());
    expect(createPdfRequestMock).toHaveBeenCalledWith(83);
  });

  it('uploads straight to an open request without re-filing it', async () => {
    await i18n.changeLanguage('en');
    fetchPdfQueueMock.mockResolvedValue({
      requests: [OPEN_REQUEST],
      gaps: [],
      gapTotal: 0,
    });
    uploadCitationPdfMock.mockResolvedValue(undefined);
    waitForCitationPdfMock.mockResolvedValue({ request: null, hasPdf: true });

    const { container } = renderPage();

    await screen.findAllByText('A requested paper');
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const file = new File(['%PDF-1.7'], 'paper.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(input, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => expect(uploadCitationPdfMock).toHaveBeenCalled());
    expect(createPdfRequestMock).not.toHaveBeenCalled();
  });
  describe('bulk open', () => {
    const requestFor = (n: number, extra: Record<string, unknown> = {}) => ({
      ...OPEN_REQUEST,
      id: n,
      citationId: 1000 + n,
      citationIdentifier: `10.1/p${n}`,
      citationMetadata: { title: `Paper ${n}` },
      ...extra,
    });
    const openedIds = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((c) => String(c[0]).replace('https://doi.org/10.1/', ''));

    it('opens a random 20, not the head of the list', async () => {
      await i18n.changeLanguage('en');
      const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
      // 0.99 makes the first draw pick the last item in the list.
      const rand = vi.spyOn(Math, 'random').mockReturnValue(0.99);
      fetchPdfQueueMock.mockResolvedValue({
        requests: Array.from({ length: 25 }, (_, i) => requestFor(i + 1)),
        gaps: [],
        gapTotal: 0,
      });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: /Open 20 random/ }));
      const ids = openedIds(open);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
      // Head-first would start at p1; the sample starts from the tail.
      expect(ids[0]).toBe('p25');
      rand.mockRestore();
      open.mockRestore();
    });

    it('opens every link when fewer than 20 are queued', async () => {
      await i18n.changeLanguage('en');
      const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
      fetchPdfQueueMock.mockResolvedValue({
        requests: Array.from({ length: 6 }, (_, i) => requestFor(i + 1)),
        gaps: [],
        gapTotal: 0,
      });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: /Open 6 random/ }));
      expect(openedIds(open).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
      open.mockRestore();
    });

    it('spends no slot on a request whose PDF is already in the inbox', async () => {
      await i18n.changeLanguage('en');
      const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
      fetchPdfQueueMock.mockResolvedValue({
        requests: [
          requestFor(1, { pdfInInbox: true }),
          ...Array.from({ length: 20 }, (_, i) => requestFor(i + 2)),
        ],
        gaps: [],
        gapTotal: 0,
      });
      renderPage();

      fireEvent.click(
        await screen.findByRole('button', { name: /Open 20 random/ }),
      );
      const ids = openedIds(open);
      expect(ids).toHaveLength(20);
      expect(ids).not.toContain('p1');
      expect(ids).toContain('p21');
      open.mockRestore();
    });
  });
});
