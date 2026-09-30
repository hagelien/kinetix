/**
 * The structured dose context of a source entry (Cmax dose-context RFC,
 * src/lib/entryDoseContext.ts), as rows of the review card's details grid.
 *
 * Ships in release B, before any writer can produce a value: a reviewer on a
 * release-B instance may be asked to approve a proposal a release-C instance
 * authored, and must see what it says about dose, regimen and population —
 * the dimensions that decide whether two Cmax readings are the same
 * observation at all. Renders nothing for an entry without dose context.
 * On every other parameter only the statistic row can appear — the reported
 * statistic (mean ± SD, median and range, …) is optional there, and the dose
 * fields are forbidden.
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  hasAnyDoseContext,
  type DoseContextFields,
} from '@/lib/entryDoseContext';

/** A vocabulary member's label, e.g. `doseContext.values.doseRegimen.single`. */
function vocabLabel(
  t: TFunction,
  field: keyof DoseContextFields,
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  return t(`doseContext.values.${field}.${value}`, { defaultValue: value });
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function joined(parts: Array<string | null | undefined>): string | null {
  const present = parts.filter((p): p is string => !!p);
  return present.length ? present.join(' · ') : null;
}

export function DoseContextDetails({
  fields,
  drugNames,
}: {
  fields: DoseContextFields;
  /**
   * Names for the drug ids this context points at, when the caller has them
   * (the review queue resolves them server-side). An id without a name falls
   * back to "substance #id" rather than disappearing.
   */
  drugNames?: Record<number, string>;
}) {
  const { t } = useTranslation();
  if (!hasAnyDoseContext(fields)) return null;
  const f = fields;
  const drugRef = (id: number) =>
    drugNames?.[id] ?? t('doseContext.drugRef', { id });

  const statistic = joined([
    vocabLabel(t, 'centralStatistic', f.centralStatistic),
    f.intervalKind
      ? t('doseContext.interval', {
          kind: vocabLabel(t, 'intervalKind', f.intervalKind),
        })
      : null,
  ]);

  const doseAmount =
    f.doseValue != null
      ? t('doseContext.doseExact', { value: f.doseValue, unit: f.doseUnit ?? '' })
      : f.doseLow != null && f.doseHigh != null
        ? t('doseContext.doseRange', {
            low: f.doseLow,
            high: f.doseHigh,
            unit: f.doseUnit ?? '',
          })
        : null;
  const dose = joined([
    doseAmount,
    f.doseBasis
      ? t('doseContext.doseBasisAs', {
          basis: vocabLabel(t, 'doseBasis', f.doseBasis),
        })
      : null,
    f.doseSaltForm,
  ]);

  const regimen = joined([
    vocabLabel(t, 'doseRegimen', f.doseRegimen),
    f.doseIntervalHours != null
      ? t('doseContext.everyHours', { hours: f.doseIntervalHours })
      : null,
    f.doseNumber != null ? t('doseContext.doseNumber', { number: f.doseNumber }) : null,
    f.regimenDurationHours != null
      ? t('doseContext.afterHours', { hours: f.regimenDurationHours })
      : null,
    f.priorDosingRegular === true
      ? t('doseContext.priorDosingRegular')
      : f.priorDosingRegular === false
        ? t('doseContext.priorDosingIrregular')
        : null,
  ]);

  const administration = joined([
    vocabLabel(t, 'ivInputMode', f.ivInputMode),
    f.administrationDurationMin != null
      ? t('doseContext.overMinutes', { minutes: f.administrationDurationMin })
      : null,
    vocabLabel(t, 'releaseProfile', f.releaseProfile),
    vocabLabel(t, 'physicalForm', f.physicalForm),
    vocabLabel(t, 'prandialState', f.prandialState),
  ]);

  const coadministration = joined([
    vocabLabel(t, 'coadministrationState', f.coadministrationState),
    f.interactingDrugId != null ? drugRef(f.interactingDrugId) : null,
  ]);

  const population = joined([
    vocabLabel(t, 'pkPopulation', f.pkPopulation),
    f.populationQualifier,
  ]);

  return (
    <>
      <Row
        label={t('doseContext.fields.valueBasis')}
        value={vocabLabel(t, 'valueBasis', f.valueBasis)}
      />
      <Row label={t('doseContext.fields.statistic')} value={statistic} />
      <Row label={t('doseContext.fields.dose')} value={dose} />
      <Row
        label={t('doseContext.fields.administeredDrug')}
        value={
          f.administeredDrugId != null ? drugRef(f.administeredDrugId) : null
        }
      />
      <Row label={t('doseContext.fields.regimen')} value={regimen} />
      <Row label={t('doseContext.fields.administration')} value={administration} />
      <Row label={t('doseContext.fields.coadministration')} value={coadministration} />
      <Row label={t('doseContext.fields.population')} value={population} />
    </>
  );
}
