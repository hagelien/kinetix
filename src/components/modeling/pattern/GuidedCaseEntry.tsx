import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchDrugByCid } from '@/lib/drugApi';
import { resolveDrugName } from '@/lib/drugNames';
import { parseLocaleNumberDetailed } from '@/lib/parseNumber';
import { formatForEditing, formatMeasured, reportedDecimalsOf } from '@/lib/pattern/format';
import { featuredPatternSubstances, guidedPatternAnalytes } from '@/lib/pattern/modules';
import type { PatternSubstanceModule } from '@/lib/pattern/substanceModules';
import { getAvailableConcentrationUnits } from '@/lib/unitConversion';
import type { DrugComponent } from '@/types';
import type {
  PatternCaseData,
  PatternDrugRef,
  PatternMatrix,
  PatternMeasurandMode,
  PatternObservation,
  PatternSpecimen,
} from '@/types/patternCase';

interface Props {
  caseData: PatternCaseData;
  modules: readonly PatternSubstanceModule[];
  onChange: (next: PatternCaseData) => void;
  onDraftProblem?: (problem: boolean) => void;
  onSpecimenChange?: (id: string | undefined) => void;
}

interface EntryAnalyte {
  ref: PatternDrugRef;
  label: string;
}

const MATRICES: readonly PatternMatrix[] = [
  'whole_blood', 'serum', 'plasma', 'urine', 'femoral_blood', 'cardiac_blood', 'vitreous', 'other',
];
const MODES: readonly PatternMeasurandMode[] = [
  'unknown', 'free', 'direct_conjugate', 'direct', 'total_after_hydrolysis', 'class_response',
];

function freshId(prefix: string, taken: readonly { id: string }[]): string {
  const ids = new Set(taken.map((item) => item.id));
  for (let number = 1; ; number += 1) {
    if (!ids.has(`${prefix}-${number}`)) return `${prefix}-${number}`;
  }
}

/** The selected substance is a browsing choice, never an asserted exposure. */
export function GuidedCaseEntry({ caseData, modules, onChange, onDraftProblem, onSpecimenChange }: Props) {
  const { t, i18n } = useTranslation();
  const language = i18n.language?.startsWith('en') ? 'en' : 'nb';
  const locale = language === 'en' ? 'en-GB' : 'nb-NO';
  const [selected, setSelected] = useState<EntryAnalyte | null>(null);
  const [related, setRelated] = useState<EntryAnalyte[]>([]);
  const [activeMatrix, setActiveMatrix] = useState<PatternMatrix>();
  const [sampleUnits, setSampleUnits] = useState<Record<string, string>>({});
  const [rowSettings, setRowSettings] = useState<Record<string, { unit?: string; mode?: PatternMeasurandMode }>>({});
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [badDrafts, setBadDrafts] = useState<ReadonlySet<string>>(new Set());
  // A visible input keeps its identity while temporarily blank. Observation
  // IDs alone would remount it on the first keystroke; array indexes would
  // transfer its draft to another observation when a repeated result is cleared.
  const [slots, setSlots] = useState<Record<string, { specimenId: string; cid: number; observationId?: string }>>({});
  const rowOrder = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const latest = useRef(caseData);
  latest.current = caseData;
  const searchId = useId();
  const matrix = activeMatrix ?? caseData.specimens[0]?.matrix;
  const specimens = caseData.specimens.filter((item) => item.matrix === matrix);
  // The second input card is available on reopened one-sample cases too. It is
  // only written to the case when edited, so merely opening a saved case is read-only.
  const shownSpecimens: PatternSpecimen[] = specimens.length === 1
    ? [...specimens, { id: freshId('sample', caseData.specimens), matrix: specimens[0]!.matrix }]
    : specimens;
  const firstSpecimen = shownSpecimens[0];

  const names = useMemo(() => {
    const result = new Map<number, EntryAnalyte>();
    for (const module of modules) {
      for (const item of module.analytes) {
        result.set(item.analyte.pubchemCid, { ref: item.analyte, label: t(item.labelKey) });
      }
    }
    return result;
  }, [modules, t]);

  const noteDraft = useCallback((id: string, problem: boolean) => {
    setBadDrafts((previous) => {
      if (previous.has(id) === problem) return previous;
      const next = new Set(previous);
      if (problem) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => onDraftProblem?.(badDrafts.size > 0), [badDrafts, onDraftProblem]);
  useEffect(() => onSpecimenChange?.(firstSpecimen?.id), [firstSpecimen?.id, onSpecimenChange]);
  useEffect(() => () => { sequence.current += 1; }, []);

  // A reopened case is useful immediately, before any optional catalog read.
  useEffect(() => {
    if (selected || caseData.observations.length === 0) return;
    const ref = caseData.observations[0]!.analyte;
    setSelected(names.get(ref.pubchemCid) ?? {
      ref,
      label: ref.slug ?? t('pattern.editor.observations.analyteUnknown', { cid: ref.pubchemCid }),
    });
  }, [caseData.observations, names, selected, t]);

  async function choose(entry: EntryAnalyte) {
    if (badDrafts.size > 0) return;
    const request = ++sequence.current;
    setSelected(entry);
    setRelated([]);
    setLookupError(null);
    setLoading(true);
    const matching = modules.filter((module) => module.analytes.some((item) => item.analyte.pubchemCid === entry.ref.pubchemCid));
    if (matching.length > 0) {
      const current = latest.current;
      const moduleIds = [...new Set([
        ...(current.observations.length > 0 ? current.moduleIds : []),
        ...matching.map((module) => module.id),
      ])];
      if (moduleIds.join(',') !== current.moduleIds.join(',')) onChange({ ...current, moduleIds });
    }
    try {
      const { drug } = await fetchDrugByCid(entry.ref.pubchemCid);
      if (request !== sequence.current) return;
      const items = [...(drug.metabolism?.precursors ?? []), ...(drug.metabolism?.metabolites ?? [])];
      setRelated(items.flatMap((item) => item.drug?.pubchemCid ? [{
        ref: { pubchemCid: item.drug.pubchemCid, slug: item.drug.slug },
        label: resolveDrugName(item.drug.names, language),
      }] : []));
    } catch {
      if (request === sequence.current) setLookupError(t('pattern.guided.catalogUnavailable'));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }

  const selectDrug = (drug: DrugComponent) => {
    if (!drug.pubchemCid) {
      setLookupError(t('pattern.editor.exposures.noCid', { name: resolveDrugName(drug.names, language) }));
      return;
    }
    void choose({ ref: { pubchemCid: drug.pubchemCid, slug: drug._slug }, label: resolveDrugName(drug.names, language) });
  };

  const candidates = new Map<number, EntryAnalyte>();
  if (selected) candidates.set(selected.ref.pubchemCid, names.get(selected.ref.pubchemCid) ?? selected);
  for (const module of modules) {
    if (!selected || !module.analytes.some((item) => item.analyte.pubchemCid === selected.ref.pubchemCid)) continue;
    for (const item of module.analytes) candidates.set(item.analyte.pubchemCid, names.get(item.analyte.pubchemCid)!);
  }
  for (const item of related) if (!candidates.has(item.ref.pubchemCid)) candidates.set(item.ref.pubchemCid, item);
  const panelCids = selected ? guidedPatternAnalytes(selected.ref.pubchemCid, matrix) : undefined;
  const panel = panelCids
    ? panelCids.flatMap((cid) => candidates.get(cid) ?? names.get(cid) ?? [])
    : [...candidates.values()];

  function selectMatrix(nextMatrix: PatternMatrix) {
    const current = latest.current;
    const matching = current.specimens.filter((item) => item.matrix === nextMatrix);
    const nextSpecimens = [...current.specimens];
    while (matching.length < 2) {
      const next: PatternSpecimen = { id: freshId('sample', nextSpecimens), matrix: nextMatrix };
      if (nextSpecimens.length === 0 && current.context.timeOrigin === 'first_specimen_collection') next.relativeTimeHours = 0;
      matching.push(next);
      nextSpecimens.push(next);
    }
    if (nextSpecimens.length !== current.specimens.length) onChange({ ...current, specimens: nextSpecimens });
    setActiveMatrix(nextMatrix);
  }

  function specimenListWith(current: PatternCaseData, specimen: PatternSpecimen) {
    return current.specimens.some((item) => item.id === specimen.id) ? current.specimens : [...current.specimens, specimen];
  }

  function patchSpecimen(specimen: PatternSpecimen, patch: Partial<PatternSpecimen>) {
    const current = latest.current;
    onChange({ ...current, specimens: specimenListWith(current, specimen).map((item) => item.id === specimen.id ? { ...item, ...patch } : item) });
  }

  function updateObservation(specimen: PatternSpecimen, rowKey: string, analyte: EntryAnalyte, existing: PatternObservation | undefined, next: Partial<PatternObservation> | null) {
    const current = latest.current;
    if (next === null) {
      setSlots((previous) => ({ ...previous, [rowKey]: { specimenId: specimen.id, cid: analyte.ref.pubchemCid } }));
      onChange({ ...current, observations: current.observations.filter((item) => item.id !== existing?.id) });
    } else if (existing) {
      onChange({ ...current, observations: current.observations.map((item) => item.id === existing.id ? { ...item, ...next } : item) });
    } else {
      const id = next.id && !current.observations.some((item) => item.id === next.id)
        ? next.id : freshId('obs', current.observations);
      setSlots((previous) => ({ ...previous, [rowKey]: { specimenId: specimen.id, cid: analyte.ref.pubchemCid, observationId: id } }));
      onChange({ ...current, specimens: specimenListWith(current, specimen), observations: [...current.observations, {
        qualifier: 'quantified', unit: 'µmol/L', ...next,
        id, specimenId: specimen.id,
        analyte: next.analyte?.pubchemCid === analyte.ref.pubchemCid ? next.analyte : analyte.ref,
      }] });
    }
  }

  const cards = shownSpecimens.map((specimen) => {
    const observations = caseData.observations.filter((item) => item.specimenId === specimen.id);
    const cardAnalytes = new Map(panel.map((item) => [item.ref.pubchemCid, item]));
    // A narrower input panel never hides measurements already in the case.
    for (const observation of observations) if (!cardAnalytes.has(observation.analyte.pubchemCid)) {
      cardAnalytes.set(observation.analyte.pubchemCid, names.get(observation.analyte.pubchemCid) ?? {
        ref: observation.analyte,
        label: observation.analyte.slug ?? t('pattern.editor.observations.analyteUnknown', { cid: observation.analyte.pubchemCid }),
      });
    }
    // Clearing a recorded out-of-panel result must not unmount its input before
    // the replacement can be typed, or its retained assay metadata would be lost.
    for (const slot of Object.values(slots)) {
      if (slot.specimenId !== specimen.id || slot.observationId || cardAnalytes.has(slot.cid)) continue;
      cardAnalytes.set(slot.cid, names.get(slot.cid) ?? candidates.get(slot.cid) ?? {
        ref: { pubchemCid: slot.cid },
        label: t('pattern.editor.observations.analyteUnknown', { cid: slot.cid }),
      });
    }
    const rows = [...cardAnalytes.values()].flatMap((analyte) => {
      const existing = observations.filter((item) => item.analyte.pubchemCid === analyte.ref.pubchemCid);
      const result: Array<{ key: string; analyte: EntryAnalyte; observation?: PatternObservation }> = existing.map((observation) => ({
        key: Object.entries(slots).find(([, slot]) => slot.specimenId === specimen.id && slot.observationId === observation.id)?.[0]
          ?? `${specimen.id}:obs:${observation.id}`,
        analyte, observation,
      }));
      for (const [key, slot] of Object.entries(slots)) {
        if (slot.specimenId === specimen.id && slot.cid === analyte.ref.pubchemCid && !slot.observationId) result.push({ key, analyte });
      }
      if (!result.length) result.push({ key: `${specimen.id}:blank:${analyte.ref.pubchemCid}`, analyte });
      for (const row of result) if (!rowOrder.current.has(row.key)) rowOrder.current.set(row.key, rowOrder.current.size);
      return result.sort((a, b) => rowOrder.current.get(a.key)! - rowOrder.current.get(b.key)!);
    });
    return { specimen, rows };
  });

  const rowUnit = (key: string, specimen: PatternSpecimen, observation?: PatternObservation) =>
    observation?.unit ?? rowSettings[key]?.unit ?? sampleUnits[specimen.id] ?? 'µmol/L';
  const rowMode = (key: string, observation?: PatternObservation): PatternMeasurandMode =>
    observation?.assay?.measurandMode ?? rowSettings[key]?.mode ?? 'unknown';
  const changeSettings = (key: string, patch: { unit?: string; mode?: PatternMeasurandMode }) =>
    setRowSettings((previous) => ({ ...previous, [key]: { ...previous[key], ...patch } }));

  return (
    <section className="space-y-6 rounded-2xl border bg-card p-4 sm:p-6" aria-label={t('pattern.guided.title')}>
      <div className="grid gap-6 md:grid-cols-2">
        <Step number={1} title={t('pattern.guided.substance')}>
          <label htmlFor={searchId} className="sr-only">{t('pattern.guided.search')}</label>
          <DrugSearchDropdown inputId={searchId} onSelect={selectDrug} placeholder={t('pattern.guided.search')} />
          <div className="flex flex-wrap gap-2">
            {featuredPatternSubstances.map((ref) => names.get(ref.pubchemCid)).filter((entry): entry is EntryAnalyte => !!entry).map((entry) => (
              <button key={entry.ref.pubchemCid} type="button" aria-pressed={selected?.ref.pubchemCid === entry.ref.pubchemCid}
                disabled={badDrafts.size > 0} onClick={() => void choose(entry)}
                className="rounded-full border px-3 py-1.5 text-xs aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary disabled:opacity-50">
                {entry.label}
              </button>
            ))}
          </div>
          {selected && <p className="text-sm font-medium">{selected.label}</p>}
          {loading && <p className="text-xs text-muted-foreground" role="status">{t('pattern.guided.loading')}</p>}
          {lookupError && <p className="text-xs text-muted-foreground" role="status">{lookupError}</p>}
        </Step>
        <Step number={2} title={t('pattern.guided.medium')}>
          <Select aria-label={t('pattern.guided.medium')} value={matrix ?? ''} disabled={!selected || badDrafts.size > 0}
            options={[{ value: '', label: t('pattern.guided.selectMedium') }, ...MATRICES.map((matrix) => ({ value: matrix, label: t(`pattern.editor.matrix.${matrix}`) }))]}
            onChange={(event) => { if (event.target.value) selectMatrix(event.target.value as PatternMatrix); }} />

        </Step>
      </div>

      {selected && firstSpecimen ? <>
        <Step number={3} title={t('pattern.guided.values')}>
          <p className="text-xs text-muted-foreground">{t('pattern.guided.twoSamplesHint')}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            {cards.map(({ specimen, rows }, sampleIndex) => {
              const sampleName = t('pattern.guided.sampleNumber', { number: sampleIndex + 1 });
              const interval = specimen.relativeTimeHours === undefined || firstSpecimen.relativeTimeHours === undefined
                ? undefined : specimen.relativeTimeHours - firstSpecimen.relativeTimeHours;
              return <section key={specimen.id} aria-label={sampleName} className="min-w-0 rounded-xl border bg-background/40 p-3 sm:p-4">
                <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div><h3 className="text-sm font-semibold">{sampleName}</h3>
                    {specimen.label && <p className="text-xs text-muted-foreground">{specimen.label}</p>}
                  </div>
                  <Select className="h-8 w-28 text-xs" aria-label={t('pattern.guided.newUnitFor', { name: sampleName })}
                    title={t('pattern.guided.newUnitHint')} value={sampleUnits[specimen.id] ?? 'µmol/L'}
                    options={getAvailableConcentrationUnits(true).map((unit) => ({ value: unit, label: unit }))}
                    onChange={(event) => setSampleUnits((previous) => ({ ...previous, [specimen.id]: event.target.value }))} />
                </header>
                <div className="mb-3 lg:min-h-[68px]">
                  {sampleIndex === 0 ? (
                    specimen.relativeTimeHours === 0 && caseData.context.timeOrigin === 'first_specimen_collection'
                      ? <p className="py-2 text-xs text-muted-foreground">{t('pattern.guided.firstBaseline')}</p>
                      : <DraftNumber label={t('pattern.guided.firstSampleTime', { origin: t(`pattern.editor.context.timeOriginOption.${caseData.context.timeOrigin}`) })}
                        value={specimen.relativeTimeHours} locale={locale} allowNegative onDraftProblem={noteDraft}
                        onValue={(value) => patchSpecimen(specimen, { relativeTimeHours: value })} />
                  ) : <>
                    <DraftNumber label={t('pattern.guided.hoursAfterFirst')} value={interval} locale={locale}
                      disabled={firstSpecimen.relativeTimeHours === undefined} onDraftProblem={noteDraft}
                      onValue={(value) => patchSpecimen(specimen, { relativeTimeHours: value === undefined || firstSpecimen.relativeTimeHours === undefined ? undefined : firstSpecimen.relativeTimeHours + value })} />
                    {firstSpecimen.relativeTimeHours === undefined && <p className="mt-1 text-xs text-muted-foreground">{t('pattern.guided.firstTimeNeeded')}</p>}
                  </>}
                </div>
                <div className="divide-y">
                  {rows.map(({ key, analyte, observation }) => <ConcentrationRow key={key} analyte={analyte} observation={observation}
                    unit={rowUnit(key, specimen, observation)} mode={rowMode(key, observation)}
                    onRememberSettings={(settings) => changeSettings(key, settings)}
                    locale={locale} onDraftProblem={noteDraft} onChange={(next) => updateObservation(specimen, key, analyte, observation, next)} />)}
                </div>
                {specimen.matrix === 'urine' && <div className="mt-3 border-t pt-3">
                  <DraftNumber label={t('pattern.editor.specimens.creatinine')} value={specimen.urine?.creatinineMmolL} locale={locale}
                    positive suffix="mmol/L" onDraftProblem={noteDraft}
                    onValue={(value) => patchSpecimen(specimen, { urine: { ...specimen.urine, creatinineMmolL: value } })} />
                </div>}
              </section>;
            })}
          </div>
          {matrix === 'urine' && <p className="text-xs text-muted-foreground">{t('pattern.guided.creatinineHint')}</p>}
        </Step>
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">{t('pattern.guided.analysisSettings')}</summary>
          <p className="my-3 text-xs text-muted-foreground">{t('pattern.guided.assayHint')}</p>
          <div className="grid gap-5 lg:grid-cols-2">
            {cards.map(({ specimen, rows }, sampleIndex) => <section key={specimen.id} aria-label={t('pattern.guided.settingsFor', { number: sampleIndex + 1 })}>
              <h3 className="mb-2 text-sm font-medium">{t('pattern.guided.sampleNumber', { number: sampleIndex + 1 })}</h3>
              <div className="space-y-2">{rows.map(({ key, analyte, observation }) => {
                const unit = rowUnit(key, specimen, observation);
                const units: string[] = getAvailableConcentrationUnits(true);
                if (!units.includes(unit)) units.push(unit);
                return <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)_90px] items-center gap-2">
                  <span className="text-xs">{analyte.label}</span>
                  <Select className="h-8 text-xs" aria-label={t('pattern.guided.formFor', { name: analyte.label })}
                    value={rowMode(key, observation)} options={MODES.map((value) => ({ value, label: t(`pattern.editor.observations.measurand.${value}`) }))}
                    onChange={(event) => {
                      const mode = event.target.value as PatternMeasurandMode;
                      changeSettings(key, { mode });
                      if (observation) updateObservation(specimen, key, analyte, observation, { assay: { ...observation.assay, measurandMode: mode } });
                    }} />
                  <Select className="h-8 text-xs" aria-label={t('pattern.guided.unitFor', { name: analyte.label })} value={unit}
                    disabled={!!observation && observation.qualifier !== 'quantified'}
                    options={units.map((value) => ({ value, label: value }))}
                    onChange={(event) => {
                      changeSettings(key, { unit: event.target.value });
                      if (observation) updateObservation(specimen, key, analyte, observation, { unit: event.target.value });
                    }} />
                </div>;
              })}</div>
            </section>)}
          </div>
        </details>
      </> : <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">{t('pattern.guided.startHint')}</p>}
    </section>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return <div className="space-y-3"><h2 className="flex items-center gap-2 text-sm font-semibold">
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">{number}</span>{title}
  </h2>{children}</div>;
}

function ConcentrationRow({ analyte, observation, locale, unit, mode, onRememberSettings, onChange, onDraftProblem }: {
  analyte: EntryAnalyte; observation?: PatternObservation; locale: string;
  unit: string; mode: PatternMeasurandMode;
  onRememberSettings: (settings: { unit: string; mode: PatternMeasurandMode }) => void;
  onChange: (patch: Partial<PatternObservation> | null) => void;
  onDraftProblem: (id: string, problem: boolean) => void;
}) {
  const { t } = useTranslation();
  const retained = useRef<PatternObservation>();
  const censored = observation && observation.qualifier !== 'quantified';
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,1fr)] items-center gap-3 py-2">
    <p className="text-sm">{analyte.label}</p>
    {censored ? <div className="space-y-1 text-xs">
      <p>{t(`pattern.editor.qualifier.${observation.qualifier}`)} {observation.limitRef ? `${formatMeasured(observation.limitRef.value, locale, observation.limitRef.reportedDecimals)} ${observation.limitRef.unit}` : ''}</p>
      <p className="text-muted-foreground">{t('pattern.guided.censoredHint')}</p>
    </div> : <DraftNumber hideLabel label={t('pattern.guided.valueFor', { name: analyte.label })} value={observation?.value}
      decimals={observation?.reportedDecimals} locale={locale} suffix={unit} onDraftProblem={onDraftProblem} onValue={(value, reportedDecimals) => {
        if (value === undefined) {
          onRememberSettings({ unit, mode });
          if (observation) retained.current = observation;
          if (observation) onChange(null);
        } else onChange({ ...(observation ? {} : retained.current), value, reportedDecimals, unit, assay: { ...(observation?.assay ?? retained.current?.assay), measurandMode: mode } });
      }} />}
  </div>;
}

function DraftNumber({ label, value, decimals, locale, positive = false, hideLabel = false, allowNegative = false, disabled = false, suffix, onValue, onDraftProblem }: {
  label: string; value?: number; decimals?: number; locale: string; positive?: boolean; hideLabel?: boolean; allowNegative?: boolean; disabled?: boolean; suffix?: string;
  onValue: (value: number | undefined, decimals?: number) => void;
  onDraftProblem: (id: string, problem: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<'invalid' | 'ambiguous' | 'positive' | 'nonnegative' | null>(null);
  useEffect(() => () => onDraftProblem(id, false), [id, onDraftProblem]);
  const shown = value === undefined ? '' : formatForEditing(value, locale, decimals);
  return <div className="space-y-1 text-xs text-muted-foreground">
    <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>{label}</label>
    <div className="relative"><Input id={id} disabled={disabled} className={suffix ? 'pr-16' : undefined} inputMode="decimal" value={draft ?? shown} placeholder="—" aria-invalid={problem !== null}
      aria-describedby={problem ? `${id}-problem` : undefined}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        if (!raw.trim()) {
          setProblem(null); onDraftProblem(id, false); onValue(undefined); return;
        }
        const parsed = parseLocaleNumberDetailed(raw);
        const failure = !parsed.ok ? parsed.reason : positive && parsed.value <= 0 ? 'positive' : !allowNegative && parsed.value < 0 ? 'nonnegative' : null;
        setProblem(failure); onDraftProblem(id, failure !== null);
        if (parsed.ok && !failure) onValue(parsed.value, reportedDecimalsOf(raw));
      }}
      onBlur={() => { if (!problem) setDraft(null); }} />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
    {problem && <p id={`${id}-problem`} role="alert" className="text-destructive">{t(problem === 'invalid' || problem === 'ambiguous' ? `pattern.editor.number.${problem}` : `pattern.guided.${problem}`)}</p>}
  </div>;
}
