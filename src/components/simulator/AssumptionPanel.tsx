import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import type {
  DrugSimResult,
  ParameterProvenance,
} from '@/types/simulator';
import { AlertTriangle, BookOpen, Info } from 'lucide-react';
import { useDrugBibliography } from '@/lib/useDrugBibliography';
import { formatWithMaxDecimals } from '@/lib/rangeUtils';
import { useFractionDisplay } from '@/stores/appStore';
import {
  matrixConversionApplies,
  type ChartMatrix,
} from '@/lib/matrixDisplay';
import {
  ReferenceRefsTooltip,
  type ReferenceItem,
} from '@/components/wiki/ReferenceRefsTooltip';

interface AssumptionPanelProps {
  results: Record<string, DrugSimResult>;
  drugLabels: Record<string, string>;
  /** Internal `drugs.id` per result id, for loading parameter references. */
  drugDbIds?: Record<string, number | null>;
  /** The matrix the chart is displayed in, to disclose any conversion applied. */
  displayMatrix?: ChartMatrix;
  /** Blood:plasma ratio per result id, the factor any conversion used. */
  bloodPlasmaRatios?: Record<string, number | null>;
}

/** The monograph parameter ids that back the simulator's t½ / Vd / F rows. */
const PK_PARAM_IDS = {
  halfLife: 'halfLife',
  vd: 'volumeOfDistribution',
  f: 'bioavailability',
} as const;

/** Small coloured tag describing where a parameter value came from. */
function ProvenanceTag({ provenance }: { provenance: ParameterProvenance }) {
  const { t } = useTranslation();
  const style =
    provenance === 'verified'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
      : provenance === 'assumption'
        ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200';
  return (
    <span
      className={`ml-1 rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style}`}
    >
      {t(`assumptions.provenance.${provenance}`)}
    </span>
  );
}

/**
 * The provenance affordance for a single PK parameter. Literature-backed values
 * with attached references show a hoverable "refs" tooltip (references open in a
 * new tab, same as the monograph); anything else keeps the coloured provenance
 * tag (your assumption / no-data fallback).
 */
function ParamProvenance({
  provenance,
  references,
  refsLabel,
}: {
  provenance: ParameterProvenance;
  references: ReferenceItem[];
  refsLabel: string;
}) {
  if (provenance === 'verified' && references.length > 0) {
    return <ReferenceRefsTooltip references={references} label={refsLabel} />;
  }
  return <ProvenanceTag provenance={provenance} />;
}

/** Whether a result came from the Monte Carlo PK engine that uses HL/Vd/F. */
function usesPkParameters(result: DrugSimResult): boolean {
  return result.engine == null || result.engine === 'pk-montecarlo';
}

function formatDist(
  dist: {
    type: string;
    value?: number;
    min?: number;
    max?: number;
    mode?: number;
    mu?: number;
    sigma?: number;
  },
  /**
   * Scale the distribution's parameters to a percentage. Only meaningful for
   * the dimensionless fraction F, and only for the linear-space distributions:
   * a lognormal's `mu`/`sigma` live in log space, where a ×100 is not the same
   * number in percent, so it is left in its own notation.
   */
  asPercent = false,
): string {
  const n = (value: number | undefined): string =>
    value === undefined
      ? String(value)
      : asPercent
        ? `${formatWithMaxDecimals(value * 100, 3)}%`
        : String(value);
  switch (dist.type) {
    case 'fixed':
      return `${n(dist.value)} (fixed)`;
    case 'uniform':
      return `${n(dist.min)}–${n(dist.max)} (uniform)`;
    case 'triangular':
      return `${n(dist.min)}–${n(dist.max)}, mode ${n(dist.mode)} (triangular)`;
    case 'lognormal':
      return `LN(${dist.mu}, ${dist.sigma})`;
    default:
      return '—';
  }
}

/** Stable empty deps for useDrugBibliography's footnote refs (none here). */
const NO_FOOTNOTE_REFS: number[] = [];

/**
 * One drug's assumptions block. Split into its own component so it can load that
 * drug's parameter references via `useDrugBibliography` (a hook must run at the
 * top level, not inside the parent's `.map`).
 */
function AssumptionDrugRow({
  result,
  drugLabel,
  dbId,
  displayMatrix,
  bloodPlasmaRatio,
}: {
  result: DrugSimResult;
  drugLabel: string;
  dbId: number | null;
  displayMatrix?: ChartMatrix;
  bloodPlasmaRatio?: number | null;
}) {
  const { t } = useTranslation();
  const fractionDisplay = useFractionDisplay();
  const { ordered, refsByParameter } = useDrugBibliography(
    dbId,
    NO_FOOTNOTE_REFS,
    { resolvedDrugId: dbId },
  );
  const refsLabel = t('assumptions.refsLabel');
  const refsFor = (paramId: string): ReferenceItem[] => {
    const ids = refsByParameter[paramId] ?? [];
    if (ids.length === 0 || !ordered) return [];
    return ordered.filter((o) => ids.includes(o.row.id));
  };

  // The matrix the model computed in, and whether showing it in the chart's
  // matrix crossed the blood/plasma boundary.
  const nativeMatrix = result.assumptions.nativeMatrix;
  const matrixConverted =
    nativeMatrix != null &&
    displayMatrix != null &&
    matrixConversionApplies(nativeMatrix, displayMatrix);

  const pk = usesPkParameters(result);
  const prov = result.assumptions.provenance;
  const hasFallback =
    pk &&
    prov != null &&
    (prov.halfLife === 'fallback' ||
      prov.vd === 'fallback' ||
      prov.f === 'fallback');

  return (
    <div className="border-l-2 border-mode-accent/35 pl-2 text-xs space-y-0.5">
      <div className="font-medium">{drugLabel}</div>
      <div>
        {t('assumptions.model')}:{' '}
        {result.assumptions.modelKey
          ? t(result.assumptions.modelKey)
          : result.assumptions.model}
      </div>
      <div>
        {t('assumptions.route')}: {result.assumptions.route}
      </div>
      {nativeMatrix && (
        <div>
          {t('assumptions.matrix')}:{' '}
          {t(`chartMatrix.option.${nativeMatrix}`, nativeMatrix)}
          {matrixConverted && displayMatrix && (
            <>
              {' → '}
              {t(`chartMatrix.option.${displayMatrix}`)}
              {/* The conversion factor is shown because it is an ASSUMPTION,
                  not a validated matrix transform: a pooled catalog blood:plasma
                  ratio carries its own spread, which the converted curve does
                  not currently propagate. */}
              {bloodPlasmaRatio != null && (
                <span className="ml-1 rounded bg-sky-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-800 dark:bg-sky-900/50 dark:text-sky-200">
                  {t('assumptions.matrixRatio', {
                    ratio: bloodPlasmaRatio.toFixed(2),
                  })}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {pk && (
        <>
          <div>
            t&#189;: {formatDist(result.assumptions.halfLife)}
            {prov && (
              <ParamProvenance
                provenance={prov.halfLife}
                references={refsFor(PK_PARAM_IDS.halfLife)}
                refsLabel={refsLabel}
              />
            )}
          </div>
          <div>
            Vd: {formatDist(result.assumptions.vd)}
            {prov && (
              <ParamProvenance
                provenance={prov.vd}
                references={refsFor(PK_PARAM_IDS.vd)}
                refsLabel={refsLabel}
              />
            )}
          </div>
          <div>
            F: {formatDist(result.assumptions.f, fractionDisplay === 'percent')}
            {prov && (
              <ParamProvenance
                provenance={prov.f}
                references={refsFor(PK_PARAM_IDS.f)}
                refsLabel={refsLabel}
              />
            )}
          </div>
          <div>
            {t('assumptions.absorption')}:{' '}
            {result.assumptions.absorptionKa != null
              ? t('assumptions.absorptionFirstOrder', {
                  ka: result.assumptions.absorptionKa,
                })
              : t('assumptions.absorptionInstantaneous')}
          </div>
        </>
      )}
      <div>
        {t('assumptions.draws')}: {result.drawCount.toLocaleString()}
      </div>
      {hasFallback && (
        <div className="mt-1 flex items-start gap-1.5 rounded bg-amber-500/10 p-1.5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{t('assumptions.insufficientData')}</span>
        </div>
      )}
    </div>
  );
}

export function AssumptionPanel({
  results,
  drugLabels,
  drugDbIds,
  displayMatrix,
  bloodPlasmaRatios,
}: AssumptionPanelProps) {
  const { t } = useTranslation();
  const entries = Object.entries(results);
  if (entries.length === 0) return null;

  const allWarnings = entries.flatMap(([id, r]) =>
    r.warnings.map((w) => ({ drugLabel: drugLabels[id] ?? id, ...w })),
  );

  return (
    <Card className="border-mode-accent/25">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm">{t('assumptions.title')}</h3>
          {/* This panel states what THIS run assumed; the mechanics page states what
              the simulator assumes in general. A reviewer reading one almost always
              wants the other, so the two are one click apart. */}
          <Link
            to="/modeling/how-it-works"
            title={t('mechanics.linkTitle')}
            className="inline-flex flex-shrink-0 items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <BookOpen className="h-3 w-3" />
            {t('mechanics.linkLabel')}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('assumptions.description')}
        </p>

        {/* Per-drug assumptions */}
        {entries.map(([id, result]) => (
          <AssumptionDrugRow
            key={id}
            result={result}
            drugLabel={drugLabels[id] ?? id}
            dbId={drugDbIds?.[id] ?? null}
            displayMatrix={displayMatrix}
            bloodPlasmaRatio={bloodPlasmaRatios?.[id] ?? null}
          />
        ))}

        {/* Warnings */}
        {allWarnings.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="font-semibold text-xs flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-accent" />
              {t('assumptions.warnings')}
            </h4>
            {allWarnings.map((w, i) => (
              <div
                key={i}
                className={`text-xs p-1.5 rounded flex items-start gap-1.5 ${
                  w.severity === 'critical'
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                    : w.severity === 'warning'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-mode-accent/10 text-mode-accent'
                }`}
              >
                {w.severity === 'info' ? (
                  <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                )}
                <span>
                  <span className="font-medium">{w.drugLabel}:</span>{' '}
                  {w.messageKey ? t(w.messageKey, w.messageParams) : w.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
