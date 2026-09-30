import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteParameterEntry,
  fetchParameterEntries,
  type ParameterEntryRow,
} from '@/lib/parameterEntriesApi';
import { Button } from '@/components/ui/button';
import { ParameterEntryEditor } from '@/components/wiki/ParameterEntryEditor';
import { referenceModulePath } from '@/lib/referencesApi';
import { ROUTE_LABEL_KEYS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';
import { isQualifierOperator } from '@/types';
import {
  REFERENCE_MATRIX_LABEL_KEYS,
  REFERENCE_SCENARIO_LABEL_KEYS,
  type ReferenceMatrix,
  type ReferenceScenario,
} from '@/lib/referenceConcentrations';
import {
  getParameterLabelKey,
  isDrugParameterId,
} from '@/lib/drugParameters';
import {
  formatSummaryValue,
  type ParameterSummary,
} from '@/lib/parameterEntryAggregation';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import {
  convertParameterValue,
  formatUnitSuffix,
  preferredDisplayUnit,
} from '@/lib/parameterUnits';
import { getPreferredUnitDisplay } from '@/lib/unitTooltip';
import { entryCentralValue } from '@/lib/entryDoseContext';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';

interface Props {
  drugId: number;
  /** Narrow to a single parameter; otherwise all of the drug's entries. */
  parameter?: string;
  /** Aggregated summaries keyed by parameter, for the per-parameter headline. */
  summaries?: Record<string, ParameterSummary>;
  molecularWeight?: number | null;
  /** Show add/edit/delete controls (contributor+). */
  canEdit?: boolean;
  /** Admin writes apply directly; contributors submit for review. */
  isAdmin?: boolean;
  /**
   * Called after a mutation applies directly (admin path) so the parent can
   * reload the drug — the pooled summary and forest plot come from the parent
   * drugRow, not this component, and would otherwise stay stale until a refresh.
   */
  onMutated?: () => void;
  /**
   * Matrix frame the plot above is drawn in, when the reader moved it off whole
   * blood. Applies to the pooled headline only — the per-source rows deliberately
   * show what each source reported, in its own matrix.
   */
  pooledFrameMatrix?: ReferenceMatrix | null;
  /** The factor that frame implies for a pooled value (1 = whole blood). */
  pooledFrameScale?: number;
  /** Entry id to emphasize — the reader is hovering that marker in the plot. */
  highlightedEntryId?: number | null;
  /** Reports the entry id under the pointer so the plot can light its marker. */
  onHighlightEntry?: (entryId: number | null) => void;
}

/**
 * A row's labelled central value (mean, median, … — `doseContext.centralValue`),
 * or null for a legacy row whose centre, if any, is its bare `median`.
 */
function labelledCentre(row: ParameterEntryRow): number | null {
  return row.doseContext?.centralValue ?? null;
}

/** The centre a row reports, labelled or legacy. */
function rowCentre(row: ParameterEntryRow): number | null {
  return entryCentralValue({
    median: row.median,
    centralValue: row.doseContext?.centralValue,
  });
}

/** The authored figures, formatted in the unit the source itself used. */
function formatAuthoredValue(row: ParameterEntryRow): string {
  // A censored threshold takes precedence, so a "< 120" row (which may store
  // low = high = 120) is never shown as an exact 120–120 range. Only a
  // comparison operator is one: the entry schema allows nothing else in
  // `qualifier`, and a legacy row carrying prose there must not have it read as
  // part of the number — nor let its single-value branch hide a real low–high
  // span. Same rule as `formatRange` in rangeUtils.
  if (isQualifierOperator(row.qualifier)) {
    const v = row.high ?? row.median ?? row.low;
    return v != null ? `${row.qualifier} ${v}` : '—';
  }
  // A labelled centre is the reading; its interval is shown beside it, and
  // what each is (mean ± SD, median and range, …) on the meta line.
  const centre = labelledCentre(row);
  if (centre != null) {
    return row.low != null && row.high != null
      ? `${centre} (${row.low}–${row.high})`
      : `${centre}`;
  }
  if (row.low != null && row.high != null) return `${row.low}–${row.high}`;
  if (row.median != null) return `${row.median}`;
  if (row.low != null) return `≥ ${row.low}`;
  if (row.high != null) return `≤ ${row.high}`;
  return '—';
}

/**
 * A row's value as it should read on screen: re-expressed in the reader's
 * preferred concentration unit when that conversion is possible, otherwise the
 * authored figures verbatim. The authored numbers are never lost — they lead the
 * hover tooltip (see `sourceUnit` on UnitTooltip).
 *
 * Dimensionless parameters (logP, logD, pKa) store '' as their unit, so the
 * suffix is appended only when there is one — never a dangling space.
 */
function formatValueText(
  row: ParameterEntryRow,
  molecularWeight: number | null | undefined,
  enabledUnits: readonly string[] | null | undefined,
): { text: string; unit: string } {
  const qualifier = isQualifierOperator(row.qualifier) ? row.qualifier : null;
  const args = qualifier
    ? { value: row.high ?? row.median ?? row.low }
    : { value: rowCentre(row), low: row.low, high: row.high };
  const preferred = getPreferredUnitDisplay(
    args,
    row.unit,
    molecularWeight,
    enabledUnits,
  );
  const centre = qualifier ? null : labelledCentre(row);
  if (centre != null && row.low != null && row.high != null) {
    // Centre and interval converted separately, so the reading keeps its
    // "0.54 (0.42–0.66)" shape in the reader's unit too.
    const c = getPreferredUnitDisplay({ value: centre }, row.unit, molecularWeight, enabledUnits);
    const r = getPreferredUnitDisplay(
      { low: row.low, high: row.high },
      row.unit,
      molecularWeight,
      enabledUnits,
    );
    if (c && r) {
      return { text: `${c.formatted} (${r.formatted})${formatUnitSuffix(c.unit)}`, unit: c.unit };
    }
    return { text: `${formatAuthoredValue(row)}${formatUnitSuffix(row.unit)}`, unit: row.unit };
  }
  const unit = preferred?.unit ?? row.unit;
  const core = preferred
    ? `${qualifier ? `${qualifier} ` : ''}${preferred.formatted}`
    : formatAuthoredValue(row);
  return { text: `${core}${formatUnitSuffix(unit)}`, unit };
}

function formatMeta(
  row: ParameterEntryRow,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  // What the number is (mean, median, …) and what its bounds are (SD, range,
  // …) — first, because it decides how the figure itself is read.
  const statistic = row.doseContext?.centralStatistic;
  if (statistic) parts.push(t(`doseContext.values.centralStatistic.${statistic}`));
  const interval = row.doseContext?.intervalKind;
  if (interval) {
    parts.push(
      t('doseContext.interval', {
        kind: t(`doseContext.values.intervalKind.${interval}`),
      }),
    );
  }
  // Administration route (CV-2c-4): the most salient disambiguator for a per-route absorption/F
  // entry, so two otherwise-identical oral and intranasal rows read apart.
  if (row.route) {
    const key = ROUTE_LABEL_KEYS[row.route as RouteId];
    parts.push(key ? t(key) : row.route);
  }
  // Matrix and scenario are concentration dimensions; a matrix-independent
  // parameter (half-life, logP, B/P, …) stores null for both and its meta line
  // is just the sample size, if reported.
  if (row.matrix) {
    parts.push(
      t(
        REFERENCE_MATRIX_LABEL_KEYS[row.matrix as ReferenceMatrix] ??
          'parameterEntries.otherMatrix',
      ),
    );
  }
  // Scenario disambiguates same-matrix rows (e.g. postmortem mono/poly/non-intox
  // fatal concentrations), which is exactly what it is retained for.
  const scenarioKey = row.scenario
    ? REFERENCE_SCENARIO_LABEL_KEYS[row.scenario as ReferenceScenario]
    : undefined;
  if (scenarioKey) parts.push(t(scenarioKey));
  if (row.n != null) parts.push(`n = ${row.n}`);
  return parts.join(' · ');
}

// The stable English suffix migration 0078 appends to grandfathered rows'
// comments. Detected here so it can be localized instead of shown verbatim.
const GRANDFATHERED_COMMENT_SUFFIX =
  '[legacy value imported to parameter_entries; matrix defaulted to whole blood — verify]';

function formatComments(
  comments: string,
  t: (k: string) => string,
): string {
  if (!comments.includes(GRANDFATHERED_COMMENT_SUFFIX)) return comments;
  const authored = comments.replace(GRANDFATHERED_COMMENT_SUFFIX, '').trim();
  const note = t('parameterEntries.grandfatheredNote');
  return authored ? `${authored} ${note}` : note;
}

function citationTitle(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'title' in metadata) {
    const title = (metadata as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return null;
}

function summaryLine(
  summary: ParameterSummary,
  t: (k: string, o?: Record<string, unknown>) => string,
  molecularWeight: number | null | undefined,
  enabledUnits: readonly string[] | null | undefined,
  /** Matrix frame the plot above is drawn in, when it is not whole blood. */
  frameMatrix: ReferenceMatrix | null,
  /** The factor that frame implies for a pooled (blood-frame) value. */
  frameScale: number,
): string {
  if (summary.representative == null) {
    return t('parameterEntries.summary.noPooled');
  }
  // The pooled headline follows the same display unit as the rows and the plot
  // above it, so the three can be read as one figure in three resolutions.
  const unit = preferredDisplayUnit(summary.unit, enabledUnits, molecularWeight);
  const unitFactor =
    unit === summary.unit
      ? 1
      : (convertParameterValue(1, summary.unit, unit, molecularWeight) ?? 1);
  // The pool is whole-blood-normalized, so re-framing it is the same single
  // factor the plot applies to its pooled diamond. Both must move together —
  // two unlabelled numbers for one pooled estimate is worse than either alone.
  const factor = unitFactor * frameScale;
  const show = (v: number | null) =>
    formatSummaryValue(v == null ? null : v * factor);
  const iqr =
    summary.iqrLow != null && summary.iqrHigh != null
      ? ` (IQR ${show(summary.iqrLow)}–${show(summary.iqrHigh)})`
      : '';
  const value = `${show(summary.representative)}${formatUnitSuffix(unit)}${iqr}`;
  return frameMatrix
    ? t('parameterEntries.summary.lineFramed', {
        matrix: t(REFERENCE_MATRIX_LABEL_KEYS[frameMatrix]),
        value,
        count: summary.pooledCount,
      })
    : t('parameterEntries.summary.line', {
        value,
        count: summary.pooledCount,
      });
}

/**
 * Per-source list of a drug's parameter entries, grouped by parameter, each
 * with the aggregated headline value and the individual source rows (value,
 * matrix, sample size, citation link). Self-fetches; renders nothing when the
 * drug has no entries. No per-entry review-status badges (house rule) — that
 * lives in the discussion/history panels.
 */
export function ParameterEntryList({
  drugId,
  parameter,
  summaries,
  molecularWeight,
  canEdit = false,
  isAdmin = false,
  onMutated,
  pooledFrameMatrix = null,
  pooledFrameScale = 1,
  highlightedEntryId,
  onHighlightEntry,
}: Props) {
  const { t } = useTranslation();
  const enabledUnits = useAppStore((s) => s.enabledUnits);
  // `/api/drugs` — where the summary and the plot above come from — serves any
  // cookie-bearing request no-store, so every logged-in reader sees live
  // aggregates. This list has to draw the line in the same place or the two
  // disagree again for anyone who is signed in but cannot edit: a current plot
  // over source rows from the CDN's stale window.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [rows, setRows] = useState<ParameterEntryRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The active editor: { param } for a fresh add, { param, row } for an edit.
  const [editing, setEditing] = useState<{
    param: string;
    row?: ParameterEntryRow;
  } | null>(null);
  const reload = () => {
    setEditing(null);
    setReloadKey((k) => k + 1);
    // Direct writes recompute the server-side aggregate; ask the parent to reload
    // the drug so the summary/plot refresh too (a review submission changes
    // nothing live, but re-asking is harmless).
    onMutated?.();
  };

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    // Signed-in (and every editable) surface bypasses the CDN cache, so a reload
    // after a mutation shows the just-written state; anonymous reads keep the
    // cached response and the CDN benefit.
    fetchParameterEntries(drugId, {
      parameter,
      fresh: canEdit || isAuthenticated,
    })
      .then((items) => {
        if (!cancelled) setRows(items);
      })
      .catch(() => {
        // Don't silently collapse a failed/timed-out load into "no evidence":
        // the summary above may still advertise and plot source values. Surface
        // the failure so the audit list isn't misread as empty.
        if (!cancelled) {
          setRows([]);
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // `isAuthenticated` resolves after the session check, so it belongs in the
    // deps: the first render of a signed-in reader would otherwise keep the
    // cached list it fetched while the session was still unknown.
  }, [drugId, parameter, reloadKey, canEdit, isAuthenticated]);

  async function handleDelete(row: ParameterEntryRow) {
    if (!window.confirm(t('parameterEntries.editor.confirmDelete'))) return;
    try {
      await deleteParameterEntry(row.id, { submitForReview: !isAdmin });
      reload();
    } catch {
      setLoadError(true);
    }
  }

  const byParameter = useMemo(() => {
    const map = new Map<string, ParameterEntryRow[]>();
    for (const row of rows ?? []) {
      const list = map.get(row.parameter) ?? [];
      list.push(row);
      map.set(row.parameter, list);
    }
    return map;
  }, [rows]);

  // The add button, or the inline editor when this parameter is being edited.
  const renderFooter = (param: string) =>
    canEdit ? (
      editing && editing.param === param ? (
        <div className="mt-2">
          <ParameterEntryEditor
            drugId={drugId}
            parameter={param}
            row={editing.row}
            isAdmin={isAdmin}
            onSaved={reload}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => setEditing({ param })}
        >
          {t('parameterEntries.editor.add')}
        </Button>
      )
    ) : null;

  if (loadError) {
    return (
      <p className="mt-3 text-xs text-destructive">
        {t('parameterEntries.loadError')}
      </p>
    );
  }
  if (!rows) return null;
  // Empty but editable + scoped to one parameter → still expose an add affordance
  // so the FIRST source row can be created (a hand-authored value never creates
  // an entry, so without this the primary UI can't start the source set).
  if (rows.length === 0) {
    if (!canEdit || !parameter) return null;
    const paramLabel = isDrugParameterId(parameter)
      ? t(getParameterLabelKey(parameter))
      : parameter;
    return (
      <div className="mt-3">
        <h5 className="text-xs font-semibold text-foreground">{paramLabel}</h5>
        {renderFooter(parameter)}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {[...byParameter.entries()].map(([param, paramRows]) => {
        const paramLabel = isDrugParameterId(param)
          ? t(getParameterLabelKey(param))
          : param;
        const summary = summaries?.[param];
        return (
          <div key={param}>
            <h5 className="text-xs font-semibold text-foreground">
              {paramLabel}
            </h5>
            {summary && (
              <p className="text-xs text-muted-foreground">
                {summaryLine(
                  summary,
                  t,
                  molecularWeight,
                  enabledUnits,
                  // Only a whole-blood-normalized aggregate has a frame to move.
                  summary.normalizedToWholeBlood ? pooledFrameMatrix : null,
                  summary.normalizedToWholeBlood ? pooledFrameScale : 1,
                )}
              </p>
            )}
            <dl className="mt-1 space-y-1">
              {paramRows.map((row) => {
                const { text, unit } = formatValueText(
                  row,
                  molecularWeight,
                  enabledUnits,
                );
                return (
                  <div
                    key={row.id}
                    // Hovering a source row lights its marker in the plot above
                    // (and vice versa), so a value and its citation can be tied
                    // together without counting rows.
                    onMouseEnter={() => onHighlightEntry?.(row.id)}
                    onMouseLeave={() => onHighlightEntry?.(null)}
                    data-highlighted={highlightedEntryId === row.id || undefined}
                    className={`-mx-1 flex flex-wrap items-baseline gap-x-2 rounded px-1 text-sm ${
                      highlightedEntryId === row.id
                        ? 'bg-muted ring-1 ring-border'
                        : ''
                    }`}
                  >
                    <dt className="font-medium">
                      <UnitTooltip
                        value={rowCentre(row)}
                        low={row.low}
                        high={row.high}
                        // Values are shown in the reader's unit; the tooltip
                        // converts FROM what the source authored, so its first
                        // row is the raw reported figure.
                        unit={unit}
                        sourceUnit={row.unit}
                        molecularWeight={molecularWeight}
                      >
                        {text}
                      </UnitTooltip>
                    </dt>
                    <dd className="text-xs text-muted-foreground">
                      {formatMeta(row, t)}
                    </dd>
                    {row.citation ? (
                      <dd className="text-xs">
                        <a
                          href={referenceModulePath(row.citation.id)}
                          className="text-primary hover:underline"
                        >
                          {citationTitle(row.citation.metadata) ??
                            row.citation.identifier}
                        </a>
                      </dd>
                    ) : null}
                    {row.sourceQuote ? (
                      // Directly under the citation link, because the two
                      // belong together: the link says which document, this
                      // says what it actually says. Shown on the published
                      // list and not only in review, so a reader auditing a
                      // live value can check the number against the source's
                      // own words — which is the durable half of what the
                      // field is for. Set as a quotation so it does not read
                      // as another note.
                      <dd className="w-full border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                        {row.sourceQuote}
                      </dd>
                    ) : null}
                    {row.observationContext ? (
                      // Facts about the reading itself (migration 0120) — part
                      // of what the quote above attests to, unlike the curator
                      // notes below. Shown on the published list, like the quote.
                      <dd className="w-full text-xs text-muted-foreground">
                        {row.observationContext}
                      </dd>
                    ) : null}
                    {row.comments ? (
                      // Always shown, independent of the citation link — this is
                      // where source-specific notes and the grandfather import
                      // warning live. The stable English import suffix is swapped
                      // for a localized note; any authored prefix is preserved.
                      <dd className="w-full text-xs text-muted-foreground">
                        {formatComments(row.comments, t)}
                      </dd>
                    ) : null}
                    {/* A grandfathered placeholder is not real evidence: editing
                        it keeps origin='grandfathered', so the edit would be
                        silently dropped once a real source supersedes it. Direct
                        curation to Add (which creates a real source) instead. */}
                    {canEdit && row.origin !== 'grandfathered' && (
                      <dd className="flex gap-2 text-xs">
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setEditing({ param, row })}
                        >
                          {t('parameterEntries.editor.edit')}
                        </button>
                        <button
                          type="button"
                          className="text-destructive hover:underline"
                          onClick={() => handleDelete(row)}
                        >
                          {t('parameterEntries.editor.delete')}
                        </button>
                      </dd>
                    )}
                  </div>
                );
              })}
            </dl>
            {renderFooter(param)}
          </div>
        );
      })}
    </div>
  );
}

export default ParameterEntryList;
