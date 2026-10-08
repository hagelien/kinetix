import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminPage } from './AdminPage';
import { useAuthStore } from '@/stores/authStore';
import { fetchOpenDisputes } from '@/lib/disputesApi';
import { fetchHiddenNavItems } from '@/lib/navVisibilityApi';

/**
 * Regression coverage for PR #1299's P1 finding (review comment
 * 4059719437): the dispute queue must be reachable by a caller who holds
 * only `dispute.queue.read` (editor default) and not `admin.panel.access`
 * (admin default) — the moderators the on-demand digest emails, and the
 * same population `GET /api/disputes` already lets read the backlog.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock('@/lib/disputesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/disputesApi')>();
  return { ...actual, fetchOpenDisputes: vi.fn() };
});

vi.mock('@/lib/navVisibilityApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/navVisibilityApi')>();
  return { ...actual, fetchHiddenNavItems: vi.fn() };
});

const fetchOpenDisputesMock = vi.mocked(fetchOpenDisputes);
const fetchHiddenNavItemsMock = vi.mocked(fetchHiddenNavItems);

function setAuthState(state: Partial<ReturnType<typeof useAuthStore.getState>>) {
  useAuthStore.setState({ ...useAuthStore.getState(), ...state });
}

function makeUser(role: string) {
  return {
    id: 1,
    email: 'mod@example.org',
    username: 'mod',
    role,
    displayName: null,
    enabledConcentrationUnits: ['µmol/L', 'mg/L'],
    notificationSettings: null,
    favoriteParameters: [],
  };
}

describe('AdminPage capability gating (#1233 / PR #1299 P1)', () => {
  const originalState = useAuthStore.getState();

  beforeEach(() => {
    fetchOpenDisputesMock.mockReset();
    fetchOpenDisputesMock.mockResolvedValue({ disputes: [] });
    fetchHiddenNavItemsMock.mockReset();
    fetchHiddenNavItemsMock.mockResolvedValue({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
  });

  afterEach(() => {
    useAuthStore.setState(originalState);
    vi.clearAllMocks();
  });

  it('lets an editor with only dispute.queue.read reach and select the Disputes pane', async () => {
    setAuthState({
      user: makeUser('editor'),
      isAuthenticated: true,
      isLoading: false,
    });

    // An editor may also hold other editor-default panes (e.g. content), so
    // this navigates straight to `?pane=disputes` — the same param the
    // dispute digest's CTA now links to — to pin that an editor can both see
    // and select the Disputes tab, not just that /admin doesn't 403 them.
    render(
      <MemoryRouter initialEntries={['/admin?pane=disputes']}>
        <AdminPage />
      </MemoryRouter>,
    );

    // Not the route-level access-denied guard (the AuthGuard fix under test).
    expect(screen.queryByText('auth.accessDenied')).toBeNull();

    const disputesTab = screen.getByRole('tab', { name: 'admin.panes.disputes' });
    expect(disputesTab).toHaveAttribute('aria-selected', 'true');

    // And the pane's own section actually renders, not a blank pane.
    await waitFor(() => {
      expect(fetchOpenDisputesMock).toHaveBeenCalled();
    });
  });

  it('lets an admin reach and select the Menu visibility pane (#1240)', async () => {
    setAuthState({
      user: makeUser('admin'),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/admin?pane=navVisibility']}>
        <AdminPage />
      </MemoryRouter>,
    );

    const pane = screen.getByRole('tab', {
      name: 'admin.panes.navVisibility',
    });
    expect(pane).toHaveAttribute('aria-selected', 'true');

    await waitFor(() => {
      expect(fetchHiddenNavItemsMock).toHaveBeenCalled();
    });
  });

  it('lets an editor delegated only admin.navVisibility.manage reach the route (Codex P1, review comment 4062137140)', async () => {
    // admin.navVisibility.manage defaults to the admin tier, so this only
    // exercises the delegated case when it's explicitly lowered — the same
    // shape as the dispute.queue.read regression above, but for a capability
    // whose *default* tier does not already clear the route-level guard.
    setAuthState({
      user: makeUser('editor'),
      isAuthenticated: true,
      isLoading: false,
      permissionOverrides: { 'admin.navVisibility.manage': 'editor' },
    });

    render(
      <MemoryRouter initialEntries={['/admin?pane=navVisibility']}>
        <AdminPage />
      </MemoryRouter>,
    );

    // Not the route-level access-denied guard — this is what regressed
    // without admin.navVisibility.manage in AuthGuard's requiredAnyCapability.
    expect(screen.queryByText('auth.accessDenied')).toBeNull();

    const pane = screen.getByRole('tab', {
      name: 'admin.panes.navVisibility',
    });
    expect(pane).toHaveAttribute('aria-selected', 'true');

    await waitFor(() => {
      expect(fetchHiddenNavItemsMock).toHaveBeenCalled();
    });
  });

  it('lets an editor delegated only citation.merge reach the Merge pane (Codex P1, review comment 4215789774)', () => {
    setAuthState({
      user: makeUser('editor'),
      isAuthenticated: true,
      isLoading: false,
      permissionOverrides: { 'citation.merge': 'editor' },
    });

    render(
      <MemoryRouter initialEntries={['/admin?pane=merge']}>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText('auth.accessDenied')).toBeNull();
    const pane = screen.getByRole('tab', { name: 'admin.panes.merge' });
    expect(pane).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('admin.citationMerge.title')).toBeInTheDocument();
    // The drug merge stays with its own capability.
    expect(screen.queryByText('admin.drugMerge.title')).toBeNull();
  });

  it('still denies /admin to a contributor with neither capability', () => {
    setAuthState({
      user: makeUser('contributor'),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('auth.accessDenied')).toBeInTheDocument();
    expect(fetchOpenDisputesMock).not.toHaveBeenCalled();
  });
});
