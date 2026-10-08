import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Scale, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { PharmacodynamicsComparison } from '@/components/comparison/PharmacodynamicsComparison';
import { fetchDrugsByIds, type DrugRow } from '@/lib/drugApi';
import {
  buildParameterComparison,
  formatComparisonValue,
  formatComparisonRepresentative,
  formatRatio,
  relativeRatio,
  type ComparisonValue,
} from '@/lib/comparison';
import {
  DRUG_VALUE_PARAMETER_IDS,
  getParameterLongLabelKey,
} from '@/lib/drugParameters';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { showToast } from '@/lib/toast';
import { useBasketStore } from '@/stores/basketStore';
import { useFractionDisplay } from '@/stores/appStore';
import type { DrugComponent } from '@/types';
import type { DrugParameterId } from '@/lib/drugParameters';

function uniqueInOrder<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function pct(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

function AbsolutePlot({
  values,
  drugName,
  unavailableLabel,
}: {
  values: ComparisonValue[];
  drugName: (drugId: number) => string;
  unavailableLabel: string;
}) {
  const fractionDisplay = useFractionDisplay();
  const populated = values.filter((value) => value.numeric !== null);
  const axisMin = Math.min(
    0,
    ...populated.map((value) => value.min ?? value.numeric ?? 0),
  );
  const axisMax = Math.max(
    ...populated.map((value) => value.max ?? value.numeric ?? 0),
    1,
  );

  return (
    <div className="space-y-2">
      {values.map((value) => {
        const numeric = value.numeric;
        const min = value.min ?? numeric;
        const max = value.max ?? numeric;
        const dot = numeric === null ? null : pct(numeric, axisMin, axisMax);
        const start = min === null ? 0 : pct(min, axisMin, axisMax);
        const end = max === null ? start : pct(max, axisMin, axisMax);
        return (
          <div
            key={`${value.drugId}-${value.parameterId}`}
            className="grid grid-cols-[minmax(7rem,11rem)_1fr_minmax(4rem,auto)] items-center gap-3 text-xs"
          >
            <span className="truncate font-medium">
              {drugName(value.drugId)}
            </span>
            {numeric === null ? (
              <span className="text-muted-foreground">
                {formatComparisonValue(value, fractionDisplay) ||
                  unavailableLabel}
              </span>
            ) : (
              <div className="relative h-5">
                <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/25"
                  style={{
                    left: `${Math.min(start, end)}%`,
                    width: `${Math.max(2, Math.abs(end - start))}%`,
                  }}
                />
                <div
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background"
                  style={{ left: `${dot}%` }}
                />
              </div>
            )}
            <span className="text-right tabular-nums text-muted-foreground">
              {formatComparisonValue(value, fractionDisplay) || '-'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RelativePlot({
  values,
  reference,
  inverseStrength,
  drugName,
  unavailableLabel,
  logScaleLabel,
}: {
  values: ComparisonValue[];
  reference: ComparisonValue | null;
  inverseStrength: boolean;
  drugName: (drugId: number) => string;
  unavailableLabel: string;
  logScaleLabel: string;
}) {
  const ratios = values.map((value) =>
    relativeRatio(value.numeric, reference?.numeric ?? null, inverseStrength),
  );
  const populated = ratios.filter((ratio): ratio is number => ratio !== null);
  const useLogScale =
    populated.length > 1 &&
    Math.max(...populated) / Math.min(...populated) > 10;
  const min = useLogScale
    ? Math.log10(Math.min(...populated, 1))
    : Math.min(0, ...populated);
  const max = useLogScale
    ? Math.log10(Math.max(...populated, 1))
    : Math.max(1, ...populated);

  return (
    <div className="space-y-2">
      {values.map((value, index) => {
        const ratio = ratios[index] ?? null;
        const position =
          ratio === null
            ? null
            : pct(useLogScale ? Math.log10(ratio) : ratio, min, max);
        return (
          <div
            key={`${value.drugId}-${value.parameterId}`}
            className="grid grid-cols-[minmax(7rem,11rem)_4rem_1fr] items-center gap-3 text-xs"
          >
            <span className="truncate font-medium">
              {drugName(value.drugId)}
            </span>
            <span className="text-right tabular-nums text-muted-foreground">
              {formatRatio(ratio) || '-'}
            </span>
            {position === null ? (
              <span className="text-muted-foreground">{unavailableLabel}</span>
            ) : (
              <div className="relative h-5">
                <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                <div
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-background"
                  style={{ left: `${position}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
      {useLogScale ? (
        <p className="text-[11px] text-muted-foreground">{logScaleLabel}</p>
      ) : null}
    </div>
  );
}

function ComparisonAddDrugPanel({
  onDrugSelect,
  title,
  body,
}: {
  onDrugSelect: (drug: DrugComponent) => void;
  title: string;
  body: string;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
        <div className="w-full lg:max-w-md">
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor="comparison-add-drug"
          >
            {t('comparison.drugToAdd')}
          </label>
          <DrugSearchDropdown
            className="w-full"
            inputId="comparison-add-drug"
            onSelect={onDrugSelect}
            placeholder={t('comparison.searchPlaceholder')}
            maxResults={8}
          />
        </div>
      </div>
    </section>
  );
}

function ParameterPicker({
  selected,
  onToggle,
}: {
  selected: DrugParameterId[];
  onToggle: (parameterId: DrugParameterId) => void;
}) {
  const { t } = useTranslation();
  const selectedSet = new Set(selected);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('comparison.parametersTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('comparison.parametersBody')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {DRUG_VALUE_PARAMETER_IDS.map((parameterId) => {
          const active = selectedSet.has(parameterId);
          return (
            <button
              key={parameterId}
              type="button"
              onClick={() => onToggle(parameterId)}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {t(getParameterLongLabelKey(parameterId), {
                defaultValue: parameterId,
              })}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ComparisonPage() {
  const { t, i18n } = useTranslation();
  const fractionDisplay = useFractionDisplay();
  const items = useBasketStore((state) => state.items);
  const addItem = useBasketStore((state) => state.addItem);
  const referenceDrugId = useBasketStore((state) => state.referenceDrugId);
  const setReferenceDrugId = useBasketStore(
    (state) => state.setReferenceDrugId,
  );
  const removeItem = useBasketStore((state) => state.removeItem);
  const clear = useBasketStore((state) => state.clear);
  const parameterIds = useBasketStore((state) => state.comparisonParameterIds);
  const toggleComparisonParameter = useBasketStore(
    (state) => state.toggleComparisonParameter,
  );
  const targetIds = useBasketStore((state) => state.comparisonTargetIds);
  const toggleComparisonTarget = useBasketStore(
    (state) => state.toggleComparisonTarget,
  );
  const [rows, setRows] = useState<Record<number, DrugRow>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drugIds = useMemo(
    () => uniqueInOrder(items.map((item) => item.drugId)),
    [items],
  );
  const drugIdSignature = drugIds.join(',');
  const effectiveReferenceDrugId =
    referenceDrugId && drugIds.includes(referenceDrugId)
      ? referenceDrugId
      : (drugIds[0] ?? null);

  useEffect(() => {
    const ids = drugIdSignature
      .split(',')
      .filter(Boolean)
      .map((id) => Number(id));
    if (!ids.length) {
      setRows({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDrugsByIds(ids)
      .then(({ drugs }) => {
        if (cancelled) return;
        setRows(Object.fromEntries(drugs.map((drug) => [drug.id, drug])));
      })
      .catch((err) => {
        if (!cancelled) {
          setRows({});
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drugIdSignature]);

  const loadedDrugs = drugIds
    .map((drugId) => rows[drugId])
    .filter((drug): drug is DrugRow => Boolean(drug));
  const drugName = (drugId: number) => {
    const row = rows[drugId];
    if (row)
      return (
        formatGenericDrugName(resolveDrugName(row.names, i18n.language)) ||
        row.slug
      );
    return (
      items.find((item) => item.drugId === drugId)?.drugName ?? String(drugId)
    );
  };
  const handleAddDrug = (drug: DrugComponent) => {
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
    showToast(t('comparison.addedToast', { drug: displayName }));
  };

  if (!items.length) {
    return (
      <main className="flex-1 px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-4xl space-y-4">
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <Scale className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h1 className="text-xl font-semibold">
              {t('comparison.emptyTitle')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('comparison.emptyBody')}
            </p>
            <Link
              to="/"
              className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('comparison.openDrugTable')}
            </Link>
          </div>
          <ComparisonAddDrugPanel
            onDrugSelect={handleAddDrug}
            title={t('comparison.addTitle')}
            body={t('comparison.addBody')}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 px-3 py-4 sm:px-5 sm:py-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('comparison.title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('comparison.subtitle')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={clear}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t('comparison.clear')}
          </Button>
        </header>

        <ComparisonAddDrugPanel
          onDrugSelect={handleAddDrug}
          title={t('comparison.addMoreTitle')}
          body={t('comparison.addMoreBody')}
        />

        <ParameterPicker
          selected={parameterIds}
          onToggle={toggleComparisonParameter}
        />

        <section className="rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label
              className="text-sm font-medium"
              htmlFor="comparison-reference"
            >
              {t('comparison.referenceDrug')}
            </label>
            <select
              id="comparison-reference"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={effectiveReferenceDrugId ?? ''}
              onChange={(event) =>
                setReferenceDrugId(Number(event.target.value))
              }
            >
              {drugIds.map((drugId) => (
                <option key={drugId} value={drugId}>
                  {drugName(drugId)}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {t('comparison.count', {
                drugs: drugIds.length,
                parameters: parameterIds.length,
              })}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {items.map((item) => (
              <button
                key={item.drugId}
                type="button"
                onClick={() => removeItem(item.drugId)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                title={t('comparison.removeItem')}
              >
                <span>{drugName(item.drugId)}</span>
                <X className="h-3 w-3" />
              </button>
            ))}
          </div>
        </section>

        {loading ? (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {parameterIds.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            {t('comparison.noParameters')}
          </p>
        ) : null}

        <div className="space-y-4">
          {parameterIds.map((parameterId: DrugParameterId) => {
            const comparison = buildParameterComparison(
              parameterId,
              loadedDrugs,
            );
            const reference =
              comparison.values.find(
                (value) => value.drugId === effectiveReferenceDrugId,
              ) ??
              comparison.values.find((value) => value.numeric !== null) ??
              null;
            const ratios = comparison.hasUnitMismatch
              ? comparison.values.map(() => null)
              : comparison.values.map((value) =>
                  relativeRatio(
                    value.numeric,
                    reference?.numeric ?? null,
                    comparison.inverseStrength,
                  ),
                );

            return (
              <section
                key={parameterId}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {t(getParameterLongLabelKey(parameterId), {
                        defaultValue: comparison.spec.longLabel,
                      })}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {comparison.commonUnit
                        ? t('comparison.unit', { unit: comparison.commonUnit })
                        : t('comparison.noCommonUnit')}
                    </p>
                  </div>
                  {comparison.inverseStrength ? (
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                      {t('comparison.inverseStrength')}
                    </span>
                  ) : null}
                </div>

                {comparison.hasUnitMismatch ? (
                  <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100">
                    {t('comparison.unitMismatch')}
                  </div>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-md border border-border p-3">
                    <h3 className="mb-3 text-sm font-medium">
                      {t('comparison.absoluteValues')}
                    </h3>
                    {comparison.hasUnitMismatch ? (
                      <p className="text-sm text-muted-foreground">
                        {t('comparison.unitMismatch')}
                      </p>
                    ) : (
                      <AbsolutePlot
                        values={comparison.values}
                        drugName={drugName}
                        unavailableLabel={t('comparison.unavailable')}
                      />
                    )}
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <h3 className="mb-3 text-sm font-medium">
                      {t('comparison.relativeValues', {
                        drug: reference ? drugName(reference.drugId) : '-',
                      })}
                    </h3>
                    {comparison.hasUnitMismatch ? (
                      <p className="text-sm text-muted-foreground">
                        {t('comparison.unitMismatch')}
                      </p>
                    ) : (
                      <RelativePlot
                        values={comparison.values}
                        reference={reference}
                        inverseStrength={comparison.inverseStrength}
                        drugName={drugName}
                        unavailableLabel={t('comparison.unavailable')}
                        logScaleLabel={t('comparison.logScale')}
                      />
                    )}
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">
                          {t('comparison.drug')}
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          {t('comparison.value')}
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          {t('comparison.representative')}
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          {t('comparison.relative')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.values.map((value, index) => (
                        <tr
                          key={value.drugId}
                          className="border-b border-border/60"
                        >
                          <td className="py-2 pr-4 font-medium">
                            {drugName(value.drugId)}
                          </td>
                          <td className="py-2 pr-4">
                            {formatComparisonValue(value, fractionDisplay) ||
                              t('comparison.unavailable')}
                          </td>
                          <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                            {formatComparisonRepresentative(
                              value,
                              fractionDisplay,
                            ) || '-'}
                          </td>
                          <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                            {formatRatio(ratios[index] ?? null) || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>

        <PharmacodynamicsComparison
          drugIds={drugIds}
          referenceDrugId={effectiveReferenceDrugId}
          selectedTargetIds={targetIds ?? []}
          onToggleTarget={toggleComparisonTarget}
          drugName={drugName}
        />
      </div>
    </main>
  );
}
