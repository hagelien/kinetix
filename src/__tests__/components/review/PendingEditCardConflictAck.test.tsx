import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import { useAuthStore } from '@/stores/authStore';
import { cancelPendingEdit, updatePendingEdit } from '@/lib/pendingEditsApi';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import type { AuthUser } from '@/stores/authStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

vi.mock('@/lib/pendingEditsApi', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/pendingEditsApi')
  >('@/lib/pendingEditsApi');
  return {
    ...actual,
    updatePendingEdit: vi.fn().mockResolvedValue({}),
    cancelPendingEdit: vi.fn().mockResolvedValue(undefined),
  };
});

const SELF_ID = 7;

function author(): AuthUser {
  return {
    id: SELF_ID,
    email: 'author@example.com',
    username: 'author',
    role: 'admin',
    displayName: null,
    enabledConcentrationUnits: ['ng/mL'],
    notificationSettings: null,
  } as AuthUser;
}

// A `param_entry` update marked conflicted by a direct admin write
// (#1258/#1293). `currentEntry` is present when the marker's target still
// exists and undefined when it was deleted out from under the proposal.
function conflictedEdit(currentEntry: PendingEditRow['currentEntry']): PendingEditRow {
  return {
    id: 99,
    editType: 'param_entry',
    targetId: 501,
    parameter: 'tmax',
    proposedValue: { op: 'update', patch: { median: 3.25, unit: 'h' } },
    proposedMeta: { conflict: { reason: 'direct_admin_write', id: 'marker-1' } },
    referenceId: null,
    referenceIds: null,
    status: 'returned',
    rejectionReason: 'other',
    rejectionComment: 'Please double-check the source.',
    submittedBy: SELF_ID,
    reviewedBy: null,
    submittedAt: '2026-09-19T08:00:00Z',
    reviewedAt: null,
    reviewToken: 'token',
    submitter: { id: SELF_ID, username: 'author', displayName: null },
    references: [],
    currentEntry,
  } as PendingEditRow;
}

describe('PendingEditCard — revising a direct_admin_write conflict', () => {
  const initial = useAuthStore.getState();

  beforeEach(() => {
    useAuthStore.setState({ user: author(), permissionOverrides: {} });
    vi.mocked(updatePendingEdit).mockClear();
    vi.mocked(cancelPendingEdit).mockClear();
  });

  afterEach(() => {
    useAuthStore.setState(initial, true);
  });

  it('shows the live entry and acknowledges the marker when the entry still exists', async () => {
    render(
      <MemoryRouter>
        <PendingEditCard
          edit={conflictedEdit({
            id: 501,
            parameter: 'tmax',
            low: null,
            high: null,
            median: 2,
            qualifier: null,
            categoricalValue: null,
            unit: 'h',
            route: 'oral',
            matrix: null,
            scenario: null,
            n: null,
            comments: null,
            observationContext: null,
            sourceQuote: null,
            citationId: null,
            citation: null,
          } as never)}
          onReviewed={() => {}}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /editAndResubmit/i }));
    expect(
      screen.getByText(/changed directly since you last edited it/),
    ).toBeInTheDocument();

    // The revise submit button only enables once the JSON payload changes.
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{"op":"update","patch":{"median":3.5,"unit":"h"}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^review.updateAndResubmit$/ }));

    expect(updatePendingEdit).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ acknowledgedConflictId: 'marker-1' }),
    );
  });

  it('hides the bare resubmit action when the entry was deleted (#1353)', async () => {
    // A bare resubmit PATCHes the unchanged proposal straight back to
    // `pending`, which the server's `param_entry_target_missing` check always
    // refuses once the target is gone — so it must not be offered as an
    // alternative to the revise dialog's withdraw-only path.
    render(
      <MemoryRouter>
        <PendingEditCard edit={conflictedEdit(undefined)} onReviewed={() => {}} />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole('button', { name: /^review.resubmit$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /editAndResubmit/i }),
    ).toBeInTheDocument();
  });

  it('offers the bare resubmit action when the entry still exists', async () => {
    render(
      <MemoryRouter>
        <PendingEditCard
          edit={conflictedEdit({
            id: 501,
            parameter: 'tmax',
            low: null,
            high: null,
            median: 2,
            qualifier: null,
            categoricalValue: null,
            unit: 'h',
            route: 'oral',
            matrix: null,
            scenario: null,
            n: null,
            comments: null,
            observationContext: null,
            sourceQuote: null,
            citationId: null,
            citation: null,
          } as never)}
          onReviewed={() => {}}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('button', { name: /^review.resubmit$/ }),
    ).toBeInTheDocument();
  });

  it('offers withdrawal instead of a JSON editor when the entry was deleted (#1295)', async () => {
    render(
      <MemoryRouter>
        <PendingEditCard edit={conflictedEdit(undefined)} onReviewed={() => {}} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /editAndResubmit/i }));
    expect(
      screen.getByText(/deleted directly since you last edited it/),
    ).toBeInTheDocument();
    // The stale live-entry panel never renders when there's nothing to show.
    expect(
      screen.queryByText(/changed directly since you last edited it/),
    ).not.toBeInTheDocument();

    // There is no live row left to revise against, so a resubmission would
    // always fail approval — no JSON editor, and no way to send an
    // acknowledgement that could clear the marker without fixing anything.
    const dialog = screen.getByRole('dialog', {
      name: /reviseReturnedEdit/i,
    });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', {
        name: /^review.updateAndResubmit$/,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole('button', { name: /^review.cancelSuggestion$/ }),
    );

    expect(cancelPendingEdit).toHaveBeenCalledWith(99);
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });
});
