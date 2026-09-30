import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReferenceInput } from '@/components/wiki/ReferenceInput';
import {
  REFERENCE_MATRICES,
  REFERENCE_MATRIX_LABEL_KEYS,
  REFERENCE_SCENARIOS,
  REFERENCE_SCENARIO_LABEL_KEYS,
  defaultScenarioForParameter,
  type ReferenceMatrix,
  type ReferenceScenario,
} from '@/lib/referenceConcentrations';
import {
  allowedValuesForParameter,
  getRangeSpec,
  isDrugParameterId,
  isModelStructureParameter,
  parameterIsMatrixRelevant,
  parameterIsRouteOptional,
  parameterIsRouteScoped,
  parameterIsScenarioRelevant,
} from '@/lib/drugParameters';
import { ROUTE_LABEL_KEYS, ROUTE_OPTIONS } from '@/lib/routeLabels';
import { entryUnitsForParameter } from '@/lib/parameterUnits';
import {
  normalizeSourceQuote,
  sourceQuoteComparisonKey,
  validateEntryForParameter,
} from '@/lib/parameterEntries';
import { QUALIFIER_OPERATORS } from '@/types';
import {
  CENTRAL_STATISTICS,
  INTERVAL_KINDS,
  isSymmetricInterval,
  type CentralStatistic,
  type IntervalKind,
} from '@/lib/entryDoseContext';
import {
  createParameterEntry,
  updateParameterEntry,
  type ParameterEntryRow,
  type ParameterEntryWriteInput,
} from '@/lib/parameterEntriesApi';

/**
 * Add or edit a single source entry for a summarizable parameter. Contributors
 * submit for review (submitForReview); admins write directly. Citation is picked
 * via the same resolver used elsewhere (DOI/PMID/freetext). Kept deliberately
 * compact — the review pipeline and aggregation enforce the real invariants; this
 * only does light client-side checks before the API round-trip.
 */
export interface ParameterEntryEditorProps {
  drugId: number;
  parameter: string;
  /** Present when editing an existing row; omit to add a new one. */
  row?: ParameterEntryRow;
  /** True for admins (direct write); contributors submit for review. */
  isAdmin: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

function numOrUndef(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function ParameterEntryEditor({
  drugId,
  parameter,
  row,
  isAdmin,
  onSaved,
  onCancel,
}: ParameterEntryEditorProps) {
  const { t } = useTranslation();
  const [low, setLow] = useState(row?.low != null ? String(row.low) : '');
  const [high, setHigh] = useState(row?.high != null ? String(row.high) : '');
  // The central number and what it is. A labelled row keeps its centre in
  // `doseContext.centralValue`; a legacy row in the bare `median` column, whose
  // number was "median preferred, mean fallback" — so its statistic starts
  // empty and saving asks the curator to say which it is rather than guessing.
  const [central, setCentral] = useState(() => {
    const v = row?.doseContext?.centralValue ?? row?.median;
    return v != null ? String(v) : '';
  });
  const [centralStatistic, setCentralStatistic] = useState<CentralStatistic | ''>(
    row?.doseContext?.centralStatistic ?? '',
  );
  const [intervalKind, setIntervalKind] = useState<IntervalKind | ''>(
    row?.doseContext?.intervalKind ?? '',
  );
  const [qualifier, setQualifier] = useState(row?.qualifier ?? '');
  // Which dimensions this parameter actually has. A concentration varies with
  // the sampled matrix and its interpretive scenario; a half-life, logP or
  // blood:plasma ratio has neither — forcing a matrix on those would invent a
  // dimension the source never reported. Both selects are hidden in that case
  // and the value is submitted without them.
  const known = isDrugParameterId(parameter);
  // A model-structure axis (dispositionModel / …, CV-1b) is categorical, not
  // numeric: the whole numeric form is replaced by one pick-from-a-list of the
  // axis's kinetics-core vocabulary, still cited like any other source entry.
  const isCategorical = known && isModelStructureParameter(parameter);
  const axisValues = isCategorical ? allowedValuesForParameter(parameter) : [];
  const showMatrix = known && !isCategorical && parameterIsMatrixRelevant(parameter);
  const showScenario =
    known && !isCategorical && parameterIsScenarioRelevant(parameter);
  // A route-scoped (`ka`) or route-optional (`absorptionModel`) parameter carries an administration
  // route (CV-2c / CV-2c-4); a route-scoped one REQUIRES it, a route-optional one may leave it
  // drug-level. Ordinary parameters render no route control and submit no route.
  const showRoute =
    known && (parameterIsRouteScoped(parameter) || parameterIsRouteOptional(parameter));
  const routeRequired = known && parameterIsRouteScoped(parameter);
  // Units the parameter itself accepts (every concentration unit for a
  // concentration; 'h', 'fraction', 'ratio' … otherwise; a single empty string
  // for the dimensionless logP/logD/pKa, which render no unit control at all).
  // Only numeric parameters have units — a model-structure axis has none, and
  // `getRangeSpec` below throws for its (non-range) spec, so it is fenced off by
  // `!isCategorical` rather than reached and caught.
  const numericKnown = known && !isCategorical;
  const unitOptions = numericKnown ? entryUnitsForParameter(parameter) : [];
  const defaultUnit = numericKnown
    ? (unitOptions.find((u) => u === getRangeSpec(parameter).canonicalUnit) ??
      unitOptions[0] ??
      '')
    : '';
  const [unit, setUnit] = useState<string>(row?.unit ?? defaultUnit);
  const [matrix, setMatrix] = useState<string>(row?.matrix ?? 'whole_blood');
  const [scenario, setScenario] = useState<string>(
    row?.scenario ?? defaultScenarioForParameter(parameter),
  );
  // Scenario and parameter are independent provenance (the schema accepts them
  // separately). Default to a parameter-appropriate scenario, but offer EVERY
  // scenario — the study context (e.g. a fatal level from a case report) may not
  // match the lossy legacy scenario→parameter bucket.
  const scenarioOptions = REFERENCE_SCENARIOS;
  const [n, setN] = useState(row?.n != null ? String(row.n) : '');
  const [observationContext, setObservationContext] = useState(
    row?.observationContext ?? '',
  );
  const [comments, setComments] = useState(row?.comments ?? '');
  const [quote, setQuote] = useState(row?.sourceQuote ?? '');

  /**
   * What to send for `quote`, which is not simply what is in the box.
   *
   * The server preserves an omitted quote only while the reading and citation
   * it is evidence for are unchanged, and clears it otherwise. That safeguard
   * is reached only when the field is actually ABSENT from the payload — and
   * this form, having initialized the box from the stored row, would otherwise
   * always resubmit the same text as an explicit value. A curator changing the
   * number without touching the quote box would then re-affirm the old sentence
   * as evidence for the new value, which is precisely what the server rule
   * exists to prevent, bypassed by the client.
   *
   * So an untouched quote is omitted and the decision left to the server, which
   * is the only party that can compare against what is actually stored. A quote
   * the curator edited is sent as what they wrote (or `null` if they cleared
   * it), because that is an explicit statement rather than an artefact of the
   * form being prefilled.
   */
  function submittedQuote(): string | null | undefined {
    // Compared the way the SERVER will store it. `sourceQuoteSchema` collapses
    // whitespace, so a box that differs from the stored row only by a rewrapped
    // line is not an edit: sending it would be an explicit quote, which is
    // exactly what switches off the server's preserve-or-clear safeguard, and
    // the value written would be the identical sentence anyway.
    // Compared on the key, which discounts characters that render as nothing;
    // SENT as the normalized text, because what the curator typed is what the
    // source says and stripping a joiner out of it would alter the quotation.
    if (
      sourceQuoteComparisonKey(quote) ===
      sourceQuoteComparisonKey(row?.sourceQuote ?? '')
    ) {
      return undefined;
    }
    return normalizeSourceQuote(quote) || null;
  }

  /**
   * What to send for `observationContext` — the same reasoning as
   * `submittedQuote`, for the same reason: the box is initialized from the
   * stored row, so an untouched box must not resubmit as an explicit value or
   * every save would re-affirm the old context as though the curator had just
   * typed it, which is what would let a save that touched nothing else read as
   * a deliberate (non-)change. Untouched is omitted (server preserves); edited
   * to blank is an explicit `null` (server clears) rather than the same
   * omission — the two are not the same "no context" until a curator has
   * actually cleared one that was there.
   */
  function submittedObservationContext(): string | null | undefined {
    const trimmed = observationContext.trim();
    const original = (row?.observationContext ?? '').trim();
    if (trimmed === original) return undefined;
    return trimmed || null;
  }
  const [citationId, setCitationId] = useState<number | null>(
    row?.citationId ?? null,
  );
  const [categoricalValue, setCategoricalValue] = useState<string>(
    row?.categoricalValue ?? axisValues[0] ?? '',
  );
  const [route, setRoute] = useState<string>(row?.route ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Persist the write; shared by the numeric and categorical submit paths. */
  async function persist(
    base: Omit<ParameterEntryWriteInput, 'drugId' | 'parameter'>,
  ): Promise<void> {
    if (validateEntryForParameter(parameter, base)) {
      setError(t('parameterEntries.editor.errorIncompatibleCombination'));
      return;
    }
    setSaving(true);
    try {
      if (row) {
        await updateParameterEntry(row.id, base);
      } else {
        await createParameterEntry({ drugId, parameter, ...base });
      }
      onSaved();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? t(`parameterEntries.editor.error_${code}`, {
              defaultValue: (e as Error).message,
            })
          : (e as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCategoricalSubmit() {
    setError(null);
    if (!categoricalValue) {
      setError(t('parameterEntries.editor.errorModelStructureRequired'));
      return;
    }
    if (citationId == null) {
      setError(t('parameterEntries.editor.errorCitationRequired'));
      return;
    }
    if (routeRequired && !route) {
      setError(t('parameterEntries.editor.errorRouteRequired'));
      return;
    }
    // A model-structure entry carries only its pick-list value, an optional route (CV-2c-4) and a
    // citation — no unit, matrix, scenario, n or numeric bounds. Context and the quote it is
    // evidence for are the exception: a categorical reading (an absorption model inferred from a
    // specific regimen, say) is still a reading, so both apply here exactly as on the numeric path.
    await persist({
      categoricalValue,
      unit: '',
      ...(showRoute && route ? { route } : {}),
      observationContext: submittedObservationContext(),
      quote: submittedQuote(),
      citationId,
      submitForReview: !isAdmin,
    });
  }

  async function handleSubmit() {
    setError(null);
    const lo = numOrUndef(low);
    const hi = numOrUndef(high);
    const md = numOrUndef(central);
    if (lo === undefined && hi === undefined && md === undefined) {
      setError(t('parameterEntries.editor.errorValueRequired'));
      return;
    }
    if (lo !== undefined && hi !== undefined && lo > hi) {
      setError(t('parameterEntries.editor.errorLowHigh'));
      return;
    }
    // Mirror the server invariants client-side so their (uncoded) 400s don't
    // surface untranslated: a median must sit within its own interval, and a
    // qualified (censored) entry is a single threshold value.
    if (
      md !== undefined &&
      ((lo !== undefined && md < lo) || (hi !== undefined && md > hi))
    ) {
      setError(t('parameterEntries.editor.errorMedianBounds'));
      return;
    }
    if (qualifier) {
      const present = [lo, hi, md].filter((v): v is number => v !== undefined);
      if (present.some((v) => v !== present[0])) {
        setError(t('parameterEntries.editor.errorQualifierSingle'));
        return;
      }
    }
    // The reported statistic (a censored threshold has none — its selects are
    // disabled). A NEW central value must say what it is: "not stated in the
    // source" is an answer, a blank is not, because a blank is exactly how a
    // mean came to be stored as a median. A legacy row whose centre the
    // curator left as it was may stay unlabelled — editing its notes must not
    // force a relabel (which would also detach its stored quote, since the
    // statistic is part of what the quote attests).
    const statistic = qualifier ? '' : centralStatistic;
    const kind = qualifier ? '' : intervalKind;
    // …but only while nothing else labels the reading: naming what low–high
    // is makes the entry a labelled one, and the server would then read the
    // bare centre as a median (`canonicalizeReportedStatistic`) — a claim the
    // curator never selected.
    const legacyCentreUntouched =
      row != null &&
      row.doseContext?.centralValue == null &&
      row.median != null &&
      md === row.median &&
      !kind;
    if (md !== undefined && !qualifier && !statistic && !legacyCentreUntouched) {
      setError(t('parameterEntries.editor.errorStatisticRequired'));
      return;
    }
    // A labelled centre beside unnamed bounds is still half-unlabelled:
    // say what low–high is ("not stated" is an answer).
    if (
      md !== undefined &&
      statistic &&
      (lo !== undefined || hi !== undefined) &&
      !kind
    ) {
      setError(t('parameterEntries.editor.errorIntervalKindRequired'));
      return;
    }
    if (kind && (lo === undefined || hi === undefined)) {
      setError(t('parameterEntries.editor.errorIntervalBounds'));
      return;
    }
    if ((kind === 'sd' || kind === 'sem') && md === undefined) {
      setError(t('parameterEntries.editor.errorIntervalCentre'));
      return;
    }
    if (
      (kind === 'sd' || kind === 'sem') &&
      md !== undefined &&
      lo !== undefined &&
      hi !== undefined &&
      !isSymmetricInterval(lo, md, hi)
    ) {
      setError(t('parameterEntries.editor.errorIntervalSymmetric'));
      return;
    }
    // A labelled centre is sent as `centralValue`; only a censored threshold
    // still uses the legacy `median` slot (its one shape on these parameters).
    const labelled = md !== undefined && !!statistic;
    if (citationId == null) {
      setError(t('parameterEntries.editor.errorCitationRequired'));
      return;
    }
    if (routeRequired && !route) {
      setError(t('parameterEntries.editor.errorRouteRequired'));
      return;
    }
    const base: Omit<ParameterEntryWriteInput, 'drugId' | 'parameter'> = {
      low: lo,
      high: hi,
      median: labelled ? undefined : md,
      ...(labelled ? { centralValue: md, centralStatistic: statistic || undefined } : {}),
      ...(kind ? { intervalKind: kind } : {}),
      qualifier: qualifier || undefined,
      unit,
      route: showRoute && route ? route : undefined,
      matrix: showMatrix ? matrix : undefined,
      scenario: showScenario ? scenario : undefined,
      n: numOrUndef(n),
      observationContext: submittedObservationContext(),
      comments: comments.trim() || undefined,
      quote: submittedQuote(),
      citationId,
      submitForReview: !isAdmin,
    };
    await persist(base);
  }

  const labelCls = 'text-[11px] font-medium text-muted-foreground';
  const selectCls =
    'w-full rounded border border-border bg-background px-2 py-1 text-sm';

  // The administration-route select, shared by the categorical (absorption) and numeric (route-scoped)
  // forms. A route-optional parameter offers a "drug-level" (no route) choice; a route-scoped one does
  // not. Null when the parameter carries no route.
  const routeField = showRoute ? (
    <label className="flex flex-col gap-0.5">
      <span className={labelCls}>{t('parameterEntries.editor.route')}</span>
      <select
        className={selectCls}
        value={route}
        onChange={(e) => setRoute(e.target.value)}
        aria-label={t('parameterEntries.editor.route')}
      >
        {!routeRequired && (
          <option value="">{t('parameterEntries.editor.routeDrugLevel')}</option>
        )}
        {ROUTE_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {t(ROUTE_LABEL_KEYS[r])}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  // Shared by BOTH submit paths. A model-structure axis is entry-backed and so
  // is high-risk for consensus auto-apply exactly like a numeric parameter —
  // an agent that cannot attach a quote to one cannot get it published at all,
  // it just sits pending forever. Defined once rather than duplicated so the
  // categorical branch cannot silently fall behind the numeric one again.
  const quoteField = (
    <label className="mt-2 flex flex-col gap-0.5">
      <span className={labelCls}>{t('parameterEntries.editor.quote')}</span>
      <textarea
        className={selectCls}
        rows={2}
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
      />
      <span className="text-[11px] text-muted-foreground">
        {t('parameterEntries.editor.quoteHint')}
      </span>
    </label>
  );

  // Shared by BOTH submit paths, like `quoteField` above: a model-structure
  // axis entry is a reading same as a numeric one — a categorical proposal
  // (e.g. an absorption model inferred from a specific dosing regimen) is just
  // as capable of carrying study context, and of having its stored quote
  // detached by a later context edit (#1257's whole point applies here too).
  const observationContextField = (
    <>
      <label className="mt-2 flex flex-col gap-0.5">
        <span className={labelCls}>
          {t('parameterEntries.editor.observationContext')}
        </span>
        <textarea
          className={selectCls}
          rows={2}
          value={observationContext}
          onChange={(e) => setObservationContext(e.target.value)}
        />
      </label>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {t('parameterEntries.editor.observationContextHint')}
      </p>
    </>
  );

  if (isCategorical) {
    return (
      <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>
            {t('parameterEntries.editor.modelStructureValue')}
          </span>
          <select
            className={selectCls}
            value={categoricalValue}
            onChange={(e) => setCategoricalValue(e.target.value)}
          >
            {axisValues.map((v) => (
              <option key={v} value={v}>
                {t(`parameters.modelStructure.value.${v}`, { defaultValue: v })}
              </option>
            ))}
          </select>
        </label>

        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('parameterEntries.editor.modelStructureHint')}
        </p>

        {routeField && <div className="mt-2">{routeField}</div>}

        {quoteField}
        {observationContextField}

        <div className="mt-2">
          <span className={labelCls}>
            {t('parameterEntries.editor.citation')}
            {citationId != null ? ` · #${citationId}` : ''}
          </span>
          <ReferenceInput
            drugId={drugId}
            required
            onReferenceCreated={(ref) => setCitationId(ref.id)}
          />
        </div>

        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={handleCategoricalSubmit}
          >
            {isAdmin
              ? t('parameterEntries.editor.save')
              : t('parameterEntries.editor.submit')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={onCancel}
          >
            {t('parameterEntries.editor.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.low')}</span>
          <Input
            type="number"
            value={low}
            onChange={(e) => setLow(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.high')}</span>
          <Input
            type="number"
            value={high}
            onChange={(e) => setHigh(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>
            {t('parameterEntries.editor.centralValue')}
          </span>
          <Input
            type="number"
            value={central}
            onChange={(e) => setCentral(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>
            {t('parameterEntries.editor.centralStatistic')}
          </span>
          <select
            className={selectCls}
            value={qualifier ? '' : centralStatistic}
            disabled={!!qualifier}
            onChange={(e) => setCentralStatistic(e.target.value as CentralStatistic | '')}
          >
            <option value="">—</option>
            {CENTRAL_STATISTICS.map((s) => (
              <option key={s} value={s}>
                {t(`doseContext.values.centralStatistic.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>
            {t('parameterEntries.editor.intervalKind')}
          </span>
          <select
            className={selectCls}
            value={qualifier ? '' : intervalKind}
            disabled={!!qualifier}
            onChange={(e) => setIntervalKind(e.target.value as IntervalKind | '')}
          >
            <option value="">—</option>
            {INTERVAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`doseContext.values.intervalKind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>
            {t('parameterEntries.editor.qualifier')}
          </span>
          <select
            className={selectCls}
            value={qualifier}
            onChange={(e) => setQualifier(e.target.value)}
          >
            <option value="">—</option>
            {QUALIFIER_OPERATORS.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
        {/* A dimensionless parameter (logP, logD, pKa) has exactly one allowed
            unit — the empty string — so there is nothing to choose; a
            single-unit parameter (h, fraction, ratio) shows it as a static
            label rather than a one-option dropdown. */}
        {unitOptions.length > 1 ? (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('parameterEntries.editor.unit')}</span>
            <select
              className={selectCls}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        ) : unit ? (
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('parameterEntries.editor.unit')}</span>
            <span className="px-2 py-1 text-sm text-muted-foreground">
              {unit}
            </span>
          </div>
        ) : null}
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>n</span>
          <Input
            type="number"
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
        </label>
        {showMatrix && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>
              {t('parameterEntries.editor.matrix')}
            </span>
            <select
              className={selectCls}
              value={matrix}
              onChange={(e) => setMatrix(e.target.value)}
            >
              {REFERENCE_MATRICES.map((m) => (
                <option key={m} value={m}>
                  {t(REFERENCE_MATRIX_LABEL_KEYS[m as ReferenceMatrix])}
                </option>
              ))}
            </select>
          </label>
        )}
        {showScenario && (
          <label className="col-span-2 flex flex-col gap-0.5">
            <span className={labelCls}>
              {t('parameterEntries.editor.scenario')}
            </span>
            <select
              className={selectCls}
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {scenarioOptions.map((s) => (
                <option key={s} value={s}>
                  {t(REFERENCE_SCENARIO_LABEL_KEYS[s as ReferenceScenario])}
                </option>
              ))}
            </select>
          </label>
        )}
        {routeField}
      </div>

      {/* Without a matrix/scenario dropdown, the study context (population,
          route, assay — why this source differs from the next) has nowhere to
          go but the field below. Say so instead of leaving a bare textarea. */}
      {!showMatrix && !showScenario && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('parameterEntries.editor.contextHint')}
        </p>
      )}

      {/*
        The source's own words for this value. Placed above the observation
        context and notes because it carries more weight than either: this is
        the evidence a reviewer checks the number against.
      */}
      {quoteField}

      {/*
        Facts about the READING (dose, fed/fasted state, population, assay
        method) — part of what the quote above attests to, so editing this
        detaches a stored quote the same way editing the value does. Kept
        separate from the notes below, which are curator commentary about the
        row and never affect the quote (#1257).
      */}
      {observationContextField}

      <label className="mt-2 flex flex-col gap-0.5">
        <span className={labelCls}>
          {t('parameterEntries.editor.comments')}
        </span>
        <textarea
          className={selectCls}
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
        />
      </label>

      <div className="mt-2">
        <span className={labelCls}>
          {t('parameterEntries.editor.citation')}
          {citationId != null ? ` · #${citationId}` : ''}
        </span>
        <ReferenceInput
          drugId={drugId}
          required
          onReferenceCreated={(ref) => setCitationId(ref.id)}
        />
      </div>

      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" disabled={saving} onClick={handleSubmit}>
          {isAdmin
            ? t('parameterEntries.editor.save')
            : t('parameterEntries.editor.submit')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          {t('parameterEntries.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}

export default ParameterEntryEditor;
