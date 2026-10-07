/**
 * Cmax source values on a drug's monograph (Cmax dose-context RFC, release C).
 *
 * Cmax has no drug-level value: a peak concentration means nothing without
 * the dose, regimen, formulation and population behind it, so there is no
 * single number to show in the parameter rows above. This section lists the
 * cited readings themselves, each with its full context, and lets editors add,
 * edit and remove them. The "per dose" view shows the dose-normalized
 * summary: one pooled number only when every combinable reading shares one
 * dosing context, and on every reading either its normalized value or the
 * reason it was left out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CmaxEntryEditor } from '@/components/wiki/CmaxEntryEditor';
import { DoseContextDetails } from '@/components/review/DoseContextDetails';
import {
  deleteParameterEntry,
  fetchCmaxSummary,
  fetchParameterEntries,
  type ParameterEntryRow,
} from '@/lib/parameterEntriesApi';
import type { CmaxStratum, CmaxSummary, NormalizationOutcome } from '@/lib/cmaxNormalization';
import type { TFunction } from 'i18next';
import { referenceModulePath } from '@/lib/referencesApi';
import {
  REFERENCE_MATRIX_LABEL_KEYS,
  type ReferenceMatrix,
} from '@/lib/referenceConcentrations';
import { ROUTE_LABEL_KEYS } from '@/lib/routeLabels';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { useEthanolScopeUnit } from '@/components/ui/DrugUnitScope';
import { getPreferredUnitDisplay } from '@/lib/unitTooltip';
import type { RouteId } from '@/lib/kinetics-core';

interface Props {
  drugId: number;
  drugName: string;
  canEdit?: boolean;
  isAdmin?: boolean;
  onMutated?: () => void;
  /** Lets a molar reading convert into the ethanol unit (‰, %). */
  molecularWeight?: number | null;
}

/** "84 ng/mL (70–98)", or "< 5 ng/mL" for a censored threshold. */
export function formatCmaxValue(e: ParameterEntryRow): string {
  const centre = e.doseContext?.centralValue ?? e.median ?? null;
  const unit = e.unit ? ` ${e.unit}` : '';
  if (e.qualifier && centre != null) return `${e.qualifier} ${centre}${unit}`;
  const bounds = e.low != null && e.high != null ? `${e.low}–${e.high}` : null;
  if (centre != null) return `${centre}${unit}${bounds ? ` (${bounds})` : ''}`;
  return bounds ? `${bounds}${unit}` : '—';
}

/**
 * The same reading re-expressed in `targetUnit` — the reader's ethanol unit on
 * an ethanol monograph — keeping the "centre (low–high)" shape. Null when it
 * stays as authored: no target, a per-dose unit, or a molar reading with no
 * molecular weight to convert through.
 */
export function formatCmaxValueIn(
  e: ParameterEntryRow,
  targetUnit: string | null,
  molecularWeight: number | null | undefined,
): string | null {
  if (!targetUnit || !e.unit || e.unit === targetUnit) return null;
  const convert = (v: number | null): string | null | undefined =>
    v == null
      ? undefined
      : (getPreferredUnitDisplay({ value: v }, e.unit, molecularWeight, [targetUnit])
          ?.formatted ?? null);
  const centre = convert(e.doseContext?.centralValue ?? e.median ?? null);
  const low = convert(e.low);
  const high = convert(e.high);
  if (centre === null || low === null || high === null) return null;
  const unit = ` ${targetUnit}`;
  if (e.qualifier && centre != null) return `${e.qualifier} ${centre}${unit}`;
  const bounds = low != null && high != null ? `${low}–${high}` : null;
  if (centre != null) return `${centre}${unit}${bounds ? ` (${bounds})` : ''}`;
  return bounds ? `${bounds}${unit}` : null;
}

/** Three significant digits, without trailing zeros: 0.0123, 1.5, 240. */
export function formatNormalized(v: number): string {
  return String(Number(v.toPrecision(3)));
}

type Mode = 'observed' | 'normalized';

/**
 * What a stratum's readings share, in words: "2 mg as free base · Oral ·
 * Immediate release · Tablet or capsule · Single dose · Fasted · Healthy
 * adults · Arithmetic mean". Strata are labelled, never collapsed into one
 * number (RFC, *UI* tests), so the label names every dimension of the pooling
 * key (`cmaxPoolingKey`) that can tell two strata apart: two that differ only
 * in, say, the infusion time must not read the same. The normalized unit and
 * matrix are shown with the value, and a poolable reading is always
 * monotherapy, so those are left out. The value basis is always named, and
 * the dosed substance whenever it is not the page's own drug.
 */
export function stratumLabel(
  t: TFunction,
  s: CmaxStratum,
  opts: { ownDrugId?: number; siblings?: readonly CmaxStratum[] } = {},
): string {
  const c = s.context;
  const d = c.doseStratum;
  const vocab = (field: string, value: string | null) =>
    value == null ? null : t(`doseContext.values.${field}.${value}`, { defaultValue: value });
  const doseLevel =
    d.kind === 'exact'
      ? t('doseContext.doseExact', { value: d.value, unit: d.unit })
      : d.kind === 'range'
        ? t('doseContext.doseRange', { low: d.low, high: d.high, unit: d.unit })
        : t('cmax.doseUnstated');
  const basis =
    c.doseBasis == null
      ? null
      : t('doseContext.doseBasisAs', {
          basis:
            c.doseBasis === 'salt' && c.doseSaltForm
              ? `${vocab('doseBasis', c.doseBasis)} (${c.doseSaltForm})`
              : vocab('doseBasis', c.doseBasis),
        });
  const route = ROUTE_LABEL_KEYS[c.route as RouteId] ? t(ROUTE_LABEL_KEYS[c.route as RouteId]) : c.route;
  return [
    basis ? `${doseLevel} ${basis}` : doseLevel,
    route,
    vocab('ivInputMode', c.ivInputMode),
    c.administrationDurationMin != null
      ? t('doseContext.overMinutes', { minutes: c.administrationDurationMin })
      : null,
    vocab('releaseProfile', c.releaseProfile === 'not_applicable' ? null : c.releaseProfile),
    vocab('physicalForm', c.physicalForm),
    vocab('doseRegimen', c.regimen),
    c.doseIntervalHours != null ? t('doseContext.everyHours', { hours: c.doseIntervalHours }) : null,
    c.doseNumber != null ? t('doseContext.doseNumber', { number: c.doseNumber }) : null,
    c.regimenDurationHours != null
      ? t('doseContext.afterHours', { hours: c.regimenDurationHours })
      : null,
    vocab('prandialState', c.prandialState),
    vocab('pkPopulation', c.pkPopulation),
    vocab('centralStatistic', c.centralStatistic),
    // Always named: a ratio derived from a concentration and one the source
    // reported directly are different kinds of evidence, and the summary says
    // which it is showing (RFC, value basis).
    vocab('valueBasis', c.valueBasis),
    opts.ownDrugId != null && c.administeredDrugId !== opts.ownDrugId
      ? t('doseContext.drugRef', { id: c.administeredDrugId })
      : null,
  ]
    .filter((p): p is string => !!p)
    .join(' · ');
}

/** "SD 0.12–0.16": a reported interval, converted, with what it is. */
function intervalText(
  t: TFunction,
  low: number,
  high: number,
  kind: string | null,
): string {
  const range = `${formatNormalized(low)}–${formatNormalized(high)}`;
  return kind ? `${t(`doseContext.values.intervalKind.${kind}`, { defaultValue: kind })} ${range}` : range;
}

function outcomeEntryId(o: NormalizationOutcome): number {
  return o.kind === 'ineligible' ? o.entryId : o.entry.entryId;
}

export function CmaxSection({
  drugId,
  drugName,
  canEdit = false,
  isAdmin = false,
  onMutated,
  molecularWeight = null,
}: Props) {
  const { t } = useTranslation();
  // Readings are listed as authored, except on ethanol, which follows the
  // reader's ethanol unit like every other ethanol concentration on the page.
  const ethanolUnit = useEthanolScopeUnit();
  const [entries, setEntries] = useState<ParameterEntryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('observed');
  const [summary, setSummary] = useState<CmaxSummary | null>(null);
  // The rows the summary was computed from: the per-dose view lists these, so
  // its headline and its rows always come from one snapshot.
  const [summaryItems, setSummaryItems] = useState<ParameterEntryRow[] | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const loadTokenRef = useRef(0);
  const summaryTokenRef = useRef(0);
  const currentDrugIdRef = useRef(drugId);
  currentDrugIdRef.current = drugId;

  const load = useCallback(async () => {
    const token = ++loadTokenRef.current;
    const forDrug = drugId;
    try {
      const rows = await fetchParameterEntries(forDrug, { parameter: 'cmax', fresh: canEdit });
      if (token !== loadTokenRef.current || forDrug !== currentDrugIdRef.current) return;
      setEntries(rows);
      setLoadFailed(false);
    } catch {
      if (token !== loadTokenRef.current || forDrug !== currentDrugIdRef.current) return;
      setLoadFailed(true);
      // The rows on screen may no longer be what the server holds (a reload
      // after an edit failed), and the per-dose summary is only refreshed when
      // the rows change: without this, the old summary would stay up unmarked.
      ++summaryTokenRef.current;
      setSummary(null);
      setSummaryItems(null);
      setSummaryFailed(true);
    } finally {
      if (token === loadTokenRef.current && forDrug === currentDrugIdRef.current) setLoaded(true);
    }
  }, [drugId, canEdit]);

  const loadSummary = useCallback(async () => {
    const token = ++summaryTokenRef.current;
    const forDrug = drugId;
    try {
      const next = await fetchCmaxSummary(forDrug, { fresh: canEdit });
      if (token !== summaryTokenRef.current || forDrug !== currentDrugIdRef.current) return;
      setSummary(next.summary);
      setSummaryItems(next.items);
      setSummaryFailed(false);
    } catch {
      if (token !== summaryTokenRef.current || forDrug !== currentDrugIdRef.current) return;
      // Drop the previous summary rather than keep it: it was computed from
      // the entries as they were, and beside the refreshed rows it would be
      // an unmarked, stale per-dose number. The error and retry show instead.
      setSummary(null);
      setSummaryItems(null);
      setSummaryFailed(true);
    }
  }, [drugId, canEdit]);

  // The summary is fetched only once someone asks for it, and again after
  // every change to the entries while the view is open.
  useEffect(() => {
    setSummary(null);
    setSummaryItems(null);
    setSummaryFailed(false);
  }, [drugId]);
  // A summary already held is current by construction: every change to the
  // entries drops it (invalidateSummary, a failed reload), so switching back to
  // the per-dose view reuses it instead of refetching.
  const summaryHeldRef = useRef(false);
  summaryHeldRef.current = summary !== null;
  useEffect(() => {
    if (mode === 'normalized' && !summaryHeldRef.current) void loadSummary();
  }, [mode, loadSummary, entries]);

  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    setLoadFailed(false);
    setActionFailed(false);
    setAdding(false);
    setEditingId(null);
    void load();
  }, [load]);

  /**
   * A change to the entries makes the current per-dose summary stale at once,
   * not only when the reload that follows succeeds: drop it (and any summary
   * request still in flight) as the change is made.
   */
  function invalidateSummary() {
    ++summaryTokenRef.current;
    setSummary(null);
    setSummaryItems(null);
    setSummaryFailed(false);
  }

  async function handleDelete(id: number) {
    if (!window.confirm(t('parameterEntries.editor.confirmDelete'))) return;
    setActionFailed(false);
    invalidateSummary();
    try {
      await deleteParameterEntry(id, { submitForReview: !isAdmin });
      await load();
      onMutated?.();
    } catch {
      setActionFailed(true);
      // The delete may or may not have committed (a lost response is a
      // failure here too), so neither side of the toggle can be trusted:
      // reload the rows. A successful reload refetches the summary through
      // the rows changing; a failed one shows the stale warning and marks the
      // summary failed, never leaving it on "loading".
      void load();
    }
  }

  function saved() {
    setAdding(false);
    setEditingId(null);
    invalidateSummary();
    void load();
    onMutated?.();
  }

  if (loadFailed && entries.length === 0) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="cmax-section">
        <span role="alert">{t('cmax.loadError')}</span>
        <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => void load()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="cmax-section">
        {t('common.loading')}
      </p>
    );
  }
  if (entries.length === 0 && !canEdit) return null;

  const outcomes = new Map<number, NormalizationOutcome>(
    mode === 'normalized' && summary ? summary.outcomes.map((o) => [outcomeEntryId(o), o]) : [],
  );
  // A source-reported ratio has no observed concentration to show, so Observed
  // mode lists only concentrations (RFC: "shows such an entry only in
  // normalized mode"). A row being edited stays, whatever its basis.
  //
  // The per-dose view lists the rows its summary was computed from, not the
  // separately fetched (and separately cached) list, so a headline and the
  // rows beside it never come from different moments.
  const visibleEntries =
    mode === 'observed'
      ? entries.filter((e) => e.doseContext?.valueBasis !== 'dose_normalized' || e.id === editingId)
      : (summaryItems ?? entries);

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="cmax-section">
      <div className="mb-2 flex items-center justify-between gap-1">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground">{t('cmax.heading')}</h4>
          <p className="text-[11px] text-muted-foreground">{t('cmax.hint')}</p>
        </div>
        {canEdit && !adding && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            title={t('cmax.add')}
            aria-label={t('cmax.add')}
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3 w-3" />
          </Button>
        )}
      </div>
      {entries.length > 0 && (
        <div className="mb-2 inline-flex rounded border border-border text-[11px]" role="group">
          {(['observed', 'normalized'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              className={`px-2 py-0.5 ${mode === m ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
              onClick={() => setMode(m)}
            >
              {t(m === 'observed' ? 'cmax.modeObserved' : 'cmax.modeNormalized')}
            </button>
          ))}
        </div>
      )}
      {mode === 'normalized' && entries.length > 0 && (
        <CmaxHeadlineBlock
          summary={summary}
          failed={summaryFailed}
          // With the rows themselves stale, retry reloads them; the summary
          // follows once they change.
          onRetry={() => void (loadFailed ? load() : loadSummary())}
          drugId={drugId}
        />
      )}
      {loadFailed && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span role="alert">{t('cmax.staleError')}</span>
          <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {actionFailed && (
        <p className="mb-2 text-xs text-destructive" role="alert">
          {t('cmax.actionError')}
        </p>
      )}
      {adding && (
        <CmaxEntryEditor
          drugId={drugId}
          drugName={drugName}
          isAdmin={isAdmin}
          onSaved={saved}
          onCancel={() => setAdding(false)}
        />
      )}
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('cmax.empty')}</p>
      ) : visibleEntries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('cmax.observedNone')}</p>
      ) : (
        <ul className="space-y-2">
          {visibleEntries.map((e) =>
            editingId === e.id ? (
              <li key={e.id}>
                <CmaxEntryEditor
                  drugId={drugId}
                  drugName={drugName}
                  row={e}
                  isAdmin={isAdmin}
                  onSaved={saved}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={e.id} className="rounded border border-border bg-muted/20 p-2" data-testid="cmax-entry">
                <div className="flex items-start justify-between gap-2">
                  <span>
                    <span className="font-medium">
                      <CmaxReading entry={e} targetUnit={ethanolUnit} molecularWeight={molecularWeight} />
                    </span>
                    {mode === 'normalized' && outcomes.has(e.id) && (
                      <NormalizedValue outcome={outcomes.get(e.id)!} />
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    {e.citationId != null && (
                      <a href={referenceModulePath(e.citationId)} className="text-xs text-primary hover:underline">
                        #{e.citationId}
                      </a>
                    )}
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          title={t('common.edit')}
                          aria-label={t('common.edit')}
                          onClick={() => setEditingId(e.id)}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                          onClick={() => void handleDelete(e.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
                  {e.matrix && (
                    <>
                      <dt className="text-muted-foreground">{t('parameterEntries.editor.matrix')}</dt>
                      <dd>{t(REFERENCE_MATRIX_LABEL_KEYS[e.matrix as ReferenceMatrix] ?? 'parameterEntries.otherMatrix')}</dd>
                    </>
                  )}
                  {e.route && (
                    <>
                      <dt className="text-muted-foreground">{t('parameterEntries.editor.route')}</dt>
                      <dd>{ROUTE_LABEL_KEYS[e.route as RouteId] ? t(ROUTE_LABEL_KEYS[e.route as RouteId]) : e.route}</dd>
                    </>
                  )}
                  {e.n != null && (
                    <>
                      <dt className="text-muted-foreground">n</dt>
                      <dd>{e.n}</dd>
                    </>
                  )}
                  <DoseContextDetails fields={e.doseContext ?? {}} />
                </dl>
                {e.sourceQuote && (
                  <p className="mt-1 border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground">
                    {e.sourceQuote}
                  </p>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** One reading: converted (authored figure on hover) or verbatim. */
function CmaxReading({
  entry,
  targetUnit,
  molecularWeight,
}: {
  entry: ParameterEntryRow;
  targetUnit: string | null;
  molecularWeight: number | null;
}) {
  const converted = formatCmaxValueIn(entry, targetUnit, molecularWeight);
  if (converted == null || targetUnit == null) return <>{formatCmaxValue(entry)}</>;
  return (
    <UnitTooltip
      value={entry.doseContext?.centralValue ?? entry.median ?? null}
      low={entry.low}
      high={entry.high}
      unit={targetUnit}
      sourceUnit={entry.unit}
      molecularWeight={molecularWeight}
    >
      {converted}
    </UnitTooltip>
  );
}

function CmaxHeadlineBlock({
  summary,
  failed,
  onRetry,
  drugId,
}: {
  summary: CmaxSummary | null;
  failed: boolean;
  onRetry: () => void;
  drugId: number;
}) {
  const { t } = useTranslation();
  if (failed && !summary) {
    return (
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span role="alert">{t('cmax.summaryError')}</span>
        <Button variant="outline" size="sm" className="h-6 px-2" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!summary) {
    return <p className="mb-2 text-xs text-muted-foreground">{t('common.loading')}</p>;
  }
  const h = summary.headline;
  let text: string;
  if (h.kind === 'single') {
    text = stratumValueText(t, h.stratum);
  } else if (h.kind === 'multiple') {
    text = t('cmax.headlineMultiple', { count: h.strata });
  } else {
    text = t('cmax.headlineNone');
  }
  return (
    <div className="mb-2 rounded border border-border bg-muted/30 p-2 text-xs" data-testid="cmax-headline">
      <p className={h.kind === 'single' ? 'font-medium' : undefined}>{text}</p>
      {h.kind === 'single' && (
        <p className="text-[11px] text-muted-foreground" data-testid="cmax-stratum">
          {stratumLabel(t, h.stratum, { ownDrugId: drugId })}
        </p>
      )}
      {h.kind === 'multiple' && (
        <ul className="mt-1 space-y-0.5">
          {summary.strata.map((s) => (
            <li key={s.key} data-testid="cmax-stratum">
              <span className="text-muted-foreground">{stratumLabel(t, s, { ownDrugId: drugId, siblings: summary.strata })}:</span>{' '}
              <span className="font-medium">{stratumValueText(t, s)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-0.5 text-[11px] text-muted-foreground">{t('cmax.normalizedHint')}</p>
    </div>
  );
}

/**
 * A stratum's number, with what it is and how uncertain: "0.14 µmol/L per mg:
 * weighted median of 3 cohorts; between-cohort spread 0.12–0.16", or for one
 * cohort its own reported interval, converted like its centre ("0.14 µmol/L
 * per mg (one cohort); SD 0.12–0.16"). The same text whether the stratum is
 * the only one or one of several, so a stratum never loses its estimator or
 * its uncertainty because another dosing context exists.
 */
function stratumValueText(t: TFunction, s: CmaxStratum): string {
  const unit = s.context.normalizedUnit;
  if (s.cohorts === 1) {
    return `${t('cmax.headlineSingleOne', { value: formatNormalized(s.value), unit })}${
      s.ownInterval ? `; ${intervalText(t, s.ownInterval.low, s.ownInterval.high, s.ownInterval.kind)}` : ''
    }`;
  }
  return `${t('cmax.headlineSingle', { value: formatNormalized(s.value), unit, count: s.cohorts })}${
    s.spread
      ? `; ${t('cmax.spread', { low: formatNormalized(s.spread.low), high: formatNormalized(s.spread.high) })}`
      : ''
  }`;
}

function NormalizedValue({ outcome }: { outcome: NormalizationOutcome }) {
  const { t } = useTranslation();
  if (outcome.kind === 'ineligible') {
    return (
      <span className="ml-2 text-[11px] text-muted-foreground" data-testid="cmax-normalized">
        {t('cmax.excluded')}: {t(`cmax.reasons.${outcome.reason}`)}
      </span>
    );
  }
  const e = outcome.entry;
  const bounds =
    e.normalizedLow != null && e.normalizedHigh != null
      ? intervalText(t, e.normalizedLow, e.normalizedHigh, e.intervalKind)
      : null;
  const value =
    e.normalizedCentralValue != null
      ? `${e.qualifier ? `${e.qualifier} ` : ''}${formatNormalized(e.normalizedCentralValue)}${
          bounds ? ` (${bounds})` : ''
        }`
      : bounds;
  return (
    <span className="ml-2 text-[11px] text-muted-foreground" data-testid="cmax-normalized">
      {value != null && `→ ${value} ${e.normalizedUnit}`}
      {outcome.kind === 'normalized_not_poolable' &&
        ` (${t('cmax.notPooled')}: ${t(`cmax.reasons.${outcome.reason}`)})`}
    </span>
  );
}

export default CmaxSection;
