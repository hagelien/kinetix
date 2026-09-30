/**
 * Add or edit one Cmax source value with its structured dose context (Cmax
 * dose-context RFC, release C).
 *
 * A separate form from `ParameterEntryEditor` because a Cmax reading is not a
 * number plus a unit: it is a number plus WHAT the number is (value basis,
 * statistic, interval) and WHAT produced it (dose, regimen, formulation,
 * route, fed state, who was dosed with what, in whom). The form shows each
 * group only where it applies — an interval kind only with bounds, a salt form
 * only with a salt basis, an infusion time only for an IV infusion — so the
 * shapes the RFC forbids are hard to author in the first place, and the shared
 * validator (`validateEntryForParameter`) refuses the rest before the request.
 *
 * Everything the source may not state defaults to "not stated": the RFC's
 * posture is that silence is stored honestly and excluded from the summary
 * later, never guessed.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReferenceInput } from '@/components/wiki/ReferenceInput';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import {
  REFERENCE_MATRICES,
  REFERENCE_MATRIX_LABEL_KEYS,
  type ReferenceMatrix,
} from '@/lib/referenceConcentrations';
import { ROUTE_LABEL_KEYS, ROUTE_OPTIONS } from '@/lib/routeLabels';
import { validateEntryForParameter } from '@/lib/parameterEntries';
import {
  canonicalizeReportedStatistic,
  CENTRAL_STATISTICS,
  CMAX_CONCENTRATION_UNITS,
  COADMINISTRATION_STATES,
  DOSE_BASES,
  DOSE_CONTEXT_DOSE_UNITS,
  DOSE_NORMALIZED_UNITS,
  DOSE_REGIMENS,
  INTERVAL_KINDS,
  IV_INPUT_MODES,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  PRANDIAL_STATES,
  RELEASE_PROFILES,
  type DoseContextFields,
} from '@/lib/entryDoseContext';
import { resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { QUALIFIER_OPERATORS } from '@/types';
import {
  createParameterEntry,
  updateParameterEntry,
  type DoseContextEntryWriteInput,
  type ParameterEntryRow,
} from '@/lib/parameterEntriesApi';

export interface CmaxEntryEditorProps {
  drugId: number;
  /** The analyte's display name, for the "dosed with this substance" choice. */
  drugName: string;
  row?: ParameterEntryRow;
  isAdmin: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

type DoseShape = 'exact' | 'range' | 'none';

function num(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

export function CmaxEntryEditor({
  drugId,
  drugName,
  row,
  isAdmin,
  onSaved,
  onCancel,
}: CmaxEntryEditorProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const dc: DoseContextFields = row?.doseContext ?? {};

  // ── The number and what it is ──
  const [valueBasis, setValueBasis] = useState<string>(dc.valueBasis ?? 'concentration');
  const [centralValue, setCentralValue] = useState(str(dc.centralValue));
  const [centralStatistic, setCentralStatistic] = useState<string>(dc.centralStatistic ?? '');
  const [low, setLow] = useState(str(row?.low));
  const [high, setHigh] = useState(str(row?.high));
  const [intervalKind, setIntervalKind] = useState<string>(dc.intervalKind ?? '');
  const [qualifier, setQualifier] = useState(row?.qualifier ?? '');
  const unitOptions =
    valueBasis === 'dose_normalized' ? DOSE_NORMALIZED_UNITS : CMAX_CONCENTRATION_UNITS;
  const [unit, setUnit] = useState<string>(row?.unit ?? 'ng/mL');
  const [matrix, setMatrix] = useState<string>(row?.matrix ?? 'plasma');
  const [route, setRoute] = useState<string>(row?.route ?? '');
  const [n, setN] = useState(str(row?.n));

  // ── The dose ──
  const [doseShape, setDoseShape] = useState<DoseShape>(
    dc.doseValue != null ? 'exact' : dc.doseLow != null ? 'range' : row ? 'none' : 'exact',
  );
  const [doseValue, setDoseValue] = useState(str(dc.doseValue));
  const [doseLow, setDoseLow] = useState(str(dc.doseLow));
  const [doseHigh, setDoseHigh] = useState(str(dc.doseHigh));
  const [doseUnit, setDoseUnit] = useState<string>(dc.doseUnit ?? 'mg');
  const [doseBasis, setDoseBasis] = useState<string>(dc.doseBasis ?? '');
  const [doseSaltForm, setDoseSaltForm] = useState(dc.doseSaltForm ?? '');

  // ── Regimen ──
  const [doseRegimen, setDoseRegimen] = useState<string>(dc.doseRegimen ?? '');
  const [doseIntervalHours, setDoseIntervalHours] = useState(str(dc.doseIntervalHours));
  const [doseNumber, setDoseNumber] = useState(str(dc.doseNumber));
  const [regimenDurationHours, setRegimenDurationHours] = useState(
    str(dc.regimenDurationHours),
  );
  const [priorDosingRegular, setPriorDosingRegular] = useState<string>(
    dc.priorDosingRegular == null ? '' : dc.priorDosingRegular ? 'yes' : 'no',
  );

  // ── Administration ──
  const [ivInputMode, setIvInputMode] = useState<string>(dc.ivInputMode ?? '');
  const [administrationDurationMin, setAdministrationDurationMin] = useState(
    str(dc.administrationDurationMin),
  );
  const [releaseProfile, setReleaseProfile] = useState<string>(dc.releaseProfile ?? '');
  const [physicalForm, setPhysicalForm] = useState<string>(dc.physicalForm ?? '');
  const [prandialState, setPrandialState] = useState<string>(dc.prandialState ?? '');

  // ── Who was dosed, with what, in whom ──
  const [administered, setAdministered] = useState<{ id: number; name: string } | null>(
    dc.administeredDrugId != null && dc.administeredDrugId !== drugId
      ? { id: dc.administeredDrugId, name: `#${dc.administeredDrugId}` }
      : null,
  );
  const [coadministrationState, setCoadministrationState] = useState<string>(
    dc.coadministrationState ?? '',
  );
  const [interacting, setInteracting] = useState<{ id: number; name: string } | null>(
    dc.interactingDrugId != null
      ? { id: dc.interactingDrugId, name: `#${dc.interactingDrugId}` }
      : null,
  );
  const [pkPopulation, setPkPopulation] = useState<string>(dc.pkPopulation ?? '');
  const [populationQualifier, setPopulationQualifier] = useState(dc.populationQualifier ?? '');

  // ── Provenance ──
  const [quote, setQuote] = useState(row?.sourceQuote ?? '');
  const [observationContext, setObservationContext] = useState(row?.observationContext ?? '');
  const [comments, setComments] = useState(row?.comments ?? '');
  const [citationId, setCitationId] = useState<number | null>(row?.citationId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasBounds = low.trim() !== '' || high.trim() !== '';
  const repeated = doseRegimen === 'multiple' || doseRegimen === 'steady_state';

  function payload(): Omit<DoseContextEntryWriteInput, 'drugId' | 'parameter'> {
    const or = <T,>(v: T | '' | undefined): T | null => (v === '' || v === undefined ? null : v);
    return {
      // The entry's own fields.
      low: num(low),
      high: num(high),
      qualifier: qualifier || undefined,
      unit,
      matrix,
      route: route || undefined,
      n: num(n),
      observationContext: observationContext.trim() || null,
      comments: comments.trim() || undefined,
      quote: quote.trim() || null,
      citationId: citationId ?? 0,
      submitForReview: !isAdmin,
      // The dose context — every field stated, because an update replaces the
      // whole shape (absent means "not recorded" for these fields).
      valueBasis: valueBasis as DoseContextFields['valueBasis'],
      centralValue: num(centralValue) ?? null,
      centralStatistic: qualifier ? null : (or(centralStatistic) as DoseContextFields['centralStatistic']),
      intervalKind: qualifier || !hasBounds ? null : (or(intervalKind) as DoseContextFields['intervalKind']),
      doseValue: doseShape === 'exact' ? (num(doseValue) ?? null) : null,
      doseLow: doseShape === 'range' ? (num(doseLow) ?? null) : null,
      doseHigh: doseShape === 'range' ? (num(doseHigh) ?? null) : null,
      doseUnit: doseShape === 'none' ? null : (doseUnit as DoseContextFields['doseUnit']),
      doseBasis: or(doseBasis) as DoseContextFields['doseBasis'],
      doseSaltForm: doseBasis === 'salt' ? doseSaltForm.trim() || null : null,
      doseRegimen: or(doseRegimen) as DoseContextFields['doseRegimen'],
      doseIntervalHours: repeated || doseRegimen === 'unknown' ? (num(doseIntervalHours) ?? null) : null,
      doseNumber: doseRegimen === 'multiple' ? (num(doseNumber) ?? null) : null,
      regimenDurationHours: doseRegimen === 'multiple' ? (num(regimenDurationHours) ?? null) : null,
      priorDosingRegular: repeated && priorDosingRegular ? priorDosingRegular === 'yes' : null,
      ivInputMode: route === 'iv' ? (or(ivInputMode) as DoseContextFields['ivInputMode']) : null,
      administrationDurationMin:
        route === 'iv' && ivInputMode === 'infusion' ? (num(administrationDurationMin) ?? null) : null,
      releaseProfile: or(releaseProfile) as DoseContextFields['releaseProfile'],
      physicalForm: or(physicalForm) as DoseContextFields['physicalForm'],
      prandialState: or(prandialState) as DoseContextFields['prandialState'],
      administeredDrugId: administered?.id ?? drugId,
      coadministrationState: or(coadministrationState) as DoseContextFields['coadministrationState'],
      interactingDrugId:
        coadministrationState === 'with_interacting_drug' ? (interacting?.id ?? null) : null,
      pkPopulation: or(pkPopulation) as DoseContextFields['pkPopulation'],
      populationQualifier:
        pkPopulation && pkPopulation !== 'healthy_adult' ? populationQualifier.trim() || null : null,
    };
  }

  async function handleSubmit() {
    setError(null);
    if (citationId == null) {
      setError(t('parameterEntries.editor.errorCitationRequired'));
      return;
    }
    const body = payload();
    // The same rules the API applies, run first so a refusal is shown in the
    // reader's language rather than as the server's English message.
    const nullsAsAbsent = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, v === null ? undefined : v]),
    );
    if (validateEntryForParameter('cmax', canonicalizeReportedStatistic(nullsAsAbsent))) {
      setError(t('cmax.editor.errorInvalid'));
      return;
    }
    setSaving(true);
    try {
      if (row) await updateParameterEntry(row.id, body);
      else await createParameterEntry({ drugId, parameter: 'cmax', ...body });
      onSaved();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? t(`parameterEntries.editor.error_${code}`, { defaultValue: t('cmax.editor.errorInvalid') })
          : t('cmax.editor.errorInvalid'),
      );
    } finally {
      setSaving(false);
    }
  }

  const labelCls = 'text-[11px] font-medium text-muted-foreground';
  const selectCls = 'w-full rounded border border-border bg-background px-2 py-1 text-sm';
  const legendCls = 'mt-3 mb-1 text-xs font-semibold text-muted-foreground';

  /** A select over a vocabulary, with a leading "not stated" choice. */
  function vocabSelect(
    field: keyof DoseContextFields,
    label: string,
    values: readonly string[],
    value: string,
    onChange: (v: string) => void,
    opts: { notStated?: boolean } = { notStated: true },
  ) {
    return (
      <label className="flex flex-col gap-0.5">
        <span className={labelCls}>{label}</span>
        <select
          className={selectCls}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        >
          {opts.notStated !== false && <option value="">{t('cmax.editor.notStated')}</option>}
          {values.map((v) => (
            <option key={v} value={v}>
              {t(`doseContext.values.${field}.${v}`, { defaultValue: v })}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function numberField(label: string, value: string, onChange: (v: string) => void) {
    return (
      <label className="flex flex-col gap-0.5">
        <span className={labelCls}>{label}</span>
        <Input type="number" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 text-sm" data-testid="cmax-entry-editor">
      <p className={legendCls}>{t('cmax.editor.value')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {vocabSelect('valueBasis', t('doseContext.fields.valueBasis'), ['concentration', 'dose_normalized'], valueBasis, (v) => {
          setValueBasis(v);
          setUnit(v === 'dose_normalized' ? 'ng/mL/mg' : 'ng/mL');
        }, { notStated: false })}
        {numberField(t('cmax.editor.centralValue'), centralValue, setCentralValue)}
        {!qualifier &&
          vocabSelect('centralStatistic', t('doseContext.fields.statistic'), CENTRAL_STATISTICS, centralStatistic, setCentralStatistic)}
        {!qualifier && numberField(t('parameterEntries.editor.low'), low, setLow)}
        {!qualifier && numberField(t('parameterEntries.editor.high'), high, setHigh)}
        {!qualifier && hasBounds &&
          vocabSelect('intervalKind', t('cmax.editor.intervalKind'), INTERVAL_KINDS, intervalKind, setIntervalKind)}
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.qualifier')}</span>
          <select className={selectCls} value={qualifier} aria-label={t('parameterEntries.editor.qualifier')} onChange={(e) => setQualifier(e.target.value)}>
            <option value="">—</option>
            {QUALIFIER_OPERATORS.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.unit')}</span>
          <select className={selectCls} value={unit} aria-label={t('parameterEntries.editor.unit')} onChange={(e) => setUnit(e.target.value)}>
            {unitOptions.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.matrix')}</span>
          <select className={selectCls} value={matrix} aria-label={t('parameterEntries.editor.matrix')} onChange={(e) => setMatrix(e.target.value)}>
            {REFERENCE_MATRICES.map((m) => (
              <option key={m} value={m}>{t(REFERENCE_MATRIX_LABEL_KEYS[m as ReferenceMatrix])}</option>
            ))}
          </select>
        </label>
        {numberField('n', n, setN)}
      </div>
      {qualifier && <p className="mt-1 text-[11px] text-muted-foreground">{t('cmax.editor.censoredHint')}</p>}

      <p className={legendCls}>{t('doseContext.fields.dose')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('cmax.editor.doseShape')}</span>
          <select className={selectCls} value={doseShape} aria-label={t('cmax.editor.doseShape')} onChange={(e) => setDoseShape(e.target.value as DoseShape)}>
            <option value="exact">{t('cmax.editor.doseExact')}</option>
            <option value="range">{t('cmax.editor.doseRange')}</option>
            <option value="none">{t('cmax.editor.notStated')}</option>
          </select>
        </label>
        {doseShape === 'exact' && numberField(t('cmax.editor.doseValue'), doseValue, setDoseValue)}
        {doseShape === 'range' && numberField(t('cmax.editor.doseLow'), doseLow, setDoseLow)}
        {doseShape === 'range' && numberField(t('cmax.editor.doseHigh'), doseHigh, setDoseHigh)}
        {doseShape !== 'none' &&
          vocabSelect('doseUnit' as keyof DoseContextFields, t('cmax.editor.doseUnit'), DOSE_CONTEXT_DOSE_UNITS, doseUnit, setDoseUnit, { notStated: false })}
        {vocabSelect('doseBasis', t('cmax.editor.doseBasis'), DOSE_BASES, doseBasis, setDoseBasis)}
        {doseBasis === 'salt' && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('cmax.editor.doseSaltForm')}</span>
            <Input value={doseSaltForm} aria-label={t('cmax.editor.doseSaltForm')} onChange={(e) => setDoseSaltForm(e.target.value)} />
          </label>
        )}
      </div>

      <p className={legendCls}>{t('doseContext.fields.regimen')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {vocabSelect('doseRegimen', t('doseContext.fields.regimen'), DOSE_REGIMENS, doseRegimen, setDoseRegimen)}
        {(repeated || doseRegimen === 'unknown') &&
          numberField(t('cmax.editor.doseIntervalHours'), doseIntervalHours, setDoseIntervalHours)}
        {doseRegimen === 'multiple' && numberField(t('cmax.editor.doseNumber'), doseNumber, setDoseNumber)}
        {doseRegimen === 'multiple' &&
          numberField(t('cmax.editor.regimenDurationHours'), regimenDurationHours, setRegimenDurationHours)}
        {repeated && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('cmax.editor.priorDosingRegular')}</span>
            <select className={selectCls} value={priorDosingRegular} aria-label={t('cmax.editor.priorDosingRegular')} onChange={(e) => setPriorDosingRegular(e.target.value)}>
              <option value="">{t('cmax.editor.notStated')}</option>
              <option value="yes">{t('cmax.editor.yes')}</option>
              <option value="no">{t('cmax.editor.no')}</option>
            </select>
          </label>
        )}
      </div>

      <p className={legendCls}>{t('doseContext.fields.administration')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-0.5">
          <span className={labelCls}>{t('parameterEntries.editor.route')}</span>
          <select className={selectCls} value={route} aria-label={t('parameterEntries.editor.route')} onChange={(e) => setRoute(e.target.value)}>
            <option value="">{t('cmax.editor.notStated')}</option>
            {ROUTE_OPTIONS.map((r) => (
              <option key={r} value={r}>{t(ROUTE_LABEL_KEYS[r])}</option>
            ))}
          </select>
        </label>
        {route === 'iv' && vocabSelect('ivInputMode', t('cmax.editor.ivInputMode'), IV_INPUT_MODES, ivInputMode, setIvInputMode)}
        {route === 'iv' && ivInputMode === 'infusion' &&
          numberField(t('cmax.editor.administrationDurationMin'), administrationDurationMin, setAdministrationDurationMin)}
        {vocabSelect('releaseProfile', t('cmax.editor.releaseProfile'), RELEASE_PROFILES, releaseProfile, setReleaseProfile)}
        {vocabSelect('physicalForm', t('cmax.editor.physicalForm'), PHYSICAL_FORMS, physicalForm, setPhysicalForm)}
        {vocabSelect('prandialState', t('cmax.editor.prandialState'), PRANDIAL_STATES, prandialState, setPrandialState)}
      </div>

      <p className={legendCls}>{t('doseContext.fields.administeredDrug')}</p>
      {administered ? (
        <div className="flex items-center gap-2 text-sm">
          <span>{administered.name}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setAdministered(null)}>
            {t('cmax.editor.sameSubstance', { name: drugName })}
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('cmax.editor.administeredSelf', { name: drugName })}</p>
          <DrugSearchDropdown
            placeholder={t('cmax.editor.administeredOther')}
            onSelect={(c) => {
              if (c._dbId != null && c._dbId !== drugId) {
                setAdministered({ id: c._dbId, name: resolveDrugName(c.names, lang) || `#${c._dbId}` });
              }
            }}
          />
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {vocabSelect('coadministrationState', t('doseContext.fields.coadministration'), COADMINISTRATION_STATES, coadministrationState, setCoadministrationState)}
        {vocabSelect('pkPopulation', t('doseContext.fields.population'), PK_POPULATIONS, pkPopulation, setPkPopulation)}
        {pkPopulation && pkPopulation !== 'healthy_adult' && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('cmax.editor.populationQualifier')}</span>
            <Input value={populationQualifier} aria-label={t('cmax.editor.populationQualifier')} onChange={(e) => setPopulationQualifier(e.target.value)} />
          </label>
        )}
      </div>
      {coadministrationState === 'with_interacting_drug' && (
        <div className="mt-2 space-y-1">
          <span className={labelCls}>{t('cmax.editor.interactingDrug')}</span>
          {interacting ? (
            <div className="flex items-center gap-2 text-sm">
              <span>{interacting.name}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setInteracting(null)}>
                {t('cmax.editor.remove')}
              </Button>
            </div>
          ) : (
            <DrugSearchDropdown
              placeholder={t('cmax.editor.interactingDrug')}
              onSelect={(c) => {
                if (c._dbId != null) {
                  setInteracting({ id: c._dbId, name: resolveDrugName(c.names, lang) || `#${c._dbId}` });
                }
              }}
            />
          )}
        </div>
      )}

      <label className="mt-3 flex flex-col gap-0.5">
        <span className={labelCls}>{t('parameterEntries.editor.quote')}</span>
        <textarea className={selectCls} rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} />
        <span className="text-[11px] text-muted-foreground">{t('parameterEntries.editor.quoteHint')}</span>
      </label>
      <label className="mt-2 flex flex-col gap-0.5">
        <span className={labelCls}>{t('parameterEntries.editor.observationContext')}</span>
        <textarea className={selectCls} rows={2} value={observationContext} onChange={(e) => setObservationContext(e.target.value)} />
      </label>
      <label className="mt-2 flex flex-col gap-0.5">
        <span className={labelCls}>{t('parameterEntries.editor.comments')}</span>
        <textarea className={selectCls} rows={2} value={comments} onChange={(e) => setComments(e.target.value)} />
      </label>
      <div className="mt-2">
        <span className={labelCls}>
          {t('parameterEntries.editor.citation')}
          {citationId != null ? ` · #${citationId}` : ''}
        </span>
        <ReferenceInput drugId={drugId} required onReferenceCreated={(ref) => setCitationId(ref.id)} />
      </div>

      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>
      )}
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" disabled={saving} onClick={handleSubmit}>
          {isAdmin ? t('parameterEntries.editor.save') : t('parameterEntries.editor.submit')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          {t('parameterEntries.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}

export default CmaxEntryEditor;
