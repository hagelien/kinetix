import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import { useAuthStore } from '@/stores/authStore';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import type { AuthUser } from '@/stores/authStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

vi.mock('@/lib/agentVerificationsApi', () => ({
  fetchVerificationsForTarget: vi.fn().mockResolvedValue({ verifications: [] }),
}));

const SELF_ID = 7;

function user(role: string): AuthUser {
  return {
    id: SELF_ID,
    email: 'reviewer@example.com',
    username: 'reviewer',
    role,
    displayName: null,
    enabledConcentrationUnits: ['ng/mL'],
    notificationSettings: null,
  } as AuthUser;
}

function ownEdit(): PendingEditRow {
  return {
    id: 17,
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
    submittedBy: SELF_ID,
    reviewedBy: null,
    submittedAt: '2026-06-17T08:00:00Z',
    reviewedAt: null,
    reviewToken: 'token',
    sectionId: 'pk',
    fieldId: null,
    factStatement: 'iPMR builds on five substance properties.',
    factOperation: 'remove',
    factTargetAnchor: null,
    submitter: { id: SELF_ID, username: 'reviewer', displayName: null },
    references: [],
    pageTitle: 'iPMR',
    pageSlug: 'ipmr',
  } as PendingEditRow;
}

function renderCard() {
  render(
    <MemoryRouter>
      <PendingEditCard edit={ownEdit()} onReviewed={() => {}} />
    </MemoryRouter>,
  );
}

describe('PendingEditCard — deciding on your own proposal', () => {
  const initial = useAuthStore.getState();

  beforeEach(() => {
    useAuthStore.setState({ permissionOverrides: {} });
  });

  afterEach(() => {
    useAuthStore.setState(initial, true);
  });

  // The default: an editor may moderate the queue but not their own card, so
  // the only thing on offer is withdrawing the proposal.
  it('hides approve and return from an editor looking at their own edit', () => {
    useAuthStore.setState({ user: user('editor') });
    renderCard();

    expect(screen.queryByRole('button', { name: /review.approve/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /review.returnForRevision/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /review.cancelSuggestion/ }),
    ).toBeInTheDocument();
  });

  // review.edit.decideOwn defaults to admin, so an admin gets the same
  // controls on their own proposal that they have on anyone else's.
  it('offers approve and return to an admin on their own edit', () => {
    useAuthStore.setState({ user: user('admin') });
    renderCard();

    expect(
      screen.getByRole('button', { name: /review.approve/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /review.returnForRevision/ }),
    ).toBeInTheDocument();
    // Withdrawing is still the submitter's own path, and "reject" would be a
    // second button meaning the same thing, so it stays off the own card.
    expect(screen.queryByRole('button', { name: /review.reject/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /review.cancelSuggestion/ }),
    ).toBeInTheDocument();
  });

  // The matrix is adjustable: an admin who lowers the capability to `editor`
  // gets the affordance for editors too, in the same breath as the endpoint.
  it('follows a permission override that lowers the capability to editor', () => {
    useAuthStore.setState({
      user: user('editor'),
      permissionOverrides: { 'review.edit.decideOwn': 'editor' },
    });
    renderCard();

    expect(
      screen.getByRole('button', { name: /review.approve/ }),
    ).toBeInTheDocument();
  });
});
