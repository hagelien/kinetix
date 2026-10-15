/**
 * Approving a wiki_new proposal that creates its drug runs the same PubChem
 * CID shadow check as POST /api/drugs, and the refusal arrives as a 409 with
 * the stable code `pubchem_cid_shadows_drug_id`. The card must map it through
 * REVIEW_ERROR_KEYS rather than show the API's English prose.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

// A reviewer (admin, id 1) looking at someone else's proposal, so approve is
// on offer.
const authState = {
  user: { id: 1, role: 'admin', username: 'mod', displayName: null },
  permissionOverrides: {},
  isAuthenticated: true,
  isLoading: false,
};
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

const { reviewPendingEdit, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | null;
    constructor(message: string, status: number, code: string | null) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { reviewPendingEdit: vi.fn(), ApiError };
});
vi.mock('@/lib/pendingEditsApi', () => ({
  reviewPendingEdit,
  updatePendingEdit: vi.fn(),
  cancelPendingEdit: vi.fn(),
  ApiError,
}));

vi.mock('@/lib/agentVerificationsApi', () => ({
  fetchVerificationsForTarget: vi.fn(() =>
    Promise.resolve({ verifications: [] }),
  ),
}));

function wikiNewEdit(): PendingEditRow {
  return {
    id: 51,
    editType: 'wiki_new',
    targetId: null,
    parameter: null,
    proposedValue: { type: 'doc', content: [] },
    proposedMeta: {
      title: 'Testolin',
      pageType: 'drug_monograph',
      newDrug: { names: { nb: 'Testolin' }, pubchemCid: 12 },
    },
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
    sectionId: null,
    fieldId: null,
    submitter: { id: 7, username: 'author', displayName: null },
    references: [],
  } as PendingEditRow;
}

async function approveAndFail(err: Error) {
  reviewPendingEdit.mockRejectedValue(err);
  render(
    <MemoryRouter>
      <PendingEditCard edit={wikiNewEdit()} onReviewed={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /review.approve/ }));
  await waitFor(() => expect(reviewPendingEdit).toHaveBeenCalled());
}

describe('PendingEditCard — PubChem CID shadow refusal', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the localized message for pubchem_cid_shadows_drug_id', async () => {
    await approveAndFail(
      new ApiError(
        'PubChem CID 12 is also the internal id of drug 12, and saved cases key that drug by this number',
        409,
        'pubchem_cid_shadows_drug_id',
      ),
    );

    expect(
      await screen.findByText('errors.pubchemCidShadowsDrugId'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal id of drug/)).not.toBeInTheDocument();
  });

  it('falls back to the server message for a code it does not map', async () => {
    await approveAndFail(new ApiError('Some other refusal', 409, 'something_else'));

    expect(await screen.findByText('Some other refusal')).toBeInTheDocument();
  });
});
