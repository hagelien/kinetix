import { type MouseEvent, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/authStore';
import { LogOut, Shield, User, Globe } from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { PendingBadge } from '@/components/PendingBadge';
import { NotificationBell } from '@/components/NotificationBell';
import { useTranslation } from 'react-i18next';
import { userLabel } from '@/lib/userLabel';
import { useDrugStore } from '@/stores/drugStore';
import {
  canAccessAnalyticalMethods,
  canAccessPatternProfile,
} from '@/lib/featureAccess';
import { useCan, usePermissionOverrides } from '@/lib/usePermissions';
import { NAV_ITEM_DEFS, type NavItemId } from '@/lib/navItems';
import { ROLES } from '@/lib/roles';

export function Header() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const headerRef = useRef<HTMLElement>(null);

  // Publish the header's rendered height as a CSS variable so other
  // components (e.g. DrugTable) can size themselves relative to the viewport.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty(
        '--app-header-h',
        `${el.offsetHeight}px`,
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const user = useAuthStore((s) => s.user);
  const canOpenAdmin = useCan('admin.panel.access');
  // #1240: admin.navVisibility.manage is delegable below admin.panel.access
  // (mirrors dispute.queue.read), so a delegated editor needs the header's
  // own /admin link too, not just the route-level AuthGuard that admits
  // them — otherwise they have no in-app path to the pane they can manage.
  const canManageNavVisibility = useCan('admin.navVisibility.manage');
  const permissionOverrides = usePermissionOverrides();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hiddenNavItems = useAuthStore((s) => s.hiddenNavItems);
  const hiddenNavItemsLoaded = useAuthStore((s) => s.hiddenNavItemsLoaded);
  const logout = useAuthStore((s) => s.logout);
  const setTableView = useDrugStore((s) => s.setTableView);
  const setActiveDrug = useDrugStore((s) => s.setActiveDrug);

  // #310: only the drug table is reachable anonymously. Hide nav links to
  // gated routes so unauthenticated visitors don't click into a redirect
  // loop; they can still reach those pages by URL after signing in.
  //
  // Capability gates (methods, pattern) decide whether a link is reachable
  // AT ALL for this user and run first, unconditionally — #1240's
  // admin-configured visibility (`hiddenNavItems`) only further hides a link
  // the viewer could otherwise use, for a feature not yet promoted to
  // everyone. An admin still sees every item they have access to; a hidden
  // one is parenthesised as a reminder that ordinary users don't see it.
  //
  // The exception is scoped to the actual admin ROLE, not `canOpenAdmin`
  // (`admin.panel.access`, Codex round 4 on fd1b933): that capability has an
  // editor floor and is runtime-delegable, so lowering it would otherwise
  // hand the whole editor tier a view of every deliberately-hidden link,
  // parenthesised or not. `canManageNavVisibility` is separately exempt on
  // its own terms — whoever manages the hidden list needs to see its effect
  // to do that job, independent of whether they also hold the admin role.
  const isAdminRole = user?.role === ROLES.admin;
  const hiddenSet = new Set<NavItemId>(hiddenNavItems);
  // `checkAuth` resolves the session and the hidden-item list concurrently,
  // so a returning signed-in user's header can otherwise render before the
  // list arrives — the default `hiddenNavItems: []` would then briefly show
  // a link the admin meant to hide. Withhold every configurable item (not
  // just the ones this session's stale [] happens to omit) until the list
  // has settled, one way or the other.
  const availableItems =
    isAuthenticated && hiddenNavItemsLoaded
      ? NAV_ITEM_DEFS.filter((item) => {
          if (item.id === 'methods') {
            return canAccessAnalyticalMethods(user, permissionOverrides);
          }
          if (item.id === 'pattern') {
            return canAccessPatternProfile(user);
          }
          return true;
        })
      : [];

  const NAV_ITEMS = [
    { to: '/', label: t('nav.drugTable') },
    ...availableItems
      .filter(
        (item) =>
          isAdminRole || canManageNavVisibility || !hiddenSet.has(item.id),
      )
      .map((item) => {
        const label = t(item.labelKey);
        return {
          to: item.to,
          label: hiddenSet.has(item.id) ? `(${label})` : label,
        };
      }),
    // Modeling (PK simulator, KineLab, ethanol BAC) is hidden from the
    // primary nav for now. The /modeling routes still work by URL; the
    // mode selector inside /modeling covers all three modes.
    // Drug comparison is reached through the floating basket tool
    // (bottom-right) rather than a dedicated nav link — the basket
    // already gathers the drugs and offers a "Compare" action.
    // Kinetix Learn is hidden from the primary nav for now. The /learn
    // routes still work by URL for users in the `kinetix-learn` group.
    // The PDF-request queue used to live here, but it's a niche,
    // contributor-only destination that cluttered the primary nav.
    // It now hangs off the review queue (reached via the pending
    // badge), so it's removed from the top-level menu.
  ] as ReadonlyArray<{ to: string; label: string }>;

  function isActive(path: string) {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  }

  function handleNavClick(path: string, event: MouseEvent<HTMLAnchorElement>) {
    const isPlainPrimaryClick =
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.defaultPrevented &&
      (!event.currentTarget.target || event.currentTarget.target === '_self');

    if (!isPlainPrimaryClick) return;

    if (path === '/') {
      setTableView('full');
    }
  }

  // Clicking the brand logo returns to the Kinetix landing site. Clear the
  // in-memory drug selection so the landing route ("/") shows its welcome
  // text, and drop the table to the sidebar view rather than maximizing it
  // — the landing should read as the landing page with the drug list
  // tucked into the rail beside it, not a full-screen table. Guarded the
  // same way as the nav links so modified clicks (open-in-new-tab) don't
  // mutate state.
  function handleLogoClick(event: MouseEvent<HTMLAnchorElement>) {
    const isPlainPrimaryClick =
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.defaultPrevented &&
      (!event.currentTarget.target || event.currentTarget.target === '_self');

    if (!isPlainPrimaryClick) return;

    setActiveDrug(null);
    setTableView('sidebar');
  }

  const currentLang = i18n.language?.startsWith('nb')
    ? 'nb'
    : i18n.language?.startsWith('no')
      ? 'nb'
      : (i18n.language ?? 'nb');
  const toggleLang = () => {
    const next = currentLang === 'nb' ? 'en' : 'nb';
    i18n.changeLanguage(next);
  };

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-10 border-b border-white/10"
      style={{ background: 'var(--header-gradient)' }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-5 sm:py-3 flex-wrap">
        {/* Brand */}
        <Link
          to="/"
          onClick={handleLogoClick}
          className="no-underline group flex items-center gap-2.5"
        >
          <img src="/kinetix_logo.png" alt="" className="h-8 w-auto" />
          <span className="font-display text-lg sm:text-xl font-bold tracking-tight text-white m-0">
            Kinetix
          </span>
        </Link>

        <div className="flex gap-1.5 sm:gap-2 flex-1 items-center justify-end flex-wrap">
          {/* Nav */}
          <nav className="flex gap-0.5 sm:gap-1 flex-wrap">
            {NAV_ITEMS.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                onClick={(event) => handleNavClick(to, event)}
                className={`text-[13px] sm:text-sm font-medium px-2 py-1.5 sm:px-3 rounded-md transition-colors ${
                  isActive(to)
                    ? 'bg-white/15 text-white'
                    : 'text-white/60 hover:text-white hover:bg-white/8'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* #310: whole-page wiki creation is admin-only and lives on the
              wiki landing page (WikiHome) rather than the top header, keeping
              the global nav uncluttered. */}

          {/* The header intentionally exposes no route-dependent links: menu
              items must stay identical as the user moves between modules
              (drug table, wiki, references, …). A "my changes" shortcut used
              to appear only on /wiki, but that view is reachable through the
              review module (the pending badge / /review?mine=1), so it no
              longer clutters — and destabilizes — the global header. */}

          <div className="w-px h-5 bg-white/10 mx-1 hidden sm:block" />

          <div className="hidden sm:flex">
            <CommandPalette />
          </div>

          {/* Language toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleLang}
            className="h-9 px-2 sm:h-7 sm:px-1.5 text-white/40 hover:text-white hover:bg-white/10 transition-colors text-xs font-medium gap-1"
            title={
              currentLang === 'nb' ? 'Switch to English' : 'Bytt til norsk'
            }
          >
            <Globe className="h-3.5 w-3.5 hidden sm:inline" />
            {currentLang === 'nb' ? 'EN' : 'NO'}
          </Button>

          <div className="w-px h-5 bg-white/10 mx-1 hidden sm:block" />

          {/* Auth */}
          {isAuthenticated && user ? (
            <div className="flex items-center gap-2">
              {(canOpenAdmin || canManageNavVisibility) && (
                <Link
                  to="/admin"
                  className="text-xs font-medium text-white/50 hover:text-white inline-flex items-center justify-center gap-1 transition-colors min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                  aria-label={t('nav.admin')}
                >
                  <Shield className="h-4 w-4 sm:h-3 sm:w-3" />
                  <span className="hidden sm:inline">{t('nav.admin')}</span>
                </Link>
              )}
              <PendingBadge />
              <NotificationBell />
              <Link
                to="/preferences"
                className="text-xs text-white/40 hover:text-white inline-flex items-center justify-center gap-1 transition-colors min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                title={t('nav.preferences')}
                aria-label={t('nav.preferences')}
              >
                <User className="h-4 w-4 sm:h-3 sm:w-3" />
                <span className="hidden sm:inline">{userLabel(user)}</span>
              </Link>
              <button
                onClick={() => logout()}
                className="text-white/30 hover:text-white/70 transition-colors inline-flex items-center justify-center min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                aria-label={t('auth.signOut')}
              >
                <LogOut className="h-4 w-4 sm:h-3 sm:w-3" />
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="text-xs font-medium text-white/60 hover:text-white transition-colors"
            >
              {t('nav.signIn')}
            </Link>
          )}
        </div>
      </div>

      {/* #1240: a standing reminder that the app is still under active
          development — visible on every page without competing with the nav
          for attention. A slim second row rather than a bright alert box,
          matching the header's own translucent-on-dark language. */}
      <p className="border-t border-white/10 px-3 py-1 sm:px-5 text-center text-[11px] text-amber-200/80">
        {t('siteNotice.underDevelopment')}
      </p>
    </header>
  );
}
