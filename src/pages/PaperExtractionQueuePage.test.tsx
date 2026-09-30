import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PaperExtractionQueuePage } from './PaperExtractionQueuePage';
import type { PaperExtractionJob } from '@/lib/paperExtractionApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  // AuthGuard renders its access-denied copy through <Trans>.
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const {
  fetchJobsMock,
  enqueueMock,
  updateJobMock,
  useAuthStoreMock,
} = vi.hoisted(() => ({
  fetchJobsMock: vi.fn(),
  enqueueMock: vi.fn(),
  updateJobMock: vi.fn(),
  useAuthStoreMock: vi.fn(),
}));

vi.mock('@/lib/paperExtractionApi', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/paperExtractionApi')
  >('@/lib/paperExtractionApi');
  return {
    ...actual,
    fetchPaperExtractionJobs: fetchJobsMock,
    enqueuePaperExtraction: enqueueMock,
    updatePaperExtractionJob: updateJobMock,
  };
});

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (state: unknown) => unknown) => {
    const state = useAuthStoreMock();
    return selector ? selector(state) : state;
  },
}));

function job(over: Partial<PaperExtractionJob> = {}): PaperExtractionJob {
  return {
    id: 5,
    citationId: 12,
    status: 'queued',
    scopeNote: null,
    targetDrugIds: null,
    requestedBy: 1,
    claimedBy: null,
    claimedAt: null,
    attempts: 0,
    lastError: null,
    resultSummary: null,
    factsSubmitted: null,
    pendingEditIds: null,
    completedAt: null,
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-01T09:00:00Z',
    citationType: 'doi',
    citationIdentifier: '10.1000/example',
    citationMetadata: { title: 'Postmortem redistribution of quetiapine' },
    requestedByUsername: 'editor',
    claimedByUsername: null,
    hasPaperReview: false,
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PaperExtractionQueuePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStoreMock.mockReturnValue({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 1, role: 'editor' },
  });
  fetchJobsMock.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaperExtractionQueuePage', () => {
  it('keeps the queue behind the editor tier', async () => {
    useAuthStoreMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 9, role: 'contributor' },
    });

    renderPage();

    expect(screen.getByText('auth.accessDenied')).toBeInTheDocument();
    expect(fetchJobsMock).not.toHaveBeenCalled();
  });

  it('shows the empty state when nothing is queued', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('paperExtraction.empty')).toBeInTheDocument(),
    );
  });

  it('distinguishes a load failure from an empty queue', async () => {
    // An empty list and a broken API must not read the same — "queue is clear"
    // is exactly the wrong thing to tell an editor whose upload is stuck.
    fetchJobsMock.mockRejectedValue(new Error('boom'));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('paperExtraction.loadFailed'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('paperExtraction.empty')).toBeNull();
  });

  it('renders a queued job with its citation and offers cancel, not requeue', async () => {
    fetchJobsMock.mockResolvedValue([job({ scopeNote: 'kun postmortem' })]);

    renderPage();

    // The title appears twice — as the card heading and inside the citation
    // label, which falls back to the title when the row carries no authors.
    await waitFor(() =>
      expect(
        screen.getAllByText(/Postmortem redistribution of quetiapine/).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText('paperExtraction.status.queued')).toBeInTheDocument();
    expect(screen.getByText(/kun postmortem/)).toBeInTheDocument();
    expect(screen.getByText('paperExtraction.cancel')).toBeInTheDocument();
    expect(screen.queryByText('paperExtraction.requeue')).toBeNull();
  });

  it('offers requeue on a settled job and shows the run result', async () => {
    fetchJobsMock.mockResolvedValue([
      job({
        status: 'completed',
        factsSubmitted: 3,
        resultSummary: 'Leste artikkelen i sin helhet.',
        claimedByUsername: 'kinetix-agent',
        attempts: 1,
      }),
    ]);

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('paperExtraction.status.completed'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText('Leste artikkelen i sin helhet.'),
    ).toBeInTheDocument();
    expect(screen.getByText('paperExtraction.requeue')).toBeInTheDocument();
    expect(screen.queryByText('paperExtraction.cancel')).toBeNull();
  });

  it('offers a full-text replacement wherever the job can be re-queued', async () => {
    // Requeueing a job whose stored PDF is unusable just feeds the agent the
    // same bad input until its retry budget is gone. `cancelled` matters as
    // much as `failed` — an editor who spots the wrong paper cancels rather
    // than waiting for a failure — and `completed` matters too, when the
    // result summary reveals the agent read the wrong paper.
    for (const status of ['failed', 'cancelled', 'completed'] as const) {
      fetchJobsMock.mockResolvedValue([job({ status })]);
      const { unmount } = renderPage();
      await waitFor(() =>
        expect(
          screen.getByText('paperExtraction.replacePdf'),
        ).toBeInTheDocument(),
      );
      expect(screen.getByText('paperExtraction.requeue')).toBeInTheDocument();
      unmount();
    }
  });

  it('hides replacement while a sibling job for the same citation is open', async () => {
    // The PDF is citation-level, not job-level. A settled card sitting beside
    // a newer open job for the same paper must not offer to swap the bytes the
    // open job was queued with — or, once claimed, is being read.
    fetchJobsMock.mockResolvedValue([
      job({ id: 5, citationId: 12, status: 'queued' }),
      job({ id: 4, citationId: 12, status: 'completed' }),
    ]);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('paperExtraction.requeue')).toBeInTheDocument(),
    );
    expect(screen.queryByText('paperExtraction.replacePdf')).toBeNull();
  });

  it('still offers replacement when the open job is a different paper', async () => {
    fetchJobsMock.mockResolvedValue([
      job({ id: 5, citationId: 99, status: 'queued' }),
      job({ id: 4, citationId: 12, status: 'completed' }),
    ]);

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('paperExtraction.replacePdf')).toBeInTheDocument(),
    );
  });

  it('hides replacement while the job is still open', async () => {
    // Swapping the bytes under a claimed run races the reader; under a queued
    // one it silently changes what was queued. Cancel first, then replace.
    for (const status of ['queued', 'claimed'] as const) {
      fetchJobsMock.mockResolvedValue([job({ status })]);
      const { unmount } = renderPage();
      await waitFor(() =>
        expect(screen.getByText('paperExtraction.cancel')).toBeInTheDocument(),
      );
      expect(screen.queryByText('paperExtraction.replacePdf')).toBeNull();
      unmount();
    }
  });

  it('surfaces the failure reason so an editor can act on it', async () => {
    fetchJobsMock.mockResolvedValue([
      job({
        status: 'failed',
        lastError: 'stored_pdf_unreadable_or_image_only',
        attempts: 3,
      }),
    ]);

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/stored_pdf_unreadable_or_image_only/),
      ).toBeInTheDocument(),
    );
  });

  it('cancels a job through the API and reflects the new status', async () => {
    fetchJobsMock.mockResolvedValue([job()]);
    updateJobMock.mockResolvedValue(job({ status: 'cancelled' }));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('paperExtraction.cancel')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('paperExtraction.cancel'));

    await waitFor(() =>
      expect(updateJobMock).toHaveBeenCalledWith(5, { action: 'cancel' }),
    );
    await waitFor(() =>
      expect(
        screen.getByText('paperExtraction.status.cancelled'),
      ).toBeInTheDocument(),
    );
  });

  it('walks the editor through identify → upload → queue', async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('paperExtraction.stepIdentify'),
      ).toBeInTheDocument(),
    );

    // Upload and queue steps stay hidden until a paper has been identified —
    // there is nothing to attach bytes to before that.
    expect(screen.queryByText('paperExtraction.stepUpload')).toBeNull();
    expect(screen.queryByText('paperExtraction.stepQueue')).toBeNull();

    // Only retrievable identifier tabs are offered: the agent has to fetch and
    // read the paper, which a free-text citation makes impossible.
    expect(screen.queryByText('references.tabText')).toBeNull();
    expect(screen.getByText('references.tabPmid')).toBeInTheDocument();
    expect(screen.getByText('references.tabDoi')).toBeInTheDocument();
  });
});
