import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PendingBadge } from '@/components/PendingBadge';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEditCount } from '@/lib/pendingEditsApi';
import { fetchOpenPdfRequestCount } from '@/lib/referencesApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.count ? `${key} ${values.count}` : key),
  }),
}));

vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEditCount: vi.fn(),
}));

vi.mock('@/lib/referencesApi', () => ({
  fetchOpenPdfRequestCount: vi.fn(),
}));

function setUserWithRole(role: string) {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role,
      displayName: null,
      enabledConcentrationUnits: ['mg/L', 'ng/mL'],
      notificationSettings: null,
      favoriteParameters: [],
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

function setEditorUser() {
  setUserWithRole('editor');
}

describe('PendingBadge', () => {
  const originalAuthState = useAuthStore.getState();
  const countMock = vi.mocked(fetchPendingEditCount);
  const pdfCountMock = vi.mocked(fetchOpenPdfRequestCount);

  beforeEach(() => {
    countMock.mockReset();
    // Default the PDF-request count to 0 so existing assertions see the
    // pending count alone; the sum test overrides it.
    pdfCountMock.mockReset();
    pdfCountMock.mockResolvedValue(0);
    setEditorUser();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAuthStore.setState(originalAuthState);
  });

  async function renderBadge() {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <MemoryRouter>
          <PendingBadge />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    return result;
  }

  it('uses an unknown label when the pending count cannot load', async () => {
    countMock.mockRejectedValueOnce(new Error('network unavailable'));

    await renderBadge();

    await waitFor(() => expect(countMock).toHaveBeenCalled());
    expect(screen.getByLabelText('nav.reviewNotificationsUnknown')).toBeTruthy();
  });

  it('uses the empty label only after a successful zero count', async () => {
    countMock.mockResolvedValueOnce({ count: 0 });

    await renderBadge();

    expect(await screen.findByLabelText('nav.reviewNotifications')).toBeTruthy();
  });

  it('shows the count after a successful positive count', async () => {
    countMock.mockResolvedValueOnce({ count: 3 });

    await renderBadge();

    expect(await screen.findByLabelText('nav.reviewNotificationsCount 3')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('sums open PDF requests into the badge count', async () => {
    countMock.mockResolvedValueOnce({ count: 2 });
    pdfCountMock.mockResolvedValueOnce(3);

    await renderBadge();

    expect(await screen.findByLabelText('nav.reviewNotificationsCount 5')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('still shows the pending count when open PDF requests fail to load', async () => {
    countMock.mockResolvedValueOnce({ count: 4 });
    // fetchOpenPdfRequestCount swallows its own errors and resolves to 0, so a
    // PDF-count outage must never blank the pending count.
    pdfCountMock.mockResolvedValueOnce(0);

    await renderBadge();

    expect(await screen.findByLabelText('nav.reviewNotificationsCount 4')).toBeTruthy();
  });

  it('renders for contributors so they can reach the review queue', async () => {
    setUserWithRole('contributor');
    countMock.mockResolvedValueOnce({ count: 2 });

    const { container } = await renderBadge();

    await waitFor(() => expect(countMock).toHaveBeenCalled());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/review');
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('follows a delegated capability rather than the role rank', async () => {
    // An admin who lowers PDF fulfilment to `authenticated` gives those users
    // a queue to act on, so the badge that navigates there must appear.
    setUserWithRole('authenticated');
    useAuthStore.setState({
      permissionOverrides: { 'citation.pdf.access': 'authenticated' },
    });
    countMock.mockResolvedValueOnce({ count: 0 });
    pdfCountMock.mockResolvedValueOnce(2);

    const { container } = await renderBadge();

    await waitFor(() => expect(pdfCountMock).toHaveBeenCalled());
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/review');
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('renders nothing for authenticated users who cannot contribute', async () => {
    setUserWithRole('authenticated');

    const { container } = await renderBadge();

    expect(countMock).not.toHaveBeenCalled();
    expect(container.querySelector('a')).toBeNull();
  });

  it('backs off polling when there are no pending edits', async () => {
    vi.useFakeTimers();
    countMock.mockResolvedValue({ count: 0 });

    await renderBadge();

    expect(countMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(countMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
    });
    expect(countMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the faster polling cadence when pending edits exist', async () => {
    vi.useFakeTimers();
    countMock.mockResolvedValue({ count: 2 });

    await renderBadge();

    expect(countMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(countMock).toHaveBeenCalledTimes(2);
  });

  it('pauses polling while the tab is hidden and refreshes when visible', async () => {
    vi.useFakeTimers();
    countMock.mockResolvedValue({ count: 0 });
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get');
    visibilitySpy.mockReturnValue('hidden');

    await renderBadge();

    expect(countMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(countMock).toHaveBeenCalledTimes(1);

    visibilitySpy.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(countMock).toHaveBeenCalledTimes(2);
  });
});
