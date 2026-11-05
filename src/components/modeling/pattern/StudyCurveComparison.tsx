/** Observed study means and a measured level; no reverse inference of intake time. */
import { useTranslation } from 'react-i18next';
import { embeddedComponents } from '../../../../data/components';
import { catalogMolecularWeight } from '../../../lib/pattern/catalogAnalytes';
import type { ObservationRowVM } from '../../../lib/pattern/profileModel';
import { eligibleStudyCurves, type StudyConcentrationCurve } from '../../../lib/pattern/studyCurves';
import { convertConcentration, isConcentrationUnit, normalizeUnit } from '../../../lib/unitConversion';

export interface StudyComparison {
  observation: ObservationRowVM;
  curve: StudyConcentrationCurve;
  measurement: number;
}

/** All matching dimensions are checked before a measurement can enter a plot. */
export function studyComparisons(observations: ObservationRowVM[], normalized: boolean): StudyComparison[] {
  return observations.flatMap((observation) => {
    if (
      normalized || observation.qualifier !== 'quantified' || observation.value === undefined ||
      !Number.isFinite(observation.value) || observation.value < 0 || !observation.unit ||
      observation.reportedAsDifferentSubstance
    ) return [];
    const unit = normalizeUnit(observation.unit);
    if (!isConcentrationUnit(unit)) return [];
    return eligibleStudyCurves({ ...observation, normalization: 'raw' }).flatMap((curve) => {
      try {
        const measurement = convertConcentration(
          observation.value!, unit, curve.unit, catalogMolecularWeight(observation),
        );
        return Number.isFinite(measurement) && measurement >= 0 ? [{ observation, curve, measurement }] : [];
      } catch {
        return [];
      }
    });
  });
}

export function StudyCurveComparison({ comparison }: { comparison: StudyComparison }) {
  const { t, i18n } = useTranslation();
  const { curve, observation, measurement } = comparison;
  const english = i18n.language?.startsWith('en');
  const format = (value: number) => new Intl.NumberFormat(english ? 'en-GB' : 'nb-NO', { maximumSignificantDigits: 3 }).format(value);
  const label = observation.labelKey ? t(observation.labelKey) : observation.slug ?? String(observation.pubchemCid);
  const specimenLabel = observation.hasSpecimenLabel === false && observation.matrix
    ? t(`pattern.editor.matrix.${observation.matrix}`) : observation.specimenLabel;
  const parent = embeddedComponents.find((entry) => entry.pubchemCid === curve.administeredDrug.pubchemCid);
  const parentName = (english ? parent?.nameEn : parent?.name) ?? parent?.name ?? String(curve.administeredDrug.pubchemCid);
  const width = 640;
  const height = 240;
  const pad = { left: 58, right: 18, top: 24, bottom: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maxTime = Math.max(...curve.points.map((point) => point.timeHours));
  const maxConcentration = Math.max(measurement, ...curve.points.map((point) => point.mean)) * 1.15;
  const x = (time: number) => pad.left + time / maxTime * plotWidth;
  const y = (concentration: number) => pad.top + plotHeight - concentration / maxConcentration * plotHeight;
  const path = curve.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.timeHours)},${y(point.mean)}`).join(' ');

  return (
    <figure className="space-y-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 sm:p-5">
      <figcaption>
        <h3 className="font-medium">{label} · {specimenLabel}</h3>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
          {t('pattern.profile.comparison.study.design', { count: curve.participantCount, dose: curve.doseMg, substance: parentName })}
        </p>
      </figcaption>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        <span className="flex items-center gap-2"><span aria-hidden="true" className="h-0.5 w-6 bg-[hsl(var(--primary))]" />{t('pattern.profile.comparison.study.mean')}</span>
        <span className="flex items-center gap-2"><span aria-hidden="true" className="w-6 border-t-2 border-dashed border-[hsl(var(--foreground))]" />{t('pattern.profile.comparison.study.measurement', { value: format(measurement), unit: curve.unit })}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" role="img" aria-label={t('pattern.profile.comparison.study.chartLabel', { name: label, value: format(measurement), unit: curve.unit })}>
        {[0, maxConcentration / 2, maxConcentration].map((value, index) => (
          <g key={index}>
            <line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} className="stroke-[hsl(var(--border))]" />
            <text x={pad.left - 8} y={y(value) + 4} textAnchor="end" className="fill-[hsl(var(--muted-foreground))] text-[11px]">{format(value)}</text>
          </g>
        ))}
        {[0, maxTime / 3, maxTime * 2 / 3, maxTime].map((time) => (
          <text key={time} x={x(time)} y={height - 20} textAnchor="middle" className="fill-[hsl(var(--muted-foreground))] text-[11px]">{format(time)}</text>
        ))}
        <text x={pad.left} y={13} className="fill-[hsl(var(--muted-foreground))] text-[11px]">{curve.unit}</text>
        <text x={width - pad.right} y={height - 3} textAnchor="end" className="fill-[hsl(var(--muted-foreground))] text-[11px]">{t('pattern.profile.comparison.study.timeAxis')}</text>
        <path d={path} fill="none" strokeWidth={2} className="stroke-[hsl(var(--primary))]" />
        {curve.points.map((point) => (
          <circle key={point.timeHours} cx={x(point.timeHours)} cy={y(point.mean)} r={3} className="fill-[hsl(var(--primary))]">
            <title>{t('pattern.profile.comparison.study.point', { time: point.timeHours, mean: format(point.mean), sd: format(point.sd), unit: curve.unit })}</title>
          </circle>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(measurement)} y2={y(measurement)} strokeDasharray="7 5" strokeWidth={2} className="stroke-[hsl(var(--foreground))]" />
      </svg>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.study.limitations')}</p>
      <details className="text-xs">
        <summary className="cursor-pointer font-medium text-[hsl(var(--primary))]">{t('pattern.profile.comparison.sources')}</summary>
        <div className="mt-3 space-y-3 text-[hsl(var(--muted-foreground))]">
          <a href={curve.citation.url} target="_blank" rel="noreferrer" className="underline">{curve.citation.authors} ({curve.citation.year}). {curve.citation.title}</a>
          <p>{t('pattern.profile.comparison.study.sourceTable', { table: curve.citation.table })}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left tabular-nums">
              <caption className="sr-only">{t('pattern.profile.comparison.study.tableCaption', { name: label })}</caption>
              <thead><tr><th className="py-1">{t('pattern.profile.comparison.study.hours')}</th><th>{t('pattern.profile.comparison.study.mean')} ({curve.unit})</th><th>SD ({curve.unit})</th></tr></thead>
              <tbody>{curve.points.map((point) => <tr key={point.timeHours}><td className="py-1">{format(point.timeHours)}</td><td>{format(point.mean)}</td><td>{format(point.sd)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </details>
    </figure>
  );
}
