import type { ComponentType, SVGProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, PencilLine, Shield, User as UserIcon } from 'lucide-react';
import { ROLES } from '@/lib/roles';
import { userLabel } from '@/lib/userLabel';

export interface UserBadgeData {
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  isAgent?: boolean | null;
}

interface RoleVisual {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** i18n key under `roleBadge.*` for the localized label. */
  labelKey: 'agent' | 'admin' | 'editor' | 'contributor' | 'user';
}

function pickVisual(user: UserBadgeData): RoleVisual {
  if (user.isAgent) return { Icon: Bot, labelKey: 'agent' };
  switch (user.role) {
    case ROLES.admin:
      return { Icon: Shield, labelKey: 'admin' };
    case ROLES.editor:
      return { Icon: PencilLine, labelKey: 'editor' };
    case ROLES.contributor:
      return { Icon: UserIcon, labelKey: 'contributor' };
    default:
      return { Icon: UserIcon, labelKey: 'user' };
  }
}

interface UserBadgeProps {
  user: UserBadgeData | null | undefined;
  className?: string;
  iconClassName?: string;
  hideIcon?: boolean;
  hideName?: boolean;
}

export function UserBadge({
  user,
  className = '',
  iconClassName = 'h-3 w-3',
  hideIcon = false,
  hideName = false,
}: UserBadgeProps) {
  const { t } = useTranslation();
  if (!user) return <span className={className}>{t('roleBadge.user')}</span>;
  const name = userLabel(user);
  const { Icon, labelKey } = pickVisual(user);
  const title = t(`roleBadge.${labelKey}`);

  const content = (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {!hideIcon && <Icon className={iconClassName} aria-label={title} />}
      {!hideName && <span>{name}</span>}
    </span>
  );

  if (user.email) {
    return (
      <a
        href={`mailto:${user.email}`}
        className="hover:underline focus-visible:underline outline-none"
        title={title}
      >
        {content}
      </a>
    );
  }
  return <span title={title}>{content}</span>;
}
