import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Scale, ShoppingBasket, Trash2, X } from 'lucide-react';
import { useBasketStore } from '@/stores/basketStore';
import { useAuthStore } from '@/stores/authStore';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { Badge } from '@/components/ui/badge';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { showToast } from '@/lib/toast';
import type { DrugComponent } from '@/types';

/**
 * Floating drug basket pinned to the lower-right of the app shell, stacked just
 * above the unit-conversion calculator. It surfaces the shared drug basket as a
 * persistent, always-reachable affordance so the "add drugs, then run a
 * function on them" concept is discoverable: everything you add here feeds both
 * the comparison page and the analytical-method suggester.
 */
export function FloatingBasket() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = useBasketStore((s) => s.items);
  const addItem = useBasketStore((s) => s.addItem);
  const removeItem = useBasketStore((s) => s.removeItem);
  const clear = useBasketStore((s) => s.clear);
  const canSuggestMethods = useAuthStore((s) =>
    canAccessAnalyticalMethods(s.user, s.permissionOverrides),
  );

  const handleAdd = (drug: DrugComponent) => {
    const drugId = drug._dbId ?? Number(drug.id);
    if (!Number.isFinite(drugId)) return;
    const name =
      formatGenericDrugName(resolveDrugName(drug.names, i18n.language)) ||
      drug.nameShort ||
      drug.id;
    addItem({ drugId, pubchemCid: drug.pubchemCid ?? null, drugName: name });
    showToast(t('basketWidget.addedToast', { name }));
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('basketWidget.open') as string}
        title={t('basketWidget.open') as string}
        className="fixed bottom-20 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ShoppingBasket className="h-6 w-6" />
        {items.length > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-400 px-1 text-[11px] font-semibold leading-none text-emerald-950">
            {items.length}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={t('basketWidget.title') as string}
      className="fixed bottom-20 right-4 z-50 flex max-h-[calc(100vh-7rem)] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShoppingBasket className="h-4 w-4 text-primary" />
          {t('basketWidget.title')}
          {items.length > 0 ? (
            <span className="text-xs font-normal text-muted-foreground">
              ({items.length})
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t('basketWidget.close') as string}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-4 py-3">
        <DrugSearchDropdown
          className="w-full"
          onSelect={handleAdd}
          placeholder={t('basketWidget.searchPlaceholder')}
          maxResults={8}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs italic text-muted-foreground">
            {t('basketWidget.empty')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 pb-2">
            {items.map((item) => (
              <li key={item.drugId}>
                <Badge variant="secondary" className="gap-1 pr-1">
                  {item.drugName}
                  <button
                    type="button"
                    onClick={() => removeItem(item.drugId)}
                    aria-label={t('basketWidget.remove', { name: item.drugName })}
                    className="rounded-full p-0.5 hover:bg-background/60"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <Link
            to="/comparison"
            onClick={() => setOpen(false)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Scale className="h-3.5 w-3.5" />
            {t('basketWidget.compare')}
          </Link>
          {canSuggestMethods ? (
            <Link
              to="/methods/basket"
              onClick={() => setOpen(false)}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              {t('basketWidget.methods')}
            </Link>
          ) : null}
        </div>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('basketWidget.clear')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
