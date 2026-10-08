import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPage } from './ReviewPage';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

// Reviewer viewer (admin, id 1) so the pending edit below — submitted by a
// different user — is approvable.
const authState = {
  user: { id: 1, role: 'admin', username: 'mod', displayName: null },
  isAuthenticated: true,
  isLoading: false,
};
vi.mock('@/stores/authStore', () => ({
  // ReviewPage destructures useAuthStore(); PendingEditCard uses a selector.
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

const { fetchPendingEdits, reviewPendingEdit } = vi.hoisted(() => ({
  fetchPendingEdits: vi.fn(),
  reviewPendingEdit: vi.fn(),
}));
vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEdits,
  reviewPendingEdit,
  updatePendingEdit: vi.fn(),
  cancelPendingEdit: vi.fn(),
  ApiError: class ApiError extends Error {
    code?: string;
  },
}));

vi.mock('@/lib/agentVerificationsApi', () => ({
  fetchVerificationsForTarget: vi.fn(() =>
    Promise.resolve({ verifications: [] }),
  ),
}));

function makeEdit(): PendingEditRow {
  return {
    id: 42,
    editType: 'wiki_fact',
    targetId: 5,
    parameter: null,
    proposedValue: null,
    proposedMeta: null,
    referenceId: null,
    referenceIds: null,
    status: 'pending',
    rejectionReason: null,
    rejectionComment: null,
    submittedBy: 7,
    reviewedBy: null,
    submittedAt: '2026-06-17T08:00:00Z',
    reviewedAt: null,
    reviewToken: 'token',
    sectionId: 'pk',
    fieldId: null,
    factStatement: 'Ethyl glucuronide is formed by glucuronidation.',
    factOperation: 'add',
    factTargetAnchor: null,
    submitter: { id: 7, username: 'agent', displayName: null },
    references: [],
    pageTitle: 'Ethyl glucuronide',
    pageSlug: 'ethyl-glucuronide',
  };
}

describe('ReviewPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('refreshes in place after a review without tearing the list down', async () => {
    const edit = makeEdit();
    // The refresh triggered by approving is held open so we can observe the
    // in-flight state: the list must stay mounted (no loading placeholder),
    // otherwise the page collapses and the scroll jumps back to the top.
    let resolveRefresh: (v: { pendingEdits: PendingEditRow[] }) => void =
      () => {};
    const refresh = new Promise<{ pendingEdits: PendingEditRow[] }>((r) => {
      resolveRefresh = r;
    });
    fetchPendingEdits
      .mockResolvedValueOnce({ pendingEdits: [edit] })
      .mockReturnValueOnce(refresh);
    reviewPendingEdit.mockResolvedValue({});

    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );

    const approve = await screen.findByRole('button', {
      name: 'review.approve',
    });
    expect(screen.getByText('Ethyl glucuronide')).toBeInTheDocument();

    fireEvent.click(approve);

    // Background refresh is in flight (second fetch pending). The list stays
    // rendered and the loading placeholder never appears.
    await waitFor(() => expect(fetchPendingEdits).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('review.loading')).not.toBeInTheDocument();
    expect(screen.getByText('Ethyl glucuronide')).toBeInTheDocument();

    // Once the refresh resolves, the handled edit drops out of the list.
    resolveRefresh({ pendingEdits: [] });
    await waitFor(() =>
      expect(screen.queryByText('Ethyl glucuronide')).not.toBeInTheDocument(),
    );
  });

  it('shows the loading placeholder on the initial load', async () => {
    let resolveInitial: (v: { pendingEdits: PendingEditRow[] }) => void =
      () => {};
    const initial = new Promise<{ pendingEdits: PendingEditRow[] }>((r) => {
      resolveInitial = r;
    });
    fetchPendingEdits.mockReturnValueOnce(initial);

    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('review.loading')).toBeInTheDocument();
    resolveInitial({ pendingEdits: [] });
    await waitFor(() =>
      expect(screen.queryByText('review.loading')).not.toBeInTheDocument(),
    );
  });

  it('keeps the "all" status filter selected for a reviewer', async () => {
    fetchPendingEdits.mockResolvedValue({ pendingEdits: [] });

    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(fetchPendingEdits).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'pending' }),
      ),
    );

    // Two "review.all" buttons: the type filter's, then the status filter's.
    fireEvent.click(screen.getAllByRole('button', { name: 'review.all' })[1]!);

    await waitFor(() =>
      expect(fetchPendingEdits).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'all' }),
      ),
    );
  });

  it('shows a deep-linked edit whatever its status', async () => {
    fetchPendingEdits.mockResolvedValue({ pendingEdits: [] });

    render(
      <MemoryRouter initialEntries={['/review?id=963']}>
        <ReviewPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(fetchPendingEdits).toHaveBeenCalledWith(
        expect.objectContaining({ id: 963, status: 'all' }),
      ),
    );
  });

  it('flags a deep-linked edit that is no longer pending', async () => {
    fetchPendingEdits.mockResolvedValue({
      pendingEdits: [{ ...makeEdit(), status: 'approved' }],
    });

    render(
      <MemoryRouter initialEntries={['/review?id=42']}>
        <ReviewPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'review.linkedEditDecided',
    );
  });
});
