/**
 * The formulation and population of an absorption reading (#12) — the scope
 * fields a `doseContext: 'optional'` parameter (Tmax, ka, F, absorption model)
 * may carry, `ENTRY_SCOPE_FIELD_KEYS`.
 *
 * The same vocabularies and labels as the Cmax editor's regimen, formulation
 * and population controls, so one product reads the same on both forms. Every
 * field defaults to "not stated": silence is stored as silence, never guessed.
 * The interval is offered only when the regimen is not a single dose, and the
 * population qualifier only beside a stated non-healthy-adult population —
 * the shapes the validator and migration 0129's CHECK refuse are not offered.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import {
  DOSE_REGIMENS,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  RELEASE_PROFILES,
  type DoseContextFields,
} from '@/lib/entryDoseContext';

/** The scope fields as a write states them: every key present, null when not stated. */
export type EntryScopeValues = Required<
  Pick<
    DoseContextFields,
    | 'doseRegimen'
    | 'doseIntervalHours'
    | 'releaseProfile'
    | 'physicalForm'
    | 'pkPopulation'
    | 'populationQualifier'
  >
>;

export interface EntryScopeState {
  releaseProfile: string;
  physicalForm: string;
  doseRegimen: string;
  doseIntervalHours: string;
  pkPopulation: string;
  populationQualifier: string;
}

/** The form state for a stored row's scope (or an empty one for a new entry). */
export function initialEntryScope(dc: DoseContextFields | null | undefined): EntryScopeState {
  return {
    releaseProfile: dc?.releaseProfile ?? '',
    physicalForm: dc?.physicalForm ?? '',
    doseRegimen: dc?.doseRegimen ?? '',
    doseIntervalHours: dc?.doseIntervalHours != null ? String(dc.doseIntervalHours) : '',
    pkPopulation: dc?.pkPopulation ?? '',
    populationQualifier: dc?.populationQualifier ?? '',
  };
}

const showsInterval = (s: EntryScopeState) => s.doseRegimen !== 'single';
const showsQualifier = (s: EntryScopeState) =>
  s.pkPopulation !== '' && s.pkPopulation !== 'healthy_adult';

/**
 * The scope a write sends: EVERY field, a blank or hidden one as `null`. All
 * six keys are always present because the server reads a patch that names
 * none of them as an unaware writer and refuses it when the row records a
 * scope (`patchOmitsStoredScope`) — this form is aware, so it always states
 * the group, and a field the curator cleared is cleared.
 */
export function entryScopeForWrite(s: EntryScopeState): EntryScopeValues {
  const interval = s.doseIntervalHours.trim() === '' ? NaN : Number(s.doseIntervalHours);
  const qualifier = s.populationQualifier.trim();
  return {
    releaseProfile: (s.releaseProfile || null) as EntryScopeValues['releaseProfile'],
    physicalForm: (s.physicalForm || null) as EntryScopeValues['physicalForm'],
    doseRegimen: (s.doseRegimen || null) as EntryScopeValues['doseRegimen'],
    doseIntervalHours: showsInterval(s) && Number.isFinite(interval) ? interval : null,
    pkPopulation: (s.pkPopulation || null) as EntryScopeValues['pkPopulation'],
    populationQualifier: showsQualifier(s) && qualifier ? qualifier : null,
  };
}

/** Every scope field stated as "not stated". */
export const NO_ENTRY_SCOPE: EntryScopeValues = {
  doseRegimen: null,
  doseIntervalHours: null,
  releaseProfile: null,
  physicalForm: null,
  pkPopulation: null,
  populationQualifier: null,
};

/** Local state for the fieldset, seeded from the row being edited. */
export function useEntryScope(dc: DoseContextFields | null | undefined) {
  return useState<EntryScopeState>(() => initialEntryScope(dc));
}

export function EntryScopeFields({
  value,
  onChange,
}: {
  value: EntryScopeState;
  onChange: (next: EntryScopeState) => void;
}) {
  const { t } = useTranslation();
  const labelCls = 'text-[11px] font-medium text-muted-foreground';
  const selectCls = 'w-full rounded border border-border bg-background px-2 py-1 text-sm';
  const set = (key: keyof EntryScopeState) => (v: string) => onChange({ ...value, [key]: v });

  function vocabSelect(
    field: keyof DoseContextFields,
    label: string,
    values: readonly string[],
    current: string,
    onPick: (v: string) => void,
  ) {
    return (
      <label className="flex flex-col gap-0.5">
        <span className={labelCls}>{label}</span>
        <select
          className={selectCls}
          value={current}
          aria-label={label}
          onChange={(e) => onPick(e.target.value)}
        >
          <option value="">{t('cmax.editor.notStated')}</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {t(`doseContext.values.${field}.${v}`, { defaultValue: v })}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <fieldset className="mt-2" data-testid="entry-scope-fields">
      <legend className="text-xs font-semibold text-muted-foreground">
        {t('parameterEntries.editor.scopeLegend')}
      </legend>
      <p className="mb-1 text-[11px] text-muted-foreground">
        {t('parameterEntries.editor.scopeHint')}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {vocabSelect('releaseProfile', t('cmax.editor.releaseProfile'), RELEASE_PROFILES, value.releaseProfile, set('releaseProfile'))}
        {vocabSelect('physicalForm', t('cmax.editor.physicalForm'), PHYSICAL_FORMS, value.physicalForm, set('physicalForm'))}
        {vocabSelect('doseRegimen', t('doseContext.fields.regimen'), DOSE_REGIMENS, value.doseRegimen, set('doseRegimen'))}
        {showsInterval(value) && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('cmax.editor.doseIntervalHours')}</span>
            <Input
              type="number"
              value={value.doseIntervalHours}
              aria-label={t('cmax.editor.doseIntervalHours')}
              onChange={(e) => set('doseIntervalHours')(e.target.value)}
            />
          </label>
        )}
        {vocabSelect('pkPopulation', t('doseContext.fields.population'), PK_POPULATIONS, value.pkPopulation, set('pkPopulation'))}
        {showsQualifier(value) && (
          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>{t('cmax.editor.populationQualifier')}</span>
            <Input
              value={value.populationQualifier}
              aria-label={t('cmax.editor.populationQualifier')}
              onChange={(e) => set('populationQualifier')(e.target.value)}
            />
          </label>
        )}
      </div>
    </fieldset>
  );
}
