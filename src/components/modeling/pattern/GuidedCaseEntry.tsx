import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchDrugByCid } from '@/lib/drugApi';
import { resolveDrugName } from '@/lib/drugNames';
import { parseLocaleNumberDetailed } from '@/lib/parseNumber';
import { formatForEditing, formatMeasured, reportedDecimalsOf } from '@/lib/pattern/format';
import { featuredPatternSubstances } from '@/lib/pattern/modules';
import type { PatternSubstanceModule } from '@/lib/pattern/substanceModules';
import { getAvailableConcentrationUnits } from '@/lib/unitConversion';
import type { DrugComponent } from '@/types';
import type {
  PatternCaseData,
  PatternDrugRef,
  PatternMatrix,
  PatternMeasurandMode,
  PatternObservation,
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
  const [activeId, setActiveId] = useState<string>();
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
  const specimen = caseData.specimens.find((item) => item.id === activeId) ?? caseData.specimens[0];

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
  useEffect(() => onSpecimenChange?.(specimen?.id), [specimen?.id, onSpecimenChange]);
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
  const specimenObservations = caseData.observations.filter((item) => item.specimenId === specimen?.id);
  for (const observation of specimenObservations) {
    if (!candidates.has(observation.analyte.pubchemCid)) candidates.set(observation.analyte.pubchemCid, names.get(observation.analyte.pubchemCid) ?? {
      ref: observation.analyte,
      label: observation.analyte.slug ?? t('pattern.editor.observations.analyteUnknown', { cid: observation.analyte.pubchemCid }),
    });
  }

  function selectMatrix(matrix: PatternMatrix) {
    // Another medium is another specimen. Existing measurements keep their matrix.
    const existing = caseData.specimens.find((item) => item.matrix === matrix);
    if (existing) { setActiveId(existing.id); return; }
    const id = freshId('sample', caseData.specimens);
    onChange({ ...caseData, specimens: [...caseData.specimens, { id, matrix }] });
    setActiveId(id);
  }

  function updateObservation(rowKey: string, analyte: EntryAnalyte, existing: PatternObservation | undefined, next: Partial<PatternObservation> | null) {
    if (!specimen) return;
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
      onChange({ ...current, observations: [...current.observations, {
        qualifier: 'quantified', unit: 'µmol/L', ...next,
        id, specimenId: specimen.id,
        analyte: next.analyte?.pubchemCid === analyte.ref.pubchemCid ? next.analyte : analyte.ref,
      }] });
    }
  }

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
          <Select aria-label={t('pattern.guided.medium')} value={specimen?.matrix ?? ''} disabled={!selected || badDrafts.size > 0}
            options={[{ value: '', label: t('pattern.guided.selectMedium') }, ...MATRICES.map((matrix) => ({ value: matrix, label: t(`pattern.editor.matrix.${matrix}`) }))]}
            onChange={(event) => { if (event.target.value) selectMatrix(event.target.value as PatternMatrix); }} />
          {caseData.specimens.length > 1 && <label className="block space-y-1 text-xs text-muted-foreground">
            <span>{t('pattern.guided.specimen')}</span>
            <Select value={specimen?.id ?? ''} disabled={badDrafts.size > 0} onChange={(event) => setActiveId(event.target.value)}
              options={caseData.specimens.map((item) => ({ value: item.id, label: `${item.label ?? item.id} · ${t(`pattern.editor.matrix.${item.matrix}`)}` }))} />
          </label>}
        </Step>
      </div>

      {selected && specimen ? <>
        <Step number={3} title={t('pattern.guided.values')}>
          <p className="text-xs text-muted-foreground">{t('pattern.guided.optionalValues')}</p>
          <div className="divide-y rounded-xl border px-3 sm:px-4">
            <div aria-hidden="true" className="hidden grid-cols-[minmax(130px,1.2fr)_minmax(90px,0.65fr)_minmax(90px,0.6fr)_minmax(140px,1fr)] gap-3 py-2 text-xs text-muted-foreground md:grid">
              <span>{t('pattern.editor.observations.analyte')}</span><span>{t('pattern.editor.observations.value')}</span>
              <span>{t('pattern.editor.observations.unit')}</span><span>{t('pattern.guided.measuredForm')}</span>
            </div>
            {[...candidates.values()].flatMap((analyte) => {
              const existing = specimenObservations.filter((item) => item.analyte.pubchemCid === analyte.ref.pubchemCid);
              const rows: Array<{ key: string; observation?: PatternObservation }> = existing.map((observation) => ({
                key: Object.entries(slots).find(([, slot]) => slot.specimenId === specimen.id && slot.observationId === observation.id)?.[0]
                  ?? `${specimen.id}:obs:${observation.id}`,
                observation,
              }));
              for (const [key, slot] of Object.entries(slots)) {
                if (slot.specimenId === specimen.id && slot.cid === analyte.ref.pubchemCid && !slot.observationId) rows.push({ key });
              }
              if (!rows.length) rows.push({ key: `${specimen.id}:blank:${analyte.ref.pubchemCid}` });
              for (const row of rows) if (!rowOrder.current.has(row.key)) rowOrder.current.set(row.key, rowOrder.current.size);
              return rows.sort((a, b) => rowOrder.current.get(a.key)! - rowOrder.current.get(b.key)!).map(({ key, observation }) => (
                <ConcentrationRow key={key} analyte={analyte} observation={observation}
                  locale={locale} onDraftProblem={noteDraft} onChange={(next) => updateObservation(key, analyte, observation, next)} />
              ));
            })}
          </div>
        </Step>
        {specimen.matrix === 'urine' && <Step number={4} title={t('pattern.guided.creatinine')}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-center">
            <DraftNumber label={t('pattern.editor.specimens.creatinine')} value={specimen.urine?.creatinineMmolL} locale={locale}
              positive onDraftProblem={noteDraft} onValue={(value) => onChange({ ...caseData,
                specimens: caseData.specimens.map((item) => item.id === specimen.id ? { ...item, urine: { ...item.urine, creatinineMmolL: value } } : item),
              })} />
            <p className="text-xs text-muted-foreground">{t('pattern.guided.creatinineHint', { reference: formatMeasured(caseData.normalization.creatinineReferenceMmolL, locale) })}</p>
          </div>
        </Step>}
      </> : <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">{t('pattern.guided.startHint')}</p>}
    </section>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return <div className="space-y-3"><h2 className="flex items-center gap-2 text-sm font-semibold">
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">{number}</span>{title}
  </h2>{children}</div>;
}

function ConcentrationRow({ analyte, observation, locale, onChange, onDraftProblem }: {
  analyte: EntryAnalyte; observation?: PatternObservation; locale: string;
  onChange: (patch: Partial<PatternObservation> | null) => void;
  onDraftProblem: (id: string, problem: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draftUnit, setDraftUnit] = useState('µmol/L');
  const [draftMode, setDraftMode] = useState<PatternMeasurandMode>('unknown');
  const retained = useRef<PatternObservation>();
  const unit = observation?.unit ?? draftUnit;
  const mode = observation?.assay?.measurandMode ?? draftMode;
  const units: string[] = getAvailableConcentrationUnits(true);
  if (!units.includes(unit)) units.push(unit);
  const censored = observation && observation.qualifier !== 'quantified';

  return <div className="grid grid-cols-2 items-center gap-2 py-2.5 md:grid-cols-[minmax(130px,1.2fr)_minmax(90px,0.65fr)_minmax(90px,0.6fr)_minmax(140px,1fr)] md:gap-3">
    <p className="col-span-2 text-sm font-medium md:col-span-1">{analyte.label}</p>
    {censored ? <div className="space-y-1 text-sm">
      <p>{t(`pattern.editor.qualifier.${observation.qualifier}`)} {observation.limitRef ? `${formatMeasured(observation.limitRef.value, locale, observation.limitRef.reportedDecimals)} ${observation.limitRef.unit}` : ''}</p>
      <p className="text-xs text-muted-foreground">{t('pattern.guided.censoredHint')}</p>
    </div> : <DraftNumber hideLabel label={t('pattern.guided.valueFor', { name: analyte.label })} value={observation?.value}
      decimals={observation?.reportedDecimals} locale={locale} onDraftProblem={onDraftProblem} onValue={(value, reportedDecimals) => {
        if (value === undefined) {
          setDraftUnit(unit); setDraftMode(mode);
          if (observation) retained.current = observation;
          if (observation) onChange(null);
        } else onChange({ ...(observation ? {} : retained.current), value, reportedDecimals, unit, assay: { ...(observation?.assay ?? retained.current?.assay), measurandMode: mode } });
      }} />}
    {!censored && <label className="block text-xs text-muted-foreground"><span className="sr-only">{t('pattern.editor.observations.unit')}</span>
      <Select aria-label={t('pattern.guided.unitFor', { name: analyte.label })} value={unit}
        options={units.map((value) => ({ value, label: value }))} onChange={(event) => {
          setDraftUnit(event.target.value);
          if (observation) onChange({ unit: event.target.value });
        }} />
    </label>}
    <label className="col-span-2 block text-xs text-muted-foreground md:col-span-1">
      <span className="md:sr-only">{t('pattern.guided.measuredForm')}</span>
      <Select aria-label={t('pattern.guided.formFor', { name: analyte.label })} className="h-10 text-xs" value={mode}
        options={MODES.map((value) => ({ value, label: t(`pattern.editor.observations.measurand.${value}`) }))}
        onChange={(event) => {
          const value = event.target.value as PatternMeasurandMode;
          setDraftMode(value);
          if (observation) onChange({ assay: { ...observation.assay, measurandMode: value } });
        }} />
    </label>
  </div>;
}

function DraftNumber({ label, value, decimals, locale, positive = false, hideLabel = false, onValue, onDraftProblem }: {
  label: string; value?: number; decimals?: number; locale: string; positive?: boolean; hideLabel?: boolean;
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
    <Input id={id} inputMode="decimal" value={draft ?? shown} placeholder="—" aria-invalid={problem !== null}
      aria-describedby={problem ? `${id}-problem` : undefined}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        if (!raw.trim()) {
          setProblem(null); onDraftProblem(id, false); onValue(undefined); return;
        }
        const parsed = parseLocaleNumberDetailed(raw);
        const failure = !parsed.ok ? parsed.reason : positive && parsed.value <= 0 ? 'positive' : parsed.value < 0 ? 'nonnegative' : null;
        setProblem(failure); onDraftProblem(id, failure !== null);
        if (parsed.ok && !failure) onValue(parsed.value, reportedDecimalsOf(raw));
      }}
      onBlur={() => { if (!problem) setDraft(null); }} />
    {problem && <p id={`${id}-problem`} role="alert" className="text-destructive">{t(problem === 'invalid' || problem === 'ambiguous' ? `pattern.editor.number.${problem}` : `pattern.guided.${problem}`)}</p>}
  </div>;
}
