import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const ITEMS = [
  { to: '/learn', key: 'learn.subnav.library', exact: true },
  { to: '/learn/map', key: 'learn.subnav.map', exact: false },
  { to: '/learn/path', key: 'learn.subnav.path', exact: false },
  { to: '/learn/review', key: 'learn.subnav.review', exact: false },
] as const;

/** Shared tab bar across the Kinetix Learn pages. */
export function LearnSubNav() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const isActive = (to: string, exact: boolean) =>
    exact ? pathname === to : pathname.startsWith(to);

  return (
    <nav className="mb-5 flex flex-wrap gap-1 border-b">
      {ITEMS.map(({ to, key, exact }) => (
        <Link
          key={to}
          to={to}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            isActive(to, exact)
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(key)}
        </Link>
      ))}
    </nav>
  );
}
