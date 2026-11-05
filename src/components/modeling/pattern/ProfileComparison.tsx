/** Actual repeated measurements stay visible independently of study eligibility. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ObservationRowVM, RatioProfileViewModel } from '../../../lib/pattern/profileModel';
import { catalogMolecularWeight } from '../../../lib/pattern/catalogAnalytes';
import { convertConcentration, isConcentrationUnit, normalizeUnit } from '../../../lib/unitConversion';
import type { PatternMatrix, PatternSpecimen } from '../../../types/patternCase';
import { StudyCurveComparison, studyComparisons } from './StudyCurveComparison';

interface Props {
  model: Pick<RatioProfileViewModel, 'observations' | 'specimenMetrics'>;
  specimens?: readonly PatternSpecimen[];
  matrix?: PatternMatrix;
  specimenId?: string;
}

interface SampleSlot {
  id: string;
  index: number;
  label?: string;
  time?: number;
}
interface SeriesPoint {
  sampleId: string;
  observation: ObservationRowVM;
  value: number;
}
interface MeasurementSeries {
  key: string;
  observation: ObservationRowVM;
  points: SeriesPoint[];
}
interface MeasurementGroup {
  key: string;
  matrix?: PatternMatrix;
  unit: string;
  conversionUnit: string;
  samples: SampleSlot[];
  series: MeasurementSeries[];
}

const COLORS = ['#2563eb', '#c2410c', '#047857', '#9333ea', '#be185d', '#0e7490'];

function isQuantified(row: ObservationRowVM): row is ObservationRowVM & { value: number; unit: string } {
  return row.qualifier === 'quantified' && row.value !== undefined &&
    Number.isFinite(row.value) && row.value >= 0 && Boolean(row.unit);
}

function sampleSlots(rows: ObservationRowVM[], specimens: readonly PatternSpecimen[] | undefined, matrix?: PatternMatrix): SampleSlot[] {
  if (specimens) return specimens.filter((sample) => sample.matrix === matrix).map((sample, index) =>
    ({ id: sample.id, index: index + 1, label: sample.label, time: sample.relativeTimeHours }));
  const slots = new Map<string, SampleSlot>();
  for (const row of rows) {
    if (row.matrix !== matrix) continue;
    const id = row.specimenId ?? row.specimenLabel;
    if (!slots.has(id)) slots.set(id, {
      id, index: row.specimenIndex ?? slots.size + 1,
      label: row.hasSpecimenLabel ? row.specimenLabel : undefined,
      time: row.relativeTimeHours,
    });
  }
  return [...slots.values()];
}

/** Group compatible quantities; normalize all urine results or none. No zero-filling. */
export function measurementGroups(
  rows: ObservationRowVM[], normalized: boolean, specimens?: readonly PatternSpecimen[], matrix?: PatternMatrix,
): MeasurementGroup[] {
  const groups: MeasurementGroup[] = [];
  for (const row of rows.filter(isQuantified)) {
    const corrected = normalized && row.matrix === 'urine' ? row.creatinineNormalized : undefined;
    if (normalized && row.matrix === 'urine' && !corrected) continue;
    const value = corrected?.value ?? row.value;
    const unit = normalizeUnit(corrected?.unit ?? row.unit);
    // Dividing both sides by mmol creatinine preserves concentration-unit factors.
    const conversionUnit = corrected ? unit.replace(/\/mmol$/, '/L') : unit;
    let plottedValue = value;
    let group = groups.find((candidate) => {
      if (candidate.matrix !== row.matrix) return false;
      if (candidate.unit === unit) return true;
      if (!isConcentrationUnit(conversionUnit) || !isConcentrationUnit(candidate.conversionUnit)) return false;
      try {
        const converted = convertConcentration(
          value, conversionUnit, candidate.conversionUnit,
          row.reportedAsDifferentSubstance ? undefined : catalogMolecularWeight(row),
        );
        if (!Number.isFinite(converted) || converted < 0) return false;
        plottedValue = converted;
        return true;
      } catch {
        return false;
      }
    });
    if (!group) {
      group = {
        key: JSON.stringify([row.matrix, unit]), matrix: row.matrix, unit, conversionUnit,
        samples: sampleSlots(rows, specimens, row.matrix), series: [],
      };
      groups.push(group);
    }
    // Different reported forms are separate series even when they name one analyte.
    const massBasis = row.reportedAsDrugId ?? (row.reportedAsDifferentSubstance ? row.id : null);
    const key = JSON.stringify([row.pubchemCid, row.measurandMode ?? 'unknown', massBasis]);
    let series = group.series.find((candidate) => candidate.key === key);
    if (!series) {
      series = { key, observation: row, points: [] };
      group.series.push(series);
    }
    series.points.push({ sampleId: row.specimenId ?? row.specimenLabel, observation: row, value: plottedValue });
  }
  if (groups.length === 0) groups.push({
    key: 'empty', matrix, unit: '', conversionUnit: '', series: [],
    samples: sampleSlots(rows, specimens, matrix),
  });
  return groups;
}

export function ProfileComparison({ model, specimens, matrix, specimenId }: Props) {
  const { t, i18n } = useTranslation();
  const [normalize, setNormalize] = useState(false);
  const observations = model.observations.filter((row) =>
    (!specimenId || row.specimenId === specimenId) && (!matrix || row.matrix === matrix));
  const selectedSpecimens = specimenId ? specimens?.filter((sample) => sample.id === specimenId) : specimens;
  const urineMeasurements = observations.filter((row) => row.matrix === 'urine' && isQuantified(row));
  const canNormalize = urineMeasurements.length > 0 && urineMeasurements.every((row) =>
    row.creatinineNormalized !== undefined && Number.isFinite(row.creatinineNormalized.value) && row.creatinineNormalized.value >= 0);
  const normalized = normalize && canNormalize;
  const groups = measurementGroups(observations, normalized, selectedSpecimens, matrix);
  const comparisons = studyComparisons(observations, normalized);
  const comparedIds = new Set(comparisons.map((comparison) => comparison.observation.id));
  const unmatched = observations.filter((row) => isQuantified(row) && !comparedIds.has(row.id));
  const hasMeasurements = observations.some(isQuantified);
  const locale = i18n.language?.startsWith('en') ? 'en-GB' : 'nb-NO';
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }).format(value);
  const nameOf = (row: ObservationRowVM) => row.labelKey ? t(row.labelKey)
    : row.slug ?? t('pattern.profile.sourceAmbiguity.unnamedSubstance', { cid: row.pubchemCid });
  const sampleName = (sample: SampleSlot) => sample.label?.trim() || t('pattern.profile.comparison.sample', { number: sample.index });
  const nonNumeric = observations.filter((row) => row.qualifier !== 'quantified');
  const multipleMatrices = new Set(observations.map((row) => row.matrix)).size > 1;
  const specimenOf = (row: ObservationRowVM) => {
    const sample = sampleSlots(observations, selectedSpecimens, row.matrix)
      .find((slot) => slot.id === (row.specimenId ?? row.specimenLabel));
    const label = sample ? sampleName(sample) : row.specimenLabel;
    return multipleMatrices && row.matrix ? `${label} · ${t(`pattern.editor.matrix.${row.matrix}`)}` : label;
  };

  return (
    <section className="space-y-4" aria-label={t('pattern.profile.comparison.seriesTitle')}>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <h2 className="sr-only">{t('pattern.profile.comparison.seriesTitle')}</h2>
        {(matrix === 'urine' || urineMeasurements.length > 0) && (
          <div className="inline-flex rounded-lg border border-[hsl(var(--border))] p-1">
            {[false, true].map((value) => (
              <button key={String(value)} type="button" aria-pressed={normalized === value}
                disabled={value && !canNormalize} onClick={() => setNormalize(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${normalized === value
                  ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]'}`}>
                {t(`pattern.profile.comparison.${value ? 'normalized' : 'raw'}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      {urineMeasurements.length > 0 && !canNormalize && (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.normalizationMissing')}</p>
      )}
      {groups.map((group) => {
        const slots = group.samples.length > 0 ? group.samples : [{ id: 'empty-1', index: 1 }, { id: 'empty-2', index: 2 }];
        const timed = slots.length > 1 && slots.every((sample) => sample.time !== undefined && Number.isFinite(sample.time));
        const firstTime = timed ? Math.min(...slots.map((sample) => sample.time!)) : 0;
        const lastTime = timed ? Math.max(...slots.map((sample) => sample.time!)) : 0;
        const timeSpan = lastTime - firstTime;
        const hasTimeSpan = timed && timeSpan > 0;
        const points = group.series.flatMap((series) => series.points);
        const maximum = Math.max(...points.map((point) => point.value), 0);
        const ceiling = maximum > 0 ? maximum : 1;
        const x = (sample: SampleSlot) => hasTimeSpan
          ? 8 + 84 * (sample.time! - firstTime) / timeSpan
          : slots.length > 1 ? 8 + 84 * slots.findIndex((slot) => slot.id === sample.id) / (slots.length - 1) : 50;
        const y = (value: number) => 92 - value / ceiling * 80;
        const orderedSlots = hasTimeSpan ? [...slots].sort((a, b) => a.time! - b.time!) : slots;
        return (
          <figure key={group.key} className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 sm:p-5">
            <figcaption className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-[hsl(var(--muted-foreground))]">
              <span>{group.unit ? t('pattern.profile.comparison.axis', { unit: group.unit }) : t('pattern.profile.comparison.concentration')}</span>
              {groups.length > 1 && group.matrix && <span>{t(`pattern.editor.matrix.${group.matrix}`)}</span>}
            </figcaption>
            <div className="relative ml-10 mr-2 h-56 sm:h-64">
              {[0, 0.5, 1].map((fraction) => (
                <div key={fraction} className="absolute inset-x-0 border-t border-[hsl(var(--border))]" style={{ top: `${y(fraction * ceiling)}%` }}>
                  {points.length > 0 && <span className="absolute -left-2 -translate-x-full -translate-y-1/2 text-[11px] tabular-nums text-[hsl(var(--muted-foreground))]">{format(fraction * ceiling)}</span>}
                </div>
              ))}
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" role="img"
                aria-label={t('pattern.profile.comparison.graphLabel', { count: slots.length, unit: group.unit })}>
                {group.series.map((series, seriesIndex) => {
                  // Each absent sample breaks a segment. A missing middle sample is not zero
                  // and must never be bridged by a line through unmeasured data.
                  return orderedSlots.slice(1).flatMap((sample, slotIndex) => {
                    const previous = orderedSlots[slotIndex]!;
                    const from = series.points.filter((point) => point.sampleId === previous.id);
                    const to = series.points.filter((point) => point.sampleId === sample.id);
                    if (from.length !== 1 || to.length !== 1) return [];
                    return [<line key={`${series.key}-${sample.id}`} x1={x(previous)} y1={y(from[0]!.value)} x2={x(sample)} y2={y(to[0]!.value)}
                      stroke={COLORS[seriesIndex % COLORS.length]} strokeWidth={2} vectorEffect="non-scaling-stroke" />];
                  });
                })}
              </svg>
              {group.series.flatMap((series, seriesIndex) => series.points.map((point) => {
                const slot = slots.find((sample) => sample.id === point.sampleId);
                if (!slot) return null;
                const label = t('pattern.profile.comparison.pointSeries', {
                  name: nameOf(point.observation), sample: sampleName(slot), value: format(point.value), unit: group.unit,
                });
                return <span key={point.observation.id} role="img" aria-label={label} title={label}
                  className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[hsl(var(--card))] ring-1"
                  style={{ left: `${x(slot)}%`, top: `${y(point.value)}%`, backgroundColor: COLORS[seriesIndex % COLORS.length], color: COLORS[seriesIndex % COLORS.length] }} />;
              }))}
              {points.length === 0 && <p className="absolute inset-x-4 top-1/3 text-center text-sm text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.nextSample')}</p>}
            </div>
            <div className="relative mb-3 ml-10 mr-2 h-10 text-center text-xs text-[hsl(var(--muted-foreground))]">
              {slots.map((slot) => <span key={slot.id} className="absolute top-1 -translate-x-1/2" style={{ left: `${x(slot)}%` }}>
                <span className="block whitespace-nowrap">{sampleName(slot)}</span>
                {hasTimeSpan && <span className="block tabular-nums">{format(slot.time! - firstTime)} h</span>}
              </span>)}
            </div>
            <p className="text-center text-[11px] text-[hsl(var(--muted-foreground))]">{t(`pattern.profile.comparison.${hasTimeSpan ? 'timeAxis' : 'sampleAxis'}`)}</p>
            {group.series.length > 0 && <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
              {group.series.map((series, index) => <span key={series.key} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                <span>
                  <span className="block font-medium">{nameOf(series.observation)}
                    {group.series.filter((candidate) => candidate.observation.pubchemCid === series.observation.pubchemCid).length > 1 &&
                      <span className="ml-1 font-normal text-[hsl(var(--muted-foreground))]">({t(`pattern.editor.observations.measurand.${series.observation.measurandMode ?? 'unknown'}`)})</span>}
                  </span>
                  <span className="block tabular-nums text-[hsl(var(--muted-foreground))]">
                    {slots.map((slot) => {
                      const values = series.points.filter((point) => point.sampleId === slot.id);
                      return values.length ? values.map((point) => format(point.value)).join(', ') : '—';
                    }).join(' → ')} {group.unit}
                  </span>
                </span>
              </span>)}
            </div>}
            <div className="sr-only"><table><caption>{t('pattern.profile.comparison.seriesTitle')}</caption>
              <thead><tr><th>{t('pattern.editor.observations.analyte')}</th>{slots.map((slot) => <th key={slot.id}>{sampleName(slot)}</th>)}</tr></thead>
              <tbody>{group.series.map((series) => <tr key={series.key}><th>{nameOf(series.observation)}</th>{slots.map((slot) => <td key={slot.id}>
                {series.points.filter((point) => point.sampleId === slot.id).map((point) => `${format(point.value)} ${group.unit}`).join(', ') || t('pattern.profile.comparison.missing')}
              </td>)}</tr>)}</tbody>
            </table></div>
          </figure>
        );
      })}
      {normalized && <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.normalizationHint')}</p>}
      {nonNumeric.length > 0 && <ul aria-label={t('pattern.profile.comparison.unplotted')} className="space-y-1 text-xs text-[hsl(var(--muted-foreground))]">
        {nonNumeric.map((row) => <li key={row.id}>
          {`${specimenOf(row)} · ${nameOf(row)}: ${t(`pattern.profile.qualifier.${row.qualifier}`)}${row.limit ? ` ${row.limit.valueText} ${row.limit.unit}` : ''}`}
        </li>)}
      </ul>}
      {hasMeasurements && comparisons.length === 0 && <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.noStudyHint')}</p>}
      {comparisons.length > 0 && <details className="border-t border-[hsl(var(--border))] pt-3">
        <summary className="cursor-pointer text-sm font-medium">{t('pattern.profile.comparison.referenceDetails')}</summary>
        <div className="mt-4 space-y-4">
          {comparisons.map((comparison) => <StudyCurveComparison key={`${comparison.observation.id}-${comparison.curve.id}`} comparison={comparison} />)}
          {unmatched.length > 0 && <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.noStudyHint')} {unmatched.map(nameOf).join(', ')}</p>}
        </div>
      </details>}
    </section>
  );
}
