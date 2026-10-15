import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { fetchEntityTargetLigands } from '@/lib/bioEntitiesApi';
import { capitalizeGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { referenceModulePath } from '@/lib/referencesApi';
import {
  buildActivityPlot,
  countLigandsBySpecies,
  filterLigandsBySpecies,
  formatMeasurement,
  metricOmissions,
  normalizeInteractionType,
  omissionReasons,
  plottableMetrics,
  resolvePlotMetric,
  sortLigands,
  type ActivityPlot,
  type LigandSortKey,
  type PlotOmissionReason,
  type SpeciesFilter,
  type TargetMetric,
} from '@/lib/entityTargetLigands';
import type { EntityTargetLigand } from '@/lib/receptorTargets';
import type { NumericRange } from '@/types';
import { EntityTargetActivityPlot } from './EntityTargetActivityPlot';

interface EntityTargetLigandsProps {
  entityId: number;
}

const SPECIES_OPTIONS: { value: SpeciesFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'bioEntity.speciesAll' },
  { value: 'human', labelKey: 'bioEntity.speciesHuman' },
  { value: 'non_human', labelKey: 'bioEntity.speciesNonHuman' },
  { value: 'unstated', labelKey: 'bioEntity.speciesUnstated' },
];

const OMISSION_LABEL_KEYS: Record<PlotOmissionReason, string> = {
  one_sided: 'bioEntity.omitOneSided',
  unsupported_unit: 'bioEntity.omitUnsupportedUnit',
  non_positive: 'bioEntity.omitNonPositive',
  non_positive_bound: 'bioEntity.omitNonPositiveBound',
  non_finite: 'bioEntity.omitNonFinite',
  heterogeneous_units: 'bioEntity.omitHeterogeneousUnits',
};

/** Measurement columns that are optional: shown only when a row carries one. */
const OPTIONAL_METRIC_COLUMNS = ['affinity', 'potency', 'selectivityRatio'] as const;
type OptionalMetricColumn = (typeof OPTIONAL_METRIC_COLUMNS)[number];

type MeasurementKey =
  | TargetMetric
  | OptionalMetricColumn;

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; ligands: EntityTargetLigand[] };

/**
 * Target-pharmacology collection on a bio entity's monograph: the inverse of
 * a drug monograph's pharmacodynamics box. Lists every `drug_receptor_targets`
 * row pointing at the entity, with an assay-species filter and an
 * activity-grouped plot of one measurement at a time; the filter drives table
 * and plot together so they never tell different stories.
 *
 * Renders nothing when the entity has no target relationships. A failed
 * lookup stays local to this section (with a retry) so the monograph prose
 * around it is unaffected.
 */
export function EntityTargetLigands({ entityId }: EntityTargetLigandsProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [species, setSpecies] = useState<SpeciesFilter>('all');
  const [selectedMetric, setSelectedMetric] = useState<TargetMetric | null>(null);
  const [sort, setSort] = useState<{ key: LigandSortKey; dir: 'asc' | 'desc' }>({
    key: 'default',
    dir: 'asc',
  });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const headingId = useId();
  const speciesName = useId();
  const metricId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchEntityTargetLigands(entityId, controller.signal)
      .then((ligands) => {
        if (!controller.signal.aborted) setState({ status: 'ready', ligands });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [entityId, reloadToken]);

  // A new entity starts from the default view rather than the last one's.
  useEffect(() => {
    setSpecies('all');
    setSelectedMetric(null);
    setSort({ key: 'default', dir: 'asc' });
    setExpanded(new Set());
  }, [entityId]);

  const ligands = useMemo(
    () => (state.status === 'ready' ? state.ligands : []),
    [state],
  );
  const counts = useMemo(() => countLigandsBySpecies(ligands), [ligands]);
  const filtered = useMemo(
    () => filterLigandsBySpecies(ligands, species),
    [ligands, species],
  );
  const availableMetrics = useMemo(() => plottableMetrics(filtered), [filtered]);
  const metric = resolvePlotMetric(availableMetrics, selectedMetric);
  const plot = useMemo(
    () => (metric ? buildActivityPlot(filtered, metric) : null),
    [filtered, metric],
  );
  // With nothing plottable there is no selected metric to report against,
  // so the omissions are derived per metric, independently of the plot.
  const unplottedOmissions = useMemo(
    () => (plot ? [] : metricOmissions(filtered)),
    [filtered, plot],
  );

  const drugName = (ligand: EntityTargetLigand) =>
    capitalizeGenericDrugName(resolveDrugName(ligand.drugNames, i18n.language)) ||
    ligand.drugSlug;
  const drugHref = (ligand: EntityTargetLigand) =>
    ligand.drugMonographSlug
      ? `/wiki/${ligand.drugMonographSlug}`
      : `/wiki/drug/${ligand.drugId}`;
  // The stored interaction type is data: shown as recorded (separators
  // turned into spaces), never re-labelled or translated.
  const activityLabel = (ligand: EntityTargetLigand) =>
    normalizeInteractionType(ligand.interactionType).label || '—';
  const speciesLabel = (ligand: EntityTargetLigand) =>
    ligand.assaySpecies?.trim() || t('bioEntity.speciesUnstated');
  const metricLabel = (key: MeasurementKey): string => {
    switch (key) {
      case 'ki':
        return 'Ki';
      case 'ec50':
        return 'EC50';
      case 'ic50':
        return 'IC50';
      case 'emax':
        return 'Emax';
      case 'affinity':
        return t('sidebar.receptorAffinity');
      case 'potency':
        return t('sidebar.receptorPotency');
      case 'efficacy':
        return t('sidebar.receptorEfficacy');
      case 'selectivityRatio':
        return t('bioEntity.colSelectivity');
    }
  };

  if (state.status === 'loading') {
    return (
      <p
        className="mt-8 border-t border-border pt-6 text-sm text-muted-foreground"
        role="status"
      >
        {t('bioEntity.targetLoading')}
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="mt-8 border-t border-border pt-6" aria-labelledby={headingId}>
        <h2 id={headingId} className="text-lg font-semibold">
          {t('bioEntity.targetPharmacologyHeading')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground" role="alert">
          {t('bioEntity.targetLoadFailed')}{' '}
          <button
            type="button"
            className="text-primary underline hover:no-underline"
            onClick={() => setReloadToken((n) => n + 1)}
          >
            {t('common.retry')}
          </button>
        </p>
      </section>
    );
  }

  if (ligands.length === 0) return null;

  const rows = sortLigands(filtered, sort.key, sort.dir, drugName);

  const optionalColumns = OPTIONAL_METRIC_COLUMNS.filter((key) =>
    filtered.some((l) => l[key] !== null),
  );
  const columnCount = 8 + optionalColumns.length;

  const toggleSort = (key: LigandSortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sortHeader = (key: LigandSortKey, label: string, className = '') => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th
        scope="col"
        className={`px-2 py-1.5 text-left font-medium ${className}`}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-primary"
          onClick={() => toggleSort(key)}
          aria-label={t('bioEntity.sortBy', { column: label })}
        >
          {label}
          <Icon className="h-3 w-3 opacity-60" aria-hidden="true" />
        </button>
      </th>
    );
  };

  const measurementCell = (range: NumericRange | null, key: string) => {
    const text = formatMeasurement(range);
    return (
      <td key={key} className="whitespace-nowrap px-2 py-1.5 tabular-nums" title={range?.note || undefined}>
        {text || <span className="text-muted-foreground">—</span>}
        {text && range?.note ? <span className="text-muted-foreground" aria-hidden="true">*</span> : null}
      </td>
    );
  };

  const omissionSummary = (omitted: ActivityPlot['omitted']) =>
    `${t('bioEntity.plotOmitted', { count: omitted.length })} ${omissionReasons(omitted)
      .map((reason) => t(OMISSION_LABEL_KEYS[reason]))
      .join('; ')}`;

  return (
    <section className="mt-8 border-t border-border pt-6" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        {t('bioEntity.targetPharmacologyHeading')}{' '}
        <span className="text-sm font-normal text-muted-foreground">
          ({ligands.length})
        </span>
      </h2>

      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted-foreground">
            {t('bioEntity.targetSpecies')}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {SPECIES_OPTIONS.map((option) => (
              <label key={option.value} className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  name={speciesName}
                  value={option.value}
                  checked={species === option.value}
                  onChange={() => setSpecies(option.value)}
                />
                <span>
                  {t(option.labelKey)}{' '}
                  <span className="text-muted-foreground tabular-nums">
                    {counts[option.value]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {availableMetrics.length > 0 && metric && (
          <div className="flex flex-col">
            <label htmlFor={metricId} className="mb-1 text-xs font-medium text-muted-foreground">
              {t('bioEntity.targetMetric')}
            </label>
            <select
              id={metricId}
              className="rounded-md border border-border bg-background px-2 py-1"
              value={metric}
              onChange={(e) => setSelectedMetric(e.target.value as TargetMetric)}
            >
              {availableMetrics.map((m) => (
                <option key={m} value={m}>
                  {metricLabel(m)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {t('bioEntity.assayMeasurementDisclaimer')}
      </p>

      {plot && plot.pointCount > 0 && metric ? (
        <EntityTargetActivityPlot
          plot={plot}
          metricLabel={metricLabel(metric)}
          drugName={drugName}
          drugHref={drugHref}
          activityLabel={activityLabel}
          speciesLabel={speciesLabel}
        />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          {t('bioEntity.noPlottableMeasurements')}
        </p>
      )}
      {plot && plot.omitted.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="target-plot-omitted">
          {omissionSummary(plot.omitted)}
        </p>
      )}
      {unplottedOmissions.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" data-testid="target-plot-omitted">
          {unplottedOmissions.map(({ metric: m, omitted }) => (
            <li key={m}>
              {metricLabel(m)}: {omissionSummary(omitted)}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('bioEntity.targetLigands')}</caption>
          <thead className="bg-secondary text-xs">
            <tr>
              {sortHeader('drug', t('bioEntity.colDrug'))}
              {sortHeader('activity', t('bioEntity.colActivity'))}
              {sortHeader('ki', 'Ki')}
              {sortHeader('ec50', 'EC50')}
              {sortHeader('ic50', 'IC50')}
              {sortHeader('emax', t('bioEntity.colEmaxEfficacy'))}
              {optionalColumns.map((key) => (
                <th key={key} scope="col" className="px-2 py-1.5 text-left font-medium">
                  {metricLabel(key)}
                </th>
              ))}
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('bioEntity.colSpecies')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('bioEntity.colEvidence')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ligand) => {
              const name = drugName(ligand);
              const isOpen = expanded.has(ligand.relationshipId);
              const detailId = `${headingId}-detail-${ligand.relationshipId}`;
              const notes = (
                ['ki', 'ec50', 'ic50', 'emax', 'efficacy', 'affinity', 'potency', 'selectivityRatio'] as const
              )
                .map((key) => ({ key, note: ligand[key]?.note?.trim() }))
                .filter((n): n is { key: (typeof n)['key']; note: string } => !!n.note);
              const emaxText = formatMeasurement(ligand.emax);
              const efficacyText = formatMeasurement(ligand.efficacy);
              return (
                <Fragment key={ligand.relationshipId}>
                  <tr className="border-t border-border align-top" data-testid="target-ligand-row">
                    <td className="px-2 py-1.5">
                      <Link to={drugHref(ligand)} className="text-primary hover:underline">
                        {name}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">{activityLabel(ligand)}</td>
                    {measurementCell(ligand.ki, 'ki')}
                    {measurementCell(ligand.ec50, 'ec50')}
                    {measurementCell(ligand.ic50, 'ic50')}
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                      {emaxText || efficacyText ? (
                        <>
                          {emaxText && <div>{emaxText}</div>}
                          {efficacyText && (
                            <div className={emaxText ? 'text-muted-foreground' : ''}>
                              {metricLabel('efficacy')}: {efficacyText}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    {optionalColumns.map((key) => measurementCell(ligand[key], key))}
                    <td className="px-2 py-1.5">{speciesLabel(ligand)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        aria-label={t('bioEntity.detailsFor', { drug: name })}
                        onClick={() => toggleExpanded(ligand.relationshipId)}
                      >
                        {t('bioEntity.referenceCount', {
                          count: ligand.referenceIds.length,
                        })}
                        {' · '}
                        {isOpen ? t('bioEntity.hideDetails') : t('bioEntity.showDetails')}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={detailId} className="bg-muted/30">
                      <td colSpan={columnCount} className="space-y-1 px-2 py-2 text-xs">
                        {ligand.evidenceNote && (
                          <p>
                            <span className="font-medium">{t('bioEntity.evidenceNote')}:</span>{' '}
                            {ligand.evidenceNote}
                          </p>
                        )}
                        {notes.length > 0 && (
                          <p>
                            <span className="font-medium">{t('bioEntity.measurementNotes')}:</span>{' '}
                            {notes.map((n) => `${metricLabel(n.key)}: ${n.note}`).join(' · ')}
                          </p>
                        )}
                        {ligand.referenceIds.length > 0 && (
                          <p>
                            <span className="font-medium">{t('bioEntity.references')}:</span>{' '}
                            {ligand.referenceIds.map((id, i) => (
                              <Fragment key={id}>
                                {i > 0 ? ', ' : ''}
                                <Link to={referenceModulePath(id)} className="text-primary hover:underline">
                                  #{id}
                                </Link>
                              </Fragment>
                            ))}
                          </p>
                        )}
                        {!ligand.evidenceNote && notes.length === 0 && ligand.referenceIds.length === 0 && (
                          <p className="text-muted-foreground">{t('bioEntity.noEvidenceDetail')}</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
