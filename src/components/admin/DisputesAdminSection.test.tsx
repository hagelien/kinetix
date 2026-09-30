import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisputesAdminSection } from './DisputesAdminSection';
import {
  fetchOpenDisputes,
  resolveDispute,
  type DisputeRow,
} from '@/lib/disputesApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}));

vi.mock('@/lib/disputesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/disputesApi')>();
  return { ...actual, fetchOpenDisputes: vi.fn(), resolveDispute: vi.fn() };
});

// canResolveMock lets each test opt an editor/admin viewer in or out of
// `dispute.resolve`, independent of the real capability matrix.
const { canResolveMock } = vi.hoisted(() => ({ canResolveMock: vi.fn() }));
vi.mock('@/lib/usePermissions', () => ({ useCan: () => canResolveMock() }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => undefined,
}));

const fetchOpenDisputesMock = vi.mocked(fetchOpenDisputes);
const resolveDisputeMock = vi.mocked(resolveDispute);

function makeRow(overrides: Partial<DisputeRow> & { id: number }): DisputeRow {
  return {
    targetType: 'pending_edit',
    targetId: 100 + overrides.id,
    source: 'human',
    reasonMd: 'Something is wrong with this value',
    evidenceRefs: [],
    status: 'open',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 1,
    author: { id: 1, name: 'Alice Reviewer', role: 'editor', agentSlug: null },
    ...overrides,
  };
}

describe('DisputesAdminSection', () => {
  beforeEach(() => {
    fetchOpenDisputesMock.mockReset();
    resolveDisputeMock.mockReset();
    canResolveMock.mockReset();
    canResolveMock.mockReturnValue(false);
  });

  it('shows the empty state when there are no open disputes', async () => {
    fetchOpenDisputesMock.mockResolvedValue({ disputes: [] });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(
        screen.getByText('No open disputes. The queue is clear.'),
      ).toBeInTheDocument();
    });
  });

  it('renders open dispute rows with target, source and author', async () => {
    fetchOpenDisputesMock.mockResolvedValue({
      disputes: [
        makeRow({ id: 1, reasonMd: 'Half-life looks wrong for this route' }),
        makeRow({
          id: 2,
          source: 'agent',
          targetType: 'wiki_revision',
          author: { id: 2, name: null, role: null, agentSlug: 'kinetix-agent' },
          reasonMd: 'Conflicting source cited',
        }),
      ],
    });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(
        screen.getByText('Half-life looks wrong for this route'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Conflicting source cited')).toBeInTheDocument();
    expect(screen.getByText('pending_edit #101')).toBeInTheDocument();
    expect(screen.getByText('wiki_revision #102')).toBeInTheDocument();
    expect(fetchOpenDisputesMock).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
    });
  });

  it('shows an error message when the fetch fails', async () => {
    fetchOpenDisputesMock.mockRejectedValue(new Error('boom'));

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('badges a freshly-opened dispute as fresh and a week-old one as overdue', async () => {
    const fresh = makeRow({ id: 1, createdAt: new Date().toISOString() });
    const overdue = makeRow({
      id: 2,
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    fetchOpenDisputesMock.mockResolvedValue({ disputes: [fresh, overdue] });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('Fresh')).toBeInTheDocument();
    });
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  // Regression for PR #1299's P1 finding (review comment 4059719442): the
  // queue previously rendered an inert label for every target type except
  // pending_edit. `resolveDispute` closes a dispute by id alone, so it works
  // the same for any target — this pins that a wiki_revision dispute (one
  // PendingEditCard's DisputePanel never handles) can be closed here too.
  it('resolves a non-pending_edit dispute and removes its row from the queue', async () => {
    canResolveMock.mockReturnValue(true);
    fetchOpenDisputesMock.mockResolvedValue({
      disputes: [
        makeRow({
          id: 7,
          targetType: 'wiki_revision',
          reasonMd: 'Conflicting half-life source',
        }),
      ],
    });
    resolveDisputeMock.mockResolvedValue({ id: 7, resolution: 'upheld' });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('wiki_revision #107')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'review.dispute.uphold' }));

    expect(resolveDisputeMock).toHaveBeenCalledWith(7, 'upheld');
    await waitFor(() => {
      expect(screen.queryByText('wiki_revision #107')).toBeNull();
    });
  });

  // Codex P1 (review comment 4064721853): this queue never loads the target,
  // so a return the server could not make would otherwise vanish with the row
  // — the stranded edit the feature exists to prevent, reintroduced from the
  // one screen with no card to warn on.
  it('warns when an upheld ruling did not return the proposal', async () => {
    canResolveMock.mockReturnValue(true);
    fetchOpenDisputesMock.mockResolvedValue({
      disputes: [makeRow({ id: 9, targetType: 'pending_edit' })],
    });
    resolveDisputeMock.mockResolvedValue({
      id: 9,
      resolution: 'upheld',
      pendingEditReturned: false,
      pendingEditReturnSkipped: 'revised_since',
    });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('pending_edit #109')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'review.dispute.uphold' }));

    await waitFor(() => {
      expect(
        screen.getByText(/was not returned automatically/i),
      ).toBeInTheDocument();
    });
  });

  // A clean uphold stays quiet.
  it('says nothing extra when the proposal was returned', async () => {
    canResolveMock.mockReturnValue(true);
    fetchOpenDisputesMock.mockResolvedValue({
      disputes: [makeRow({ id: 11, targetType: 'pending_edit' })],
    });
    resolveDisputeMock.mockResolvedValue({
      id: 11,
      resolution: 'upheld',
      pendingEditReturned: true,
    });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('pending_edit #111')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'review.dispute.uphold' }));

    await waitFor(() => {
      expect(screen.queryByText('pending_edit #111')).toBeNull();
    });
    expect(
      screen.queryByText(/was not returned automatically/i),
    ).toBeNull();
  });

  it('hides resolve controls from a caller without dispute.resolve', async () => {
    canResolveMock.mockReturnValue(false);
    fetchOpenDisputesMock.mockResolvedValue({
      disputes: [makeRow({ id: 3, targetType: 'wiki_revision' })],
    });

    render(<DisputesAdminSection />);

    await waitFor(() => {
      expect(screen.getByText('wiki_revision #103')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'review.dispute.uphold' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'review.dispute.overrule' }),
    ).toBeNull();
  });
});
