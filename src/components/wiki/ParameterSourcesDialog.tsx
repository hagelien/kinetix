import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { DRUG_PARAMETERS, type DrugParameterId } from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import {
  bloodRatioScalar,
  type ParameterSummary,
} from '@/lib/parameterEntryAggregation';
import { preferredDisplayUnit } from '@/lib/parameterUnits';
import { useAppStore } from '@/stores/appStore';
import type { NumericRange } from '@/types';
import { ParameterForestPlot, type MatrixFrame } from './ParameterForestPlot';
import { ParameterEntryList } from './ParameterEntryList';
import { ROUTE_LABEL_KEYS, ROUTE_OPTIONS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';

/** Route display order — the kinetics-core vocabulary order, so sections keep a stable sequence. */
const ROUTE_ORDER: readonly string[] = ROUTE_OPTIONS;

interface Props {
  drugId: number;
  /** Shown in the title so the plot is attributable when opened from a preview pane. */
  drugName: string;
  parameter: DrugParameterId;
  /** All of the drug's summaries; the entry list reads its headline from here. */
  summaries?: Record<string, ParameterSummary>;
  /**
   * This drug's per-route pools for every parameter (CV-2c-4), keyed parameter → route. A
   * route-scoped entry never pools into the drug-level summary, so without these the dialog
   * would plot nothing — and say nothing was registered — for a parameter whose evidence has
   * all been curated onto a route.
   */
  routeSummaries?: Record<string, Record<string, ParameterSummary>>;
  molecularWeight?: number | null;
  /** Drug blood:plasma ratio — lets the plot offer serum/plasma frames. */
  bloodPlasmaRatio?: NumericRange | number | null;
  canEdit?: boolean;
  isAdmin?: boolean;
  /** Reload the drug after a direct write so the plot and pooled value refresh. */
  onMutated?: () => void;
  onClose: () => void;
}

/**
 * The source values behind one drug parameter, as a graph plus the per-source
 * list. Lifted out of the sidebar's inline `<details>` expander: a
 * permanently visible "Add source values" summary under every summarizable
 * parameter drowned out the values themselves, so the affordance now lives in
 * the parameter's hover action row and opens here, where the forest plot has
 * room to be read and the sources compared side by side.
 */
export function ParameterSourcesDialog({
  drugId,
  drugName,
  parameter,
  summaries,
  routeSummaries,
  molecularWeight,
  bloodPlasmaRatio,
  canEdit = false,
  isAdmin = false,
  onMutated,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { longLabel } = useParameterLabels(DRUG_PARAMETERS[parameter]);
  const summary = summaries?.[parameter];
  // The per-route pools for THIS parameter, in the route vocabulary's display order so oral leads
  // and the sections do not reshuffle between renders.
  const routeEntries = Object.entries(routeSummaries?.[parameter] ?? {}).sort(
    ([a], [b]) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b),
  );
  const enabledUnits = useAppStore((s) => s.enabledUnits);
  // One display unit for the whole dialog — the reader's preferred concentration
  // unit when the summary converts into it, the canonical unit otherwise — so
  // the axis, the pooled headline and the per-source rows all agree.
  const displayUnit = summary
    ? preferredDisplayUnit(summary.unit, enabledUnits, molecularWeight)
    : undefined;
  // Which source the pointer is on, wherever it entered from. Held here because
  // the plot and the list are siblings that must mirror each other's hover.
  const [highlightedEntryId, setHighlightedEntryId] = useState<number | null>(
    null,
  );
  // The matrix frame lives here for the same reason: the plot's pooled diamond
  // and the list's pooled headline are the SAME estimate, and showing them as
  // two unlabelled numbers because only one followed the reader's choice would
  // be worse than not offering the choice.
  const [frame, setFrame] = useState<MatrixFrame>('whole_blood');
  const ratio =
    bloodPlasmaRatio != null ? bloodRatioScalar(bloodPlasmaRatio) : null;
  const canReframe = summary?.normalizedToWholeBlood === true && ratio != null;
  const activeFrame: MatrixFrame = canReframe ? frame : 'whole_blood';
  // blood = ratio × plasma, so a serum/plasma equivalent divides back out.
  const pooledFrameScale =
    activeFrame === 'whole_blood' || ratio == null ? 1 : 1 / ratio;
  // Both strings interpolate the parameter (and drug) rather than being glued
  // together from translated fragments — word order and punctuation around a
  // name differ between languages, and only the locale file can express that.
  const title = t('parameterEntries.dialogTitle', { parameter: longLabel });

  return (
    <ModalOverlay
      onClose={onClose}
      // Names the dialog for assistive tech. Unlike the visible heading, which
      // sits above the drug name, this has to carry the drug itself — a screen
      // reader announces the name alone, with no surrounding layout.
      ariaLabel={t('parameterEntries.dialogAriaLabel', {
        parameter: longLabel,
        drug: drugName,
      })}
      className="w-full max-w-3xl p-6 max-h-[85vh] flex flex-col"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{drugName}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {summary ? (
          <div data-testid="parameter-forest-plot">
            <ParameterForestPlot
              summary={summary}
              parameter={parameter}
              displayUnit={displayUnit}
              molecularWeight={molecularWeight}
              bloodPlasmaRatio={bloodPlasmaRatio}
              highlightedEntryId={highlightedEntryId}
              onHighlightEntry={setHighlightedEntryId}
              frame={frame}
              onFrameChange={setFrame}
            />
          </div>
        ) : null}
        {/* One plot per route with its own pooled estimate. A route's sources are a different
            population from the drug-level ones (an oral Tmax is not an insufflated one), so they
            get their own axis and diamond rather than extra markers on the drug-level plot. */}
        {routeEntries.map(([route, routeSummary]) => (
          <div key={route} data-testid={`parameter-forest-plot-${route}`}>
            <h4 className="mt-2 text-xs font-medium text-muted-foreground">
              {t('parameterEntries.routeSection', {
                route: t(ROUTE_LABEL_KEYS[route as RouteId] ?? route, {
                  defaultValue: route,
                }),
              })}
            </h4>
            <ParameterForestPlot
              summary={routeSummary}
              parameter={parameter}
              displayUnit={preferredDisplayUnit(
                routeSummary.unit,
                enabledUnits,
                molecularWeight,
              )}
              molecularWeight={molecularWeight}
              bloodPlasmaRatio={bloodPlasmaRatio}
              highlightedEntryId={highlightedEntryId}
              onHighlightEntry={setHighlightedEntryId}
            />
          </div>
        ))}
        {!summary && routeEntries.length === 0 ? (
          // No entries yet: say so plainly rather than render an empty axis.
          // The list below still offers the "add source value" control.
          <p className="text-sm text-muted-foreground">
            {t('parameterEntries.dialogEmpty')}
          </p>
        ) : null}
        <ParameterEntryList
          drugId={drugId}
          parameter={parameter}
          summaries={summaries}
          molecularWeight={molecularWeight}
          canEdit={canEdit}
          isAdmin={isAdmin}
          onMutated={onMutated}
          pooledFrameMatrix={
            activeFrame === 'whole_blood' ? null : activeFrame
          }
          pooledFrameScale={pooledFrameScale}
          highlightedEntryId={highlightedEntryId}
          onHighlightEntry={setHighlightedEntryId}
        />
      </div>
    </ModalOverlay>
  );
}

export default ParameterSourcesDialog;
