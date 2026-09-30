import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { PdfInboxPage } from './PdfInboxPage';

// A contributor: holds both `pdfInbox.upload` and `pdfInbox.resolve`, which is
// what the drop zone and the link buttons are gated on.
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
  fetchInboxMock,
  attachInboxItemMock,
  discardInboxItemMock,
  autoAttachInboxMock,
  rematchInboxItemMock,
  uploadToInboxMock,
  probeInboxStorageMock,
} = vi.hoisted(() => ({
  fetchInboxMock: vi.fn(),
  attachInboxItemMock: vi.fn(),
  discardInboxItemMock: vi.fn(),
  autoAttachInboxMock: vi.fn(),
  rematchInboxItemMock: vi.fn(),
  uploadToInboxMock: vi.fn(),
  probeInboxStorageMock: vi.fn(),
}));

vi.mock('@/lib/pdfInboxApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/pdfInboxApi')>('@/lib/pdfInboxApi');
  return {
    ...actual,
    fetchInbox: fetchInboxMock,
    attachInboxItem: attachInboxItemMock,
    discardInboxItem: discardInboxItemMock,
    autoAttachInbox: autoAttachInboxMock,
    rematchInboxItem: rematchInboxItemMock,
    uploadToInbox: uploadToInboxMock,
    probeInboxStorage: probeInboxStorageMock,
  };
});

const CITATION = {
  id: 12,
  drugId: null,
  type: 'doi' as const,
  identifier: '10.1016/j.jpba.2020.113456',
  metadata: { title: 'Population pharmacokinetics of midazolam' },
  createdAt: '2026-07-01T00:00:00.000Z',
};

function item(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    originalFilename: 'downloaded (3).pdf',
    sizeBytes: 524_288,
    status: 'pending' as const,
    extracted: {
      doi: '10.1016/j.jpba.2020.113456',
      pmid: null,
      pmcid: null,
      title: null,
      year: 2020,
      sources: { doi: 'xmp' as const },
    },
    candidates: [
      {
        citationId: 12,
        via: 'doi' as const,
        score: 1,
        citationType: 'doi' as const,
        citationIdentifier: '10.1016/j.jpba.2020.113456',
        citationMetadata: CITATION.metadata,
        hasPdf: false,
      },
    ],
    matchedCitationId: 12,
    matchConfidence: 'exact' as const,
    autoAttached: false,
    attachedAt: null,
    lastError: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PdfInboxPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  void i18n.changeLanguage('en');
});

describe('PdfInboxPage', () => {
  it('shows a waiting file with what was read out of it', async () => {
    fetchInboxMock.mockResolvedValue({ items: [item()], citations: [CITATION], cleanupPending: 0 });
    renderPage();

    expect(await screen.findByText('downloaded (3).pdf')).toBeInTheDocument();
    // The identifier and where it came from: a reviewer judging a doubtful
    // match needs to know whether the DOI was stamped in the document or
    // merely guessed from a filename.
    expect(
      screen.getByText(/10\.1016\/j\.jpba\.2020\.113456/),
    ).toBeInTheDocument();
    // The candidate is named by its title, not its row id.
    expect(
      screen.getByText('Population pharmacokinetics of midazolam'),
    ).toBeInTheDocument();
  });

  it('links a candidate and drops the row from the queue', async () => {
    fetchInboxMock.mockResolvedValue({ items: [item()], citations: [CITATION], cleanupPending: 0 });
    attachInboxItemMock.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Link' }));

    await waitFor(() => {
      expect(attachInboxItemMock).toHaveBeenCalledWith(1, 12);
    });
    await waitFor(() => {
      expect(screen.queryByText('downloaded (3).pdf')).not.toBeInTheDocument();
    });
  });

  it('warns before a link that would overwrite stored full text', async () => {
    // Linking here is editor-gated at the API. Saying so before the click
    // beats a 403 after it.
    fetchInboxMock.mockResolvedValue({
      items: [
        item({
          candidates: [{ ...item().candidates[0], hasPdf: true }],
        }),
      ],
      citations: [CITATION],
      cleanupPending: 0,
    });
    renderPage();

    expect(
      await screen.findByText(/already has full text/i),
    ).toBeInTheDocument();
  });

  it('reports a failed link in words rather than a server code', async () => {
    fetchInboxMock.mockResolvedValue({ items: [item()], citations: [CITATION], cleanupPending: 0 });
    const { PdfInboxError } = await vi.importActual<
      typeof import('@/lib/pdfInboxApi')
    >('@/lib/pdfInboxApi');
    attachInboxItemMock.mockRejectedValue(
      new PdfInboxError('pdf_replace_requires_editor'),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Link' }));

    expect(
      await screen.findByText(/requires the editor role/i),
    ).toBeInTheDocument();
    // The row stays: the file is still waiting to be linked.
    expect(screen.getByText('downloaded (3).pdf')).toBeInTheDocument();
  });

  it('still offers the sweep when nothing is certain yet', async () => {
    // The sweep is not only "link the obvious ones". It re-matches every
    // pending item — the only way something that matched nothing on arrival
    // becomes linkable once the paper is cited — and it retries storage
    // deletions a discard could not finish. Gating it on a stored exact match
    // would strand both, and the stored grade is exactly the snapshot that
    // cannot know about a citation added since.
    fetchInboxMock.mockResolvedValue({
      items: [item({ candidates: [], matchedCitationId: null, matchConfidence: 'none' })],
      citations: [],
      cleanupPending: 0,
    });
    renderPage();

    const sweep = await screen.findByRole('button', { name: /Re-check all files/i });
    expect(sweep).toBeEnabled();
  });

  it('offers the sweep with an empty inbox when storage cleanup is outstanding', async () => {
    // A failed discard on the last pending item leaves an object in storage
    // and an empty queue. Without this the retry has no trigger at all and the
    // licensed full text stays there indefinitely.
    fetchInboxMock.mockResolvedValue({
      items: [],
      citations: [],
      cleanupPending: 2,
    });
    renderPage();

    expect(
      await screen.findByRole('button', { name: /Re-check all files/i }),
    ).toBeEnabled();
  });

  it('reports storage the sweep managed to clear', async () => {
    fetchInboxMock.mockResolvedValue({ items: [], citations: [], cleanupPending: 3 });
    autoAttachInboxMock.mockResolvedValue({
      attached: [],
      failed: [],
      scanned: 0,
      truncated: false,
      pending: 0,
      cleaned: 3,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Re-check all files/i }));

    // Silence would leave the only sign of cleanup being its absence from a
    // count nobody is watching.
    expect(await screen.findByText(/3 discarded file/i)).toBeInTheDocument();
  });

  it('runs the sweep and says how much is left when it was truncated', async () => {
    fetchInboxMock.mockResolvedValue({ items: [item()], citations: [CITATION], cleanupPending: 0 });
    autoAttachInboxMock.mockResolvedValue({
      attached: [{ itemId: 1, citationId: 12 }],
      failed: [],
      scanned: 50,
      truncated: true,
      pending: 30,
      cleaned: 0,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Link 1 certain/ }));

    // Silence here would read as "everything obvious is done", which is the
    // one thing a truncated sweep does not mean.
    expect(await screen.findByText(/30 still waiting/)).toBeInTheDocument();
  });

  it('discards a file nobody wants', async () => {
    fetchInboxMock.mockResolvedValue({ items: [item()], citations: [CITATION], cleanupPending: 0 });
    discardInboxItemMock.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(discardInboxItemMock).toHaveBeenCalledWith(1));
  });

  it('says so plainly when nothing matched', async () => {
    fetchInboxMock.mockResolvedValue({
      items: [
        item({
          candidates: [],
          matchedCitationId: null,
          matchConfidence: 'none',
          extracted: null,
        }),
      ],
      citations: [],
      cleanupPending: 0,
    });
    renderPage();

    expect(await screen.findByText(/No citation matched/i)).toBeInTheDocument();
    // And the manual search is still offered — it is the way out.
    expect(
      screen.getByRole('searchbox', { name: /Search references/i }),
    ).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty inbox', async () => {
    // "Nothing left to do" and "we could not find out" look identical on the
    // page unless one of them says so.
    fetchInboxMock.mockRejectedValue(new Error('offline'));
    renderPage();
    expect(await screen.findByText(/Couldn't load the inbox/i)).toBeInTheDocument();

    vi.clearAllMocks();
    fetchInboxMock.mockResolvedValue({ items: [], citations: [], cleanupPending: 0 });
    renderPage();
    expect(await screen.findByText(/Nothing waiting/i)).toBeInTheDocument();
  });

  it('uploads every file in a multi-file selection', async () => {
    fetchInboxMock.mockResolvedValue({ items: [], citations: [], cleanupPending: 0 });
    probeInboxStorageMock.mockResolvedValue(undefined);
    uploadToInboxMock.mockResolvedValue(undefined);
    const { container } = renderPage();
    await screen.findByText(/Nothing waiting/i);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [
      new File(['%PDF-1.7'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-1.7'], 'two.pdf', { type: 'application/pdf' }),
    ] } });

    await waitFor(() => expect(uploadToInboxMock).toHaveBeenCalledTimes(2));
    // One probe for the batch, not one per file: forty files would otherwise
    // make forty identical round trips and forty identical failures.
    expect(probeInboxStorageMock).toHaveBeenCalledTimes(1);
  });

  it('skips an obvious non-PDF visibly rather than silently', async () => {
    fetchInboxMock.mockResolvedValue({ items: [], citations: [], cleanupPending: 0 });
    probeInboxStorageMock.mockResolvedValue(undefined);
    uploadToInboxMock.mockResolvedValue(undefined);
    const { container } = renderPage();
    await screen.findByText(/Nothing waiting/i);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [
      new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' }),
      new File(['x'], 'notes.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ] } });

    await waitFor(() => expect(uploadToInboxMock).toHaveBeenCalledTimes(1));
    // Dragging a folder that contains a spreadsheet must not leave the person
    // believing it went in.
    expect(await screen.findByText('notes.docx')).toBeInTheDocument();
    expect(screen.getByText(/isn't a PDF/i)).toBeInTheDocument();
  });
});
