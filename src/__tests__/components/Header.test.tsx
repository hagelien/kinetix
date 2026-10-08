import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '@/components/Header';
import { useAuthStore } from '@/stores/authStore';
import { useDrugStore } from '@/stores/drugStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEditCount: vi.fn(() => new Promise(() => {})),
}));

function setEditorUser() {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'editor',
      displayName: null,
      enabledConcentrationUnits: ['mg/L', 'ng/mL'],
      notificationSettings: null,
      favoriteParameters: [],
    },
    isAuthenticated: true,
    isLoading: false,
    // The baseline for these tests is a fully-settled session — the race
    // between the auth check and the nav-visibility read (#1240 round 3) is
    // exercised on its own further down, by explicitly leaving this false.
    hiddenNavItemsLoaded: true,
  });
}

describe('Header', () => {
  const originalAuthState = useAuthStore.getState();
  const originalDrugState = useDrugStore.getState();

  beforeEach(() => {
    setEditorUser();
    useDrugStore.setState({ tableView: 'collapsed' });
  });

  afterEach(() => {
    useAuthStore.setState(originalAuthState);
    useDrugStore.setState(originalDrugState);
  });

  function renderHeader(path = '/wiki') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Header />
      </MemoryRouter>,
    );
  }

  it('maximizes the drug table when the drug table nav item is clicked', () => {
    renderHeader('/wiki');

    fireEvent.click(screen.getByRole('link', { name: 'nav.drugTable' }));

    expect(useDrugStore.getState().tableView).toBe('full');
  });

  it('does not mutate the current tab table view for modified drug table clicks', () => {
    renderHeader('/wiki');

    fireEvent.click(screen.getByRole('link', { name: 'nav.drugTable' }), {
      ctrlKey: true,
    });

    expect(useDrugStore.getState().tableView).toBe('collapsed');
  });

  it('clears the active drug and shows the sidebar table when the logo is clicked', () => {
    useDrugStore.setState({
      tableView: 'full',
      activeDrug: { id: '1', name: 'Olanzapin' } as never,
    });

    renderHeader('/wiki/olanzapine');

    fireEvent.click(screen.getByRole('link', { name: 'Kinetix' }));

    expect(useDrugStore.getState().activeDrug).toBeNull();
    expect(useDrugStore.getState().tableView).toBe('sidebar');
  });

  it('keeps the active drug for modified logo clicks (open in new tab)', () => {
    useDrugStore.setState({
      tableView: 'collapsed',
      activeDrug: { id: '1', name: 'Olanzapin' } as never,
    });

    renderHeader('/wiki/olanzapine');

    fireEvent.click(screen.getByRole('link', { name: 'Kinetix' }), {
      ctrlKey: true,
    });

    expect(useDrugStore.getState().activeDrug).not.toBeNull();
    expect(useDrugStore.getState().tableView).toBe('collapsed');
  });

  it('renders review access as an icon-only notification indicator', () => {
    renderHeader();

    expect(screen.queryByText('nav.review')).toBeNull();
    expect(
      screen.getByLabelText('nav.reviewNotificationsUnknown'),
    ).toBeTruthy();
  });

  it('does not expose a route-dependent "my changes" link on /wiki (reachable via the review module)', () => {
    renderHeader('/wiki');

    expect(screen.queryByText('nav.myPending')).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'nav.myPending' }),
    ).toBeNull();
  });

  it('hides an admin-hidden nav item from an ordinary user', () => {
    useAuthStore.setState({ hiddenNavItems: ['references'] });

    renderHeader('/wiki');

    expect(
      screen.queryByRole('link', { name: 'nav.references' }),
    ).toBeNull();
  });

  it('still shows an admin-hidden item to an admin, parenthesised', () => {
    useAuthStore.setState({
      hiddenNavItems: ['references'],
      user: {
        id: 1,
        email: 'a@b.com',
        username: 'admin',
        role: 'admin',
        displayName: null,
        enabledConcentrationUnits: ['mg/L', 'ng/mL'],
        notificationSettings: null,
        favoriteParameters: [],
      },
    });

    renderHeader('/wiki');

    expect(
      screen.getByRole('link', { name: '(nav.references)' }),
    ).toBeTruthy();
  });

  it('does not expose a hidden item to a non-admin editor merely delegated admin.panel.access (Codex, review comment 4062402246)', () => {
    // admin.panel.access has an editor floor and is runtime-delegable, so
    // lowering it (unlike a genuine admin role) must not incidentally hand
    // the whole editor tier a view of every deliberately-hidden link.
    useAuthStore.setState({
      hiddenNavItems: ['references'],
      permissionOverrides: { 'admin.panel.access': 'editor' },
    });

    renderHeader('/wiki');

    expect(
      screen.queryByRole('link', { name: '(nav.references)' }),
    ).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'nav.references' }),
    ).toBeNull();
  });

  it('shows a hidden item, parenthesised, to a delegated nav-visibility manager who is not an admin (Codex, review comment 4062402246)', () => {
    // Whoever manages the hidden list needs to see its effect to do that
    // job, independent of whether they also hold the admin role.
    useAuthStore.setState({
      hiddenNavItems: ['references'],
      permissionOverrides: { 'admin.navVisibility.manage': 'editor' },
    });

    renderHeader('/wiki');

    expect(
      screen.getByRole('link', { name: '(nav.references)' }),
    ).toBeTruthy();
  });

  it('shows the header admin link to an editor delegated only admin.navVisibility.manage (Codex, review comment 4062212421)', () => {
    // setEditorUser() (role editor) has no admin.panel.access by default, so
    // this exercises the delegated path specifically: the link must not
    // depend on admin.panel.access alone once a narrower capability can
    // also reach a pane under /admin.
    useAuthStore.setState({
      permissionOverrides: { 'admin.navVisibility.manage': 'editor' },
    });

    renderHeader('/wiki');

    expect(screen.getByLabelText('nav.admin')).toBeTruthy();
  });

  it('shows the header admin link to an editor delegated only citation.merge (Codex P1, review comment 4215789774)', () => {
    useAuthStore.setState({
      permissionOverrides: { 'citation.merge': 'editor' },
    });

    renderHeader('/wiki');

    expect(screen.getByLabelText('nav.admin')).toBeTruthy();
  });

  it('withholds every admin-configurable nav item until the hidden-item list has settled (Codex, round 3)', () => {
    // Simulates the race the finding describes: the auth check resolved
    // (isAuthenticated is already true, per setEditorUser()) but the
    // concurrent hidden-item fetch has not, so hiddenNavItemsLoaded is still
    // false and hiddenNavItems is still its unloaded []. Showing every item
    // here (the pre-fix behaviour) would briefly reveal a link the admin
    // meant to hide.
    useAuthStore.setState({ hiddenNavItemsLoaded: false, hiddenNavItems: [] });

    renderHeader('/wiki');

    for (const name of ['nav.wiki', 'nav.references', 'nav.entities']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    // The one unconditional item is unaffected.
    expect(screen.getByRole('link', { name: 'nav.drugTable' })).toBeTruthy();
  });

  it('shows the under-development notice as a tag by the logo', () => {
    renderHeader('/wiki');

    const tag = screen.getByRole('note', {
      name: 'siteNotice.underDevelopment',
    });
    expect(tag.textContent).toBe('siteNotice.beta');
    expect(tag.getAttribute('title')).toBe('siteNotice.underDevelopment');
  });

  it('shows no drug name or tab menu without an active drug', () => {
    useDrugStore.setState({ activeDrug: null });
    renderHeader('/references');

    expect(screen.queryByTestId('header-active-drug')).toBeNull();
    expect(screen.queryByTestId('monograph-tab-nav')).toBeNull();
  });

  it('names the active drug and links its monograph tabs on any page', () => {
    useDrugStore.setState({
      activeDrug: {
        id: '1',
        names: { nb: 'paracetamol', en: 'paracetamol' },
        _monographSlug: 'paracetamol',
        _dbId: 7,
      } as never,
    });
    renderHeader('/references');

    expect(screen.getByTestId('header-active-drug').textContent).toBe(
      'Paracetamol',
    );
    const tabs = screen.getByTestId('monograph-tab-nav');
    const pk = within(tabs).getByRole('link', {
      name: 'parameterGroups.pharmacokinetics',
    });
    expect(pk.getAttribute('href')).toBe('/wiki/paracetamol/pharmacokinetics');
    expect(
      within(tabs).getByRole('link', { name: 'parameterGroups.postmortem' }),
    ).toBeTruthy();
    // Off the monograph, no tab is marked current.
    expect(within(tabs).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('marks the tab in the URL as current on a monograph', () => {
    useDrugStore.setState({
      activeDrug: {
        id: '1',
        names: { nb: 'paracetamol' },
        _dbId: 7,
      } as never,
    });
    renderHeader('/wiki/paracetamol/postmortem');

    const tabs = screen.getByTestId('monograph-tab-nav');
    const current = within(tabs).getByRole('link', { current: 'page' });
    expect(current.textContent).toBe('parameterGroups.postmortem');
    // The slug comes from the URL even when the drug row carries none.
    expect(
      within(tabs)
        .getByRole('link', { name: 'monographTabs.overview' })
        .getAttribute('href'),
    ).toBe('/wiki/paracetamol/chemistry');
  });

  it('keeps the header nav items identical across modules', () => {
    const navLabels = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('nav a')).map((a) =>
        a.textContent?.trim(),
      );

    const { container: wiki } = renderHeader('/wiki');
    const { container: table } = renderHeader('/');
    const { container: refs } = renderHeader('/references');

    expect(navLabels(table)).toEqual(navLabels(wiki));
    expect(navLabels(refs)).toEqual(navLabels(wiki));
  });
});
