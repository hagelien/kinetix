import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FlaskConical, ShoppingBasket, Trash2, X, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useBasketStore } from '@/stores/basketStore';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { usePermissionOverrides } from '@/lib/usePermissions';
import { fetchMethods, type MethodRow } from '@/lib/drugApi';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import {
  suggestConfirmatoryMethods,
  type BasketComponent,
  type MethodSolution,
} from '@/lib/methodSuggester';
import { matrixLabelKey } from '@/lib/methodMeta';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MethodCodeBadge } from '@/components/methods/MethodCodeBadge';
import type { DrugComponent } from '@/types';

export function MethodBasketPage() {
  const { t, i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const permissionOverrides = usePermissionOverrides();
  const canView = canAccessAnalyticalMethods(
    user,
    permissionOverrides,
  );

  const items = useBasketStore((s) => s.items);
  const addItem = useBasketStore((s) => s.addItem);
  const removeItem = useBasketStore((s) => s.removeItem);
  const clear = useBasketStore((s) => s.clear);

  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  const basket: BasketComponent[] = useMemo(
    () =>
      items.map((item) => ({
        drugId: item.drugId,
        pubchemCid: item.pubchemCid,
        drugName: item.drugName,
      })),
    [items],
  );

  const suggestion = useMemo(
    () => suggestConfirmatoryMethods(basket, methods),
    [basket, methods],
  );

  const handleAdd = (drug: DrugComponent) => {
    const drugId = drug._dbId ?? Number(drug.id);
    if (!Number.isFinite(drugId)) return;
    const displayName =
      formatGenericDrugName(resolveDrugName(drug.names, i18n.language)) ||
      drug.nameShort ||
      drug.id;
    addItem({
      drugId,
      pubchemCid: drug.pubchemCid ?? null,
      drugName: displayName,
    });
  };

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
            <ShoppingBasket className="h-5 w-5 text-primary" />
            {t('methods.basket.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('methods.basket.subtitle')}
          </p>
        </div>
        <Link
          to="/methods"
          className={buttonVariants({ variant: 'outline', className: 'shrink-0' })}
        >
          <FlaskConical className="mr-1 h-4 w-4" />
          {t('methods.title')}
        </Link>
      </div>

      <div className="mb-4 max-w-md">
        <DrugSearchDropdown
          onSelect={handleAdd}
          placeholder={t('methods.basket.searchComponent')}
        />
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('methods.basket.empty')}
        </p>
      ) : (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              {t('methods.basket.componentsHeading', { count: items.length })}
            </h2>
            <Button variant="ghost" size="sm" onClick={clear}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t('methods.basket.clear')}
            </Button>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {items.map((item) => (
              <li key={item.drugId}>
                <Badge variant="secondary" className="gap-1 pr-1">
                  {item.drugName}
                  <button
                    type="button"
                    onClick={() => removeItem(item.drugId)}
                    aria-label={t('methods.basket.removeComponent', {
                      name: item.drugName,
                    })}
                    className="rounded-full p-0.5 hover:bg-background/60"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : errorMsg ? (
        <p className="text-sm text-destructive">{errorMsg}</p>
      ) : items.length > 0 ? (
        <SuggestionResults suggestion={suggestion} />
      ) : null}
    </div>
  );
}

function SuggestionResults({
  suggestion,
}: {
  suggestion: ReturnType<typeof suggestConfirmatoryMethods>;
}) {
  const { t } = useTranslation();
  const { matrices, globallyUncoverable } = suggestion;

  return (
    <section aria-labelledby="suggestions-heading">
      <h2
        id="suggestions-heading"
        className="mb-3 text-sm font-semibold uppercase text-muted-foreground"
      >
        {t('methods.basket.suggestionsHeading')}
      </h2>

      {globallyUncoverable.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">
              {t('methods.basket.noConfirmatory')}
            </p>
            <p className="mt-1 text-muted-foreground">
              {globallyUncoverable.map((c) => c.drugName).join(', ')}
            </p>
          </div>
        </div>
      )}

      {matrices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('methods.basket.noSuggestions')}
        </p>
      ) : (
        <div className="space-y-5">
          {matrices.map((matrix) => (
            <div key={matrix.matrix}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {t(matrixLabelKey(matrix.matrix))}
                </Badge>
                {matrix.uncoverableComponents.length > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{t('methods.basket.notInMatrixLabel')}</span>
                    {matrix.uncoverableComponents.map((c) => (
                      <span
                        key={c.drugId}
                        className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-100"
                      >
                        {c.drugName}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {matrix.solutions.map((solution, index) => (
                  <SolutionCard
                    key={solution.methods.map((m) => m.id).join('-')}
                    solution={solution}
                    isFewest={index === 0}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SolutionCard({
  solution,
  isFewest,
}: {
  solution: MethodSolution;
  isFewest: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {isFewest && (
          <Badge variant="info">{t('methods.basket.fewestMethods')}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {t('methods.basket.methodCount', { count: solution.methodCount })}
          {' · '}
          {solution.hasUnknownVolume
            ? t('methods.basket.volumeUnknown')
            : t('methods.basket.totalVolume', {
                // Summing method volumes can introduce floating-point noise
                // (e.g. 1.2000000000000002 ml). Round to at most 2 decimals
                // and drop trailing zeros for a clean display.
                value: Number((solution.totalVolumeMl ?? 0).toFixed(2)),
              })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {solution.methods.map((m) => (
          <Link key={m.id} to={`/methods/${m.id}`}>
            <MethodCodeBadge
              code={m.code}
              matrices={m.matrices}
              title={m.name}
              interactive
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
