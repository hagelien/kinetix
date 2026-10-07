import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@/i18n';
import i18n from 'i18next';
import { PdfFulfillError } from '@/lib/referencesApi';
import { CitationPdfSection } from './CitationPdfSection';

// A contributor viewer so the self-service upload affordance is offered. The
// role is mutable so the share-link block (admin by default) can be exercised.
const authState = {
  user: { id: 1, role: 'contributor', username: 'c', displayName: null },
  isAuthenticated: true,
  isLoading: false,
};

function setViewerRole(role: string): void {
  authState.user = { ...authState.user, role };
}
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

const {
  fetchPdfRequestMock,
  createPdfRequestMock,
  createPdfShareLinkMock,
  submitPdfUrlMock,
  uploadCitationPdfMock,
  waitForCitationPdfMock,
} = vi.hoisted(() => ({
  fetchPdfRequestMock: vi.fn(),
  createPdfRequestMock: vi.fn(),
  createPdfShareLinkMock: vi.fn(),
  submitPdfUrlMock: vi.fn(),
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
    fetchPdfRequest: fetchPdfRequestMock,
    createPdfRequest: createPdfRequestMock,
    createPdfShareLink: createPdfShareLinkMock,
    submitPdfUrl: submitPdfUrlMock,
    uploadCitationPdf: uploadCitationPdfMock,
    waitForCitationPdf: waitForCitationPdfMock,
  };
});

describe('CitationPdfSection self-service upload', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stays hidden when the paper already has a review', async () => {
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

    const { container } = render(
      <CitationPdfSection citationId={7} resolvable hasReview={true} />,
    );

    await waitFor(() => expect(fetchPdfRequestMock).toHaveBeenCalled());
    // No PDF, no request, and a review exists → nothing to show.
    expect(container.querySelector('section')).toBeNull();
  });

  it('stays hidden until the review status is known', async () => {
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

    const { container } = render(
      <CitationPdfSection citationId={7} resolvable hasReview={null} />,
    );

    await waitFor(() => expect(fetchPdfRequestMock).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
  });

  it('offers a direct upload when there is no review and no full text', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    expect(
      await screen.findByText(
        "This paper hasn't been reviewed yet because the full text isn't on file. Upload it here to enable a review.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /upload a pdf/i })).toBeTruthy();
  });

  it.each([
    ['public_database_record', /public database entry, not a paper/],
    ['site_landing_page', /website's front page, not a specific source/],
  ] as const)(
    'explains why a %s needs no PDF instead of offering an upload',
    async (reason, text) => {
      await i18n.changeLanguage('en');
      fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

      render(
        <CitationPdfSection
          citationId={7}
          resolvable
          hasReview={false}
          noPdfReason={reason}
        />,
      );

      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Upload a PDF/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId('pdf-dropzone')).not.toBeInTheDocument();
    },
  );

  it('accepts a PDF dropped on the upload panel', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });
    createPdfRequestMock.mockResolvedValue(undefined);
    uploadCitationPdfMock.mockResolvedValue(undefined);
    waitForCitationPdfMock.mockResolvedValue({ request: null, hasPdf: true });

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    const zone = await screen.findByTestId('pdf-dropzone');
    const file = new File(['%PDF-1.7'], 'paper.pdf', {
      type: 'application/pdf',
    });

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByRole('button', { name: /drop to upload/i })).toBeTruthy();

    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } });

    await waitFor(() => expect(uploadCitationPdfMock).toHaveBeenCalled());
    // The reference page has no open request of its own, so one is provisioned.
    expect(createPdfRequestMock).toHaveBeenCalledWith(7);
    expect(uploadCitationPdfMock).toHaveBeenCalledWith(7, file);
    expect(await screen.findByText('Thanks — the PDF is now on file.')).toBeTruthy();
  });

  it('swallows a second drop while an upload is in flight', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });
    createPdfRequestMock.mockResolvedValue(undefined);
    // Hold the first upload open so the zone stays in its busy state.
    let release = (): void => {};
    uploadCitationPdfMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    waitForCitationPdfMock.mockResolvedValue({ request: null, hasPdf: true });

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    const zone = await screen.findByTestId('pdf-dropzone');
    const file = new File(['%PDF-1.7'], 'paper.pdf', {
      type: 'application/pdf',
    });
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(uploadCitationPdfMock).toHaveBeenCalledTimes(1));

    // The busy zone must still cancel the browser default — an unhandled drop
    // navigates the tab to the file and tears down the running upload.
    const dropped = fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [file] },
    });
    expect(dropped).toBe(false);
    expect(uploadCitationPdfMock).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() =>
      expect(screen.getByText('Thanks — the PDF is now on file.')).toBeTruthy(),
    );
  });

  it('rejects a dropped non-PDF without uploading', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    const zone = await screen.findByTestId('pdf-dropzone');
    const file = new File(['nope'], 'notes.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } });

    expect(await screen.findByText("That file isn't a PDF.")).toBeTruthy();
    expect(uploadCitationPdfMock).not.toHaveBeenCalled();
    expect(createPdfRequestMock).not.toHaveBeenCalled();
  });

  it('ignores drags that carry no files', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    const zone = await screen.findByTestId('pdf-dropzone');
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'] } });

    // Dragging selected text across the panel must not light it up.
    expect(screen.getByRole('button', { name: /upload a pdf/i })).toBeTruthy();
  });

  it('self-provisions a request before submitting a URL', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: false });
    createPdfRequestMock.mockResolvedValue(undefined);
    submitPdfUrlMock.mockResolvedValue(undefined);

    render(<CitationPdfSection citationId={7} resolvable hasReview={false} />);

    const input = (await screen.findByPlaceholderText(
      'https://example.org/paper.pdf',
    )) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://example.org/paper.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(submitPdfUrlMock).toHaveBeenCalled());
    expect(createPdfRequestMock).toHaveBeenCalledWith(7);
    expect(submitPdfUrlMock).toHaveBeenCalledWith(
      7,
      'https://example.org/paper.pdf',
    );
  });
});

describe('CitationPdfSection share link', () => {
  afterEach(() => {
    vi.clearAllMocks();
    setViewerRole('contributor');
  });

  it('offers no share button to a contributor', async () => {
    await i18n.changeLanguage('en');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });

    render(<CitationPdfSection citationId={7} resolvable hasReview={true} />);

    expect(
      await screen.findByText('Full-text PDF is on file.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /download link/i })).toBeNull();
  });

  it('mints a link an admin can copy, and says when it expires', async () => {
    await i18n.changeLanguage('en');
    setViewerRole('admin');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    createPdfShareLinkMock.mockResolvedValue({
      url: 'https://kinetix.no/api/citation-pdf-share?token=abc',
      expiresAt,
      expiresInSeconds: 600,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CitationPdfSection citationId={7} resolvable hasReview={true} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /create download link/i }),
    );

    await waitFor(() => expect(createPdfShareLinkMock).toHaveBeenCalledWith(7));
    const field = (await screen.findByLabelText(
      'Temporary download link',
    )) as HTMLInputElement;
    expect(field.value).toBe(
      'https://kinetix.no/api/citation-pdf-share?token=abc',
    );
    expect(writeText).toHaveBeenCalledWith(
      'https://kinetix.no/api/citation-pdf-share?token=abc',
    );
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy();
  });

  it('still shows the link when the clipboard is unavailable', async () => {
    await i18n.changeLanguage('en');
    setViewerRole('admin');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });
    createPdfShareLinkMock.mockResolvedValue({
      url: 'https://kinetix.no/api/citation-pdf-share?token=abc',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresInSeconds: 600,
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });

    render(<CitationPdfSection citationId={7} resolvable hasReview={true} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /create download link/i }),
    );

    const field = (await screen.findByLabelText(
      'Temporary download link',
    )) as HTMLInputElement;
    expect(field.value).toContain('token=abc');
    // Copying failed, so the button still invites a manual retry.
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeTruthy();
  });

  it('does not claim a copy when the browser has no clipboard API', async () => {
    await i18n.changeLanguage('en');
    setViewerRole('admin');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });
    createPdfShareLinkMock.mockResolvedValue({
      url: 'https://kinetix.no/api/citation-pdf-share?token=abc',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresInSeconds: 600,
    });
    // Insecure origin / older browser: the property is simply not there, and
    // an optional-chained call would resolve to undefined rather than throw.
    Object.assign(navigator, { clipboard: undefined });

    render(<CitationPdfSection citationId={7} resolvable hasReview={true} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /create download link/i }),
    );

    // The link is still offered, but the button must not say it was copied.
    expect(
      (
        (await screen.findByLabelText(
          'Temporary download link',
        )) as HTMLInputElement
      ).value,
    ).toContain('token=abc');
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /copied/i })).toBeNull();

    // Clicking copy with no clipboard has to report the failure, not sit
    // there looking like it worked.
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    expect(
      await screen.findByText(
        "Couldn't copy the link — select it and copy it manually.",
      ),
    ).toBeTruthy();
  });

  it('drops a link that arrives after the admin moved to another reference', async () => {
    await i18n.changeLanguage('en');
    setViewerRole('admin');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });
    // Hold the mint open so the navigation lands mid-flight.
    let resolveMint: (link: unknown) => void = () => {};
    createPdfShareLinkMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMint = resolve;
        }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { rerender } = render(
      <CitationPdfSection citationId={7} resolvable hasReview={true} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /create download link/i }),
    );
    await waitFor(() => expect(createPdfShareLinkMock).toHaveBeenCalledWith(7));

    // The reference route reuses this component across navigations, so
    // citation 9 arrives as a prop change rather than a remount.
    rerender(<CitationPdfSection citationId={9} resolvable hasReview={true} />);
    await waitFor(() =>
      expect(fetchPdfRequestMock).toHaveBeenCalledWith(9),
    );

    resolveMint({
      url: 'https://kinetix.no/api/citation-pdf-share?token=for-citation-7',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expiresInSeconds: 600,
    });

    // Citation 7's link must not surface under citation 9, and must not reach
    // the clipboard — the field's contents are what gets sent to someone.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /create download link/i }),
      ).toBeTruthy(),
    );
    expect(screen.queryByLabelText('Temporary download link')).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a refused mint through the shared error mapping', async () => {
    await i18n.changeLanguage('en');
    setViewerRole('admin');
    fetchPdfRequestMock.mockResolvedValue({ request: null, hasPdf: true });
    createPdfShareLinkMock.mockRejectedValue(
      new PdfFulfillError('pdf_share_rate_limited'),
    );

    render(<CitationPdfSection citationId={7} resolvable hasReview={true} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /create download link/i }),
    );

    expect(
      await screen.findByText(
        'Too many download links created just now. Wait a moment and try again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Temporary download link')).toBeNull();
  });
});
