import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingEditCard } from './PendingEditCard';
import { ApiError, type PendingEditRow } from '@/lib/pendingEditsApi';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

// The case this panel exists for: the author of the edit is also the moderator
// looking at it (admin), so approving is blocked by the open dispute until
// they rule on it.
const authState = {
  user: { id: 7, role: 'admin', username: 'max', displayName: 'Max' },
  isAuthenticated: true,
  isLoading: false,
  permissionOverrides: {},
};
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

vi.mock('@/lib/agentVerificationsApi', () => ({
  fetchVerificationsForTarget: vi.fn(() =>
    Promise.resolve({ verifications: [] }),
  ),
}));

const { fetchDisputesForTarget, resolveDispute } = vi.hoisted(() => ({
  fetchDisputesForTarget: vi.fn(),
  resolveDispute: vi.fn(),
}));
vi.mock('@/lib/disputesApi', () => ({
  fetchDisputesForTarget,
  resolveDispute,
}));

function makeEdit(overrides: Partial<PendingEditRow> = {}): PendingEditRow {
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
    submittedAt: '2026-08-10T08:00:00Z',
    reviewedAt: null,
    reviewToken: 'token',
    sectionId: 'pk',
    fieldId: null,
    factStatement: 'Aceton er mindre sensitivt enn BHB.',
    factOperation: 'add',
    factTargetAnchor: null,
    submitter: { id: 7, username: 'max', displayName: 'Max' },
    references: [],
    pageTitle: 'Aceton',
    pageSlug: 'aceton',
    hasOpenDispute: true,
    verifications: {
      approveCount: 0,
      disputeCount: 1,
      abstainCount: 0,
      implicitApproveCount: 0,
    },
    ...overrides,
  };
}

function agentDispute() {
  return {
    id: 3,
    targetType: 'pending_edit' as const,
    targetId: 42,
    source: 'agent' as const,
    reasonMd: 'Begge kildene er merket som ikke lest i fulltekst.',
    evidenceRefs: [{ citationId: 887 }],
    status: 'open',
    createdAt: '2026-08-11T06:25:36Z',
    updatedAt: '2026-08-11T06:25:36Z',
    createdBy: 99,
    author: {
      id: 99,
      name: 'Kinetix vedlikeholdsagent',
      role: 'contributor',
      agentSlug: 'codex-agent',
    },
  };
}

describe('PendingEditCard dispute panel', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows the objection and rules on it', async () => {
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });
    resolveDispute.mockResolvedValue({ id: 3, resolution: 'rejected' });
    const onReviewed = vi.fn();

    render(
      <MemoryRouter>
        <PendingEditCard edit={makeEdit()} onReviewed={onReviewed} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        'Begge kildene er merket som ikke lest i fulltekst.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'review.dispute.overrule' }),
    );

    await waitFor(() =>
      expect(resolveDispute).toHaveBeenCalledWith(3, 'rejected'),
    );
    // The queue reloads so the approve button stops being refused.
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Begge kildene er merket som ikke lest i fulltekst.',
        ),
      ).not.toBeInTheDocument(),
    );
  });

  // Codex P1 (review comment 4064447909): upholding the last open objection
  // empties the list, and the panel used to unmount on that — swallowing the
  // one message that says the proposal did NOT go back to its author. The
  // moderator would watch the dispute disappear and read it as handled while
  // the edit sat pending with nobody told.
  it('keeps the skipped-return warning after the last objection closes', async () => {
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });
    resolveDispute.mockResolvedValue({
      id: 3,
      resolution: 'upheld',
      pendingEditReturned: false,
      pendingEditReturnSkipped: 'not_open',
    });

    render(
      <MemoryRouter>
        <PendingEditCard edit={makeEdit()} onReviewed={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'review.dispute.uphold' }),
    );

    await waitFor(() =>
      expect(resolveDispute).toHaveBeenCalledWith(3, 'upheld'),
    );
    // The objection is gone from the list, but the warning it produced is not.
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Begge kildene er merket som ikke lest i fulltekst.',
        ),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('review.dispute.upheldReturnSkipped'),
    ).toBeInTheDocument();
  });

  // A clean uphold says nothing extra: the panel closes with the objection.
  it('closes quietly when the proposal was returned', async () => {
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });
    resolveDispute.mockResolvedValue({
      id: 3,
      resolution: 'upheld',
      pendingEditReturned: true,
    });

    render(
      <MemoryRouter>
        <PendingEditCard edit={makeEdit()} onReviewed={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'review.dispute.uphold' }),
    );

    await waitFor(() =>
      expect(resolveDispute).toHaveBeenCalledWith(3, 'upheld'),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('review.dispute.upheldReturnSkipped'),
      ).not.toBeInTheDocument(),
    );
  });

  // /review refreshes in place, so the card survives a decision with the same
  // id. A panel keyed on the id alone would never see the agent's next
  // objection — it would sit there showing the rows it emptied, with nothing
  // to act on until a full reload.
  it('refetches when the edit is disputed again', async () => {
    fetchDisputesForTarget.mockResolvedValue({ disputes: [] });
    const decided = makeEdit({
      hasOpenDispute: false,
      verifications: {
        approveCount: 0,
        disputeCount: 1,
        abstainCount: 0,
        implicitApproveCount: 0,
        unresolvedDisputeCount: 0,
      },
    });

    const { rerender } = render(
      <MemoryRouter>
        <PendingEditCard edit={decided} onReviewed={vi.fn()} />
      </MemoryRouter>,
    );
    // Nothing is contesting it, so the panel is absent and asks for nothing.
    expect(fetchDisputesForTarget).not.toHaveBeenCalled();

    // The agent disputes it again; the refreshed row says so.
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });
    rerender(
      <MemoryRouter>
        <PendingEditCard
          edit={{
            ...decided,
            hasOpenDispute: true,
            verifications: {
              ...decided.verifications!,
              unresolvedDisputeCount: 1,
            },
          }}
          onReviewed={vi.fn()}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(fetchDisputesForTarget).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByRole('button', { name: 'review.dispute.overrule' }),
    ).toBeInTheDocument();
  });

  it('offers no resolve controls to a caller who cannot resolve disputes', async () => {
    authState.user.role = 'contributor';
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });

    render(
      <MemoryRouter>
        <PendingEditCard edit={makeEdit()} onReviewed={vi.fn()} />
      </MemoryRouter>,
    );

    // The reason is still readable — being blocked without being told why was
    // half the problem — but the buttons belong to a moderator.
    expect(
      await screen.findByText(
        'Begge kildene er merket som ikke lest i fulltekst.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'review.dispute.overrule' }),
    ).not.toBeInTheDocument();
    authState.user.role = 'admin';
  });

  it('stays out of the way when nothing contests the edit', async () => {
    render(
      <MemoryRouter>
        <PendingEditCard
          edit={makeEdit({
            hasOpenDispute: false,
            verifications: {
              approveCount: 2,
              disputeCount: 0,
              abstainCount: 0,
              implicitApproveCount: 0,
            },
          })}
          onReviewed={vi.fn()}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDisputesForTarget).not.toHaveBeenCalled());
  });
});

describe('PendingEditCard upheld dispute', () => {
  afterEach(() => vi.clearAllMocks());

  // Upholding closes the dispute but does not clear the proposal, so the
  // author's own approve button goes away and the card says why.
  it('withholds self-approval and explains the standing ruling', async () => {
    render(
      <MemoryRouter>
        <PendingEditCard
          edit={makeEdit({ hasOpenDispute: false, disputeUpheld: true })}
          onReviewed={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('review.dispute.upheldStanding'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /review.approve/ }),
    ).not.toBeInTheDocument();
    // Returning it is the disposition the ruling points at; it stays offered.
    expect(
      screen.getByRole('button', { name: /review.returnForRevision/ }),
    ).toBeInTheDocument();
  });

  it('localizes a failed resolution instead of showing the server prose', async () => {
    fetchDisputesForTarget.mockResolvedValue({ disputes: [agentDispute()] });
    resolveDispute.mockRejectedValue(
      new ApiError('Open dispute not found', 404, 'disputes_not_found'),
    );

    render(
      <MemoryRouter>
        <PendingEditCard edit={makeEdit()} onReviewed={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'review.dispute.overrule' }),
    );

    expect(
      await screen.findByText('review.dispute.alreadyClosed'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Open dispute not found'),
    ).not.toBeInTheDocument();
  });
});

// A verdict cannot be closed, so the raw tally never falls. Ranking and
// badging off it left an overruled edit pinned to the top of /review under a
// red "Bestridt" with no way to ever clear it.
describe('PendingEditCard verification badges', () => {
  afterEach(() => vi.clearAllMocks());

  function badges(unresolvedDisputeCount?: number) {
    render(
      <MemoryRouter>
        <PendingEditCard
          edit={makeEdit({
            hasOpenDispute: false,
            verifications: {
              approveCount: 0,
              disputeCount: 1,
              abstainCount: 0,
              implicitApproveCount: 0,
              ...(unresolvedDisputeCount === undefined
                ? {}
                : { unresolvedDisputeCount }),
            },
          })}
          onReviewed={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('reads a ruled-on verdict as decided, not as a standing objection', () => {
    badges(0);
    expect(
      screen.getByText('review.verification.disputeDecided'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('review.verification.dispute'),
    ).not.toBeInTheDocument();
  });

  it('still shows an undecided objection in red', () => {
    badges(1);
    expect(screen.getByText('review.verification.dispute')).toBeInTheDocument();
    expect(
      screen.queryByText('review.verification.disputeDecided'),
    ).not.toBeInTheDocument();
  });

  it('falls back to the raw tally when the server does not send the field', () => {
    // An older response has no `unresolvedDisputeCount`; treating that as zero
    // would hide a live objection, so the raw count wins.
    badges(undefined);
    expect(screen.getByText('review.verification.dispute')).toBeInTheDocument();
  });
});

// The panel's strings are looked up by path, so a key that exists in both
// languages but under the wrong parent renders as the raw i18next key — which
// locale *parity* cannot catch, since the mistake is symmetric. Pin the paths
// the component actually asks for.
describe('dispute panel translations', () => {
  const keys = [
    'heading_one',
    'heading_other',
    'moderatorHint',
    'readerHint',
    'sourceAgent',
    'sourceHuman',
    'unknownAuthor',
    'noReason',
    'uphold',
    'upheldHint',
    'overrule',
    'overruleHint',
    'withdraw',
    'failed',
    'alreadyClosed',
    'forbidden',
    'upheldStanding',
  ];

  it.each(keys)('resolves review.dispute.%s in both languages', (key) => {
    for (const [lang, bundle] of [
      ['en', en],
      ['nb', nb],
    ] as const) {
      const value = (
        bundle as unknown as {
          review: { dispute: Record<string, string | undefined> };
        }
      ).review.dispute[key];
      expect(value, `review.dispute.${key} missing from ${lang}.json`).toEqual(
        expect.any(String),
      );
    }
  });

  it.each(['dispute_one', 'disputeDecided_one', 'disputeDecided_other'])(
    'resolves review.verification.%s in both languages',
    (key) => {
      for (const bundle of [en, nb]) {
        const value = (
          bundle as unknown as {
            review: { verification: Record<string, string | undefined> };
          }
        ).review.verification[key];
        expect(value).toEqual(expect.any(String));
      }
    },
  );

  it.each(['selfApprovalUpheld', 'selfDecisionDisputed'])(
    'resolves review.errors.%s in both languages',
    (key) => {
      for (const bundle of [en, nb]) {
        const value = (
          bundle as unknown as {
            review: { errors: Record<string, string | undefined> };
          }
        ).review.errors[key];
        expect(value).toEqual(expect.any(String));
      }
    },
  );
});
