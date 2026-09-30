import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, FlaskConical, ShoppingBasket } from 'lucide-react';
import { MethodCodeBadge } from '@/components/methods/MethodCodeBadge';
import { loadMethods } from '@/data';
import { analyticalMethodsForDrug } from '@/lib/analyticalMethods';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { showToast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { useDrugStore } from '@/stores/drugStore';
import { useBasketStore } from '@/stores/basketStore';
import type { DrugComponent } from '@/types';

interface DrugAnalyticalMethodsProps {
  drug: DrugComponent | null;
}

export function DrugAnalyticalMethods({ drug }: DrugAnalyticalMethodsProps) {
  const { t, i18n } = useTranslation();
  const methods = useDrugStore((s) => s.methods);
  const setMethods = useDrugStore((s) => s.setMethods);
  const canLoadMethods = useAuthStore((s) =>
    canAccessAnalyticalMethods(s.user, s.permissionOverrides),
  );
  const basketItems = useBasketStore((s) => s.items);
  const addToBasket = useBasketStore((s) => s.addItem);

  useEffect(() => {
    if (!drug || !canLoadMethods || methods.length > 0) return;
    let mounted = true;
    loadMethods().then((loadedMethods) => {
      if (mounted) setMethods(loadedMethods);
    });
    return () => {
      mounted = false;
    };
  }, [drug, canLoadMethods, methods.length, setMethods]);

  const analyticalMethods = useMemo(
    () => (drug ? analyticalMethodsForDrug(methods, drug) : []),
    [drug, methods],
  );

  const basketDrugId = drug ? (drug._dbId ?? Number(drug.id)) : null;
  const inBasket =
    basketDrugId != null &&
    basketItems.some((item) => item.drugId === basketDrugId);

  if (!drug || methods.length === 0) return null;

  const handleAddToBasket = () => {
    if (basketDrugId == null || !Number.isFinite(basketDrugId)) return;
    const name =
      formatGenericDrugName(resolveDrugName(drug.names, i18n.language)) ||
      drug.nameShort ||
      drug.id;
    addToBasket({
      drugId: basketDrugId,
      pubchemCid: drug.pubchemCid ?? null,
      drugName: name,
    });
    showToast(t('methods.basket.addedToast', { name }));
  };

  return (
    <section
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5"
      aria-labelledby="drug-methods-heading"
    >
      <h2
        id="drug-methods-heading"
        className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"
      >
        <FlaskConical className="h-3.5 w-3.5" />
        {t('landing.analyticalMethods')}
      </h2>
      {analyticalMethods.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {analyticalMethods.map((method) => {
            const badge = (
              <MethodCodeBadge
                code={method.id}
                matrices={method.matrices}
                title={method.description ?? method.name}
                interactive={method.dbId != null}
              />
            );
            return method.dbId != null ? (
              <Link
                key={method.id}
                to={`/methods/${method.dbId}`}
                aria-label={`${t('landing.analyticalMethods')} ${method.id}`}
              >
                {badge}
              </Link>
            ) : (
              <span key={method.id}>{badge}</span>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('landing.noAnalyticalMethods')}
        </p>
      )}
      {inBasket ? (
        <Link
          to="/methods/basket"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary"
        >
          <Check className="h-3.5 w-3.5" />
          {t('methods.basket.inBasket')}
        </Link>
      ) : (
        <button
          type="button"
          onClick={handleAddToBasket}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <ShoppingBasket className="h-3.5 w-3.5" />
          {t('methods.basket.addToBasket')}
        </button>
      )}
    </section>
  );
}
