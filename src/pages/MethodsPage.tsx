import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { useCan, usePermissionOverrides } from '@/lib/usePermissions';
import { fetchMethods, type MethodRow } from '@/lib/drugApi';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  methodTypeBadgeVariant,
  methodTypeLabelKey,
} from '@/lib/methodMeta';
import { MatrixBadges } from '@/components/methods/MatrixBadges';
import { MethodEditorModal } from '@/components/methods/MethodEditorModal';
import { FlaskConical, Plus, ShoppingBasket } from 'lucide-react';

export function MethodsPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const permissionOverrides = usePermissionOverrides();
  const canView = canAccessAnalyticalMethods(
    user,
    permissionOverrides,
  );
  const canEdit = useCan('methods.write');

  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchMethods()
      .then(({ methods: rows, gated }) => {
        setMethods(gated ? [] : rows);
        setErrorMsg(null);
      })
      .catch(() => setErrorMsg(t('methods.loadError')))
      .finally(() => setLoading(false));
  }, [canView, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canView) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-muted-foreground">
        {t('methods.forbidden')}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <FlaskConical className="h-5 w-5 text-primary" />
            {t('methods.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('methods.subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/methods/basket"
            className={buttonVariants({ variant: 'outline' })}
          >
            <ShoppingBasket className="mr-1 h-4 w-4" />
            {t('methods.basket.title')}
          </Link>
          {canEdit && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" />
              {t('methods.new')}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : errorMsg ? (
        <p className="text-sm text-destructive">{errorMsg}</p>
      ) : methods.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('methods.empty')}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {methods.map((m) => (
            <li key={m.id}>
              <Link
                to={`/methods/${m.id}`}
                className="block rounded-lg border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">
                    {m.code}
                  </span>
                  <Badge variant={methodTypeBadgeVariant(m.methodType)}>
                    {t(methodTypeLabelKey(m.methodType))}
                  </Badge>
                </div>
                <h2 className="mt-1 font-medium leading-tight">{m.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <MatrixBadges matrices={m.matrices} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('methods.componentCount', { count: m.componentCount })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <MethodEditorModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}
