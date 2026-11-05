/** Measured concentrations, with no reference curve invented from ratio placeholders. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ObservationRowVM, RatioProfileViewModel } from '../../../lib/pattern/profileModel';
import { StudyCurveComparison, studyComparisons } from './StudyCurveComparison';

interface Props {
  model: Pick<RatioProfileViewModel, 'observations' | 'specimenMetrics'>;
  specimenId?: string;
}

interface PlotGroup {
  key: string;
  specimenLabel: string;
  unit: string;
  normalized: boolean;
  rows: Array<{ observation: ObservationRowVM; value: number; valueText: string }>;
}

/** Specimen identity and units are both part of the axis, never just a label. */
function groupMeasurements(observations: ObservationRowVM[], normalized: boolean): PlotGroup[] {
  const groups = new Map<string, PlotGroup>();
  for (const observation of observations) {
    if (
      observation.qualifier !== 'quantified' || observation.value === undefined ||
      !Number.isFinite(observation.value) || observation.value < 0 || !observation.unit
    ) continue;
    const corrected = normalized ? observation.creatinineNormalized : undefined;
    const unit = corrected?.unit ?? observation.unit;
    const key = JSON.stringify([
      observation.specimenId ?? observation.specimenLabel,
      observation.matrix,
      unit,
      Boolean(corrected),
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key, unit, specimenLabel: observation.specimenLabel,
        normalized: Boolean(corrected), rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push({
      observation,
      value: corrected?.value ?? observation.value,
      valueText: corrected?.valueText ?? observation.valueText ?? String(observation.value),
    });
  }
  return [...groups.values()];
}

export function ProfileComparison({ model, specimenId }: Props) {
  const { t, i18n } = useTranslation();
  const [normalize, setNormalize] = useState(false);
  const observations = model.observations.filter((row) => !specimenId || row.specimenId === specimenId);
  const hasNormalized = observations.some((row) => row.creatinineNormalized !== undefined);
  const groups = groupMeasurements(observations, normalize);
  const nonNumeric = observations.filter((row) => row.qualifier !== 'quantified');
  const comparisons = studyComparisons(observations, normalize && hasNormalized);
  const comparedIds = new Set(comparisons.map((comparison) => comparison.observation.id));
  const unmatched = observations.filter((row) => row.value !== undefined && !comparedIds.has(row.id));
  const locale = i18n.language?.startsWith('en') ? 'en-GB' : 'nb-NO';
  const numberFormat = new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 });
  const specimenOf = (row: ObservationRowVM) => row.hasSpecimenLabel === false && row.matrix
    ? t(`pattern.editor.matrix.${row.matrix}`) : row.specimenLabel;
  const nameOf = (row: ObservationRowVM) => row.labelKey
    ? t(row.labelKey)
    : row.slug ?? t('pattern.profile.sourceAmbiguity.unnamedSubstance', { cid: row.pubchemCid });

  return (
    <section className="space-y-6" aria-label={t('pattern.profile.comparison.title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{t('pattern.profile.comparison.title')}</h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {t('pattern.profile.comparison.subtitle')}
          </p>
        </div>
        {hasNormalized && (
          <div className="inline-flex rounded-lg border border-[hsl(var(--border))] p-1">
            {[false, true].map((value) => (
              <button
                key={String(value)} type="button" aria-pressed={normalize === value}
                onClick={() => setNormalize(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${normalize === value
                  ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]'}`}
              >
                {t(`pattern.profile.comparison.${value ? 'normalized' : 'raw'}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {groups.length === 0 && (
        <p className="rounded-xl border border-dashed border-[hsl(var(--border))] px-5 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
          {t('pattern.profile.comparison.empty')}
        </p>
      )}

      {groups.map((group) => {
        // A linear scale includes zero. Keep the largest value off the rim and
        // never manufacture a reference distribution from these measurements.
        const max = Math.max(...group.rows.map((row) => row.value));
        const ceiling = max > 0 ? max : 1;
        const ticks = [0, ceiling / 2, ceiling];
        return (
          <figure key={group.key} className="space-y-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 sm:p-5">
            <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{specimenOf(group.rows[0]!.observation)}</span>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {t('pattern.profile.comparison.axis', { unit: group.unit })}
              </span>
            </figcaption>
            <div className="space-y-4">
              {group.rows.map(({ observation, value, valueText }) => (
                <div key={observation.id} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(120px,180px)_1fr] sm:items-center sm:gap-5">
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-sm sm:block">
                    <span className="break-words">{nameOf(observation)}</span>
                    <span className="block font-medium tabular-nums text-[hsl(var(--primary))]">{valueText} {group.unit}</span>
                  </div>
                  <div
                    role="img"
                    aria-label={t('pattern.profile.comparison.point', { name: nameOf(observation), value: valueText, unit: group.unit })}
                    className="relative mx-2 h-7"
                  >
                    {ticks.map((tick, i) => (
                      <span key={i} aria-hidden="true" className="absolute inset-y-0 border-l border-[hsl(var(--border))]" style={{ left: `${(tick / ceiling) * 100}%` }} />
                    ))}
                    <span aria-hidden="true" className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 bg-[hsl(var(--primary))]/30" style={{ width: `${(value / ceiling) * 100}%` }} />
                    <span aria-hidden="true" className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[hsl(var(--card))] bg-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))]" style={{ left: `${(value / ceiling) * 100}%` }} />
                  </div>
                </div>
              ))}
              <div className="grid gap-2 sm:grid-cols-[minmax(120px,180px)_1fr] sm:gap-5" aria-hidden="true">
                <div className="hidden sm:block" />
                <div className="relative mx-2 h-4 text-[11px] tabular-nums text-[hsl(var(--muted-foreground))]">
                  {ticks.map((tick, i) => (
                    <span key={i} className={`absolute ${i === 0 ? '' : i === 2 ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${(tick / ceiling) * 100}%` }}>
                      {numberFormat.format(tick)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {group.normalized && (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.normalizationHint')}</p>
            )}
          </figure>
        );
      })}

      {nonNumeric.length > 0 && (
        <div className="space-y-1 text-sm">
          <h3 className="font-medium">{t('pattern.profile.comparison.unplotted')}</h3>
          {nonNumeric.map((row) => (
            <p key={row.id} className="text-[hsl(var(--muted-foreground))]">
              {nameOf(row)} · {specimenOf(row)}: {t(`pattern.profile.qualifier.${row.qualifier}`)}
              {row.limit ? ` ${row.limit.valueText} ${row.limit.unit}` : ''}
            </p>
          ))}
        </div>
      )}

      {comparisons.length > 0 && (
        <section className="space-y-4" aria-label={t('pattern.profile.comparison.study.title')}>
          <h2 className="text-lg font-semibold">{t('pattern.profile.comparison.study.title')}</h2>
          {comparisons.map((comparison) => <StudyCurveComparison key={`${comparison.observation.id}-${comparison.curve.id}`} comparison={comparison} />)}
        </section>
      )}

      {groups.length > 0 && (comparisons.length === 0 || unmatched.length > 0) && (
        <div className="rounded-lg bg-[hsl(var(--muted))]/50 px-4 py-3">
          <h3 className="text-sm font-medium">{t('pattern.profile.comparison.noStudy')}</h3>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{t('pattern.profile.comparison.noStudyHint')}</p>
          {unmatched.length > 0 && <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{unmatched.map(nameOf).join(', ')}</p>}
          {normalize && hasNormalized && <p className="mt-2 text-xs">{t('pattern.profile.comparison.study.noNormalizedStudy')}</p>}
        </div>
      )}
    </section>
  );
}
