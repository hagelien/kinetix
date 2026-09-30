import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  DRUG_PARAMETERS,
  isRangeSpec,
  parameterAcceptsAuthoredValue,
  parameterRequiresReference,
  type DrugParameterId,
  type ParameterSpec,
} from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import { ApiError, updateDrugParameter } from '@/lib/drugApi';
import { normalizeAliases } from '@/lib/drugNames';
import type { NumericRange } from '@/types';
import { ReferenceInput } from './ReferenceInput';
import type { ReferenceRow } from '@/lib/referenceApi';
import { parseLocaleNumber } from '@/lib/parseNumber';
import { useCan } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';

interface Props {
  drugId: number;
  parameter: DrugParameterId;
  currentValue: unknown;
  onClose: () => void;
  onSaved: () => void;
}

interface PickedReference {
  id: number;
  name: string;
}

/**
 * Server error codes this form can surface, mapped to translated prose.
 *
 * The API's `message` is English by design — it is a developer-facing
 * fallback. Rendering it straight into the form leaks English to a Norwegian
 * curator, which the i18n rule in AGENTS.md exists to prevent: server messages
 * reaching the UI go through a stable code at the React boundary. Same pattern
 * as REVIEW_ERROR_KEYS in the review card.
 *
 * A code that is not listed still falls back to the server's prose, so an
 * untranslated failure is legible rather than blank.
 */
const SAVE_ERROR_KEYS: Record<string, string> = {
  parameter_not_applicable: 'paramEdit.errors.notApplicable',
  parameter_entry_backed: 'paramEdit.errors.entryBacked',
  reference_not_judged: 'paramEdit.errors.referenceNotJudged',
};

function translateSaveError(
  err: unknown,
  t: (key: string) => string,
): string {
  if (err instanceof ApiError && err.code && SAVE_ERROR_KEYS[err.code]) {
    return t(SAVE_ERROR_KEYS[err.code]!);
  }
  return err instanceof Error ? err.message : String(err);
}

function toInputRange(value: unknown): NumericRange {
  if (value && typeof value === 'object') return value as NumericRange;
  return {};
}

export function ParameterEditForm({
  drugId,
  parameter,
  currentValue,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const spec = DRUG_PARAMETERS[parameter];
  // "Save directly" vs "submit for review" is the edit.directWrite
  // capability, not the admin role as such.
  const isAdmin = useCan('edit.directWrite');

  // Range-shaped state (NumericRange parameters)
  const initialRange = useMemo(() => toInputRange(currentValue), [currentValue]);
  const [min, setMin] = useState<string>(initialRange.min !== undefined ? String(initialRange.min) : '');
  const [max, setMax] = useState<string>(initialRange.max !== undefined ? String(initialRange.max) : '');
  const [mean, setMean] = useState<string>(
    initialRange.mean !== undefined ? String(initialRange.mean) : '',
  );
  const [median, setMedian] = useState<string>(
    initialRange.median !== undefined ? String(initialRange.median) : '',
  );
  const [unit, setUnit] = useState<string>(
    initialRange.unit ?? (isRangeSpec(spec) ? spec.canonicalUnit : ''),
  );
  const [note, setNote] = useState<string>(initialRange.note ?? '');

  // Text + number metadata state. List-kind values come in as string[]; flatten
  // into a comma-separated input string so the same `textValue` slot drives
  // every non-range editor variant.
  const initialText = useMemo(() => {
    if (currentValue == null) return '';
    if (Array.isArray(currentValue)) {
      return currentValue
        .filter((v): v is string => typeof v === 'string' && !!v)
        .join(', ');
    }
    return String(currentValue);
  }, [currentValue]);
  const [textValue, setTextValue] = useState<string>(initialText);

  const [editSummary, setEditSummary] = useState<string>('');
  const [references, setReferences] = useState<PickedReference[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasReferences = references.length > 0;
  // Identity/constant metadata (names, aliases, molecular mass, PubChem CID)
  // is exempt from the source requirement; everything else must cite one.
  const requiresReference = parameterRequiresReference(parameter);

  const buildPayload = (): { ok: true; payload: unknown } | { ok: false; message: string } => {
    if (isRangeSpec(spec)) {
      const build: NumericRange = {};
      if (min !== '') build.min = parseLocaleNumber(min);
      if (max !== '') build.max = parseLocaleNumber(max);
      // The mean/median inputs are hidden for min/max-required params, so a
      // pre-existing central value must not be silently re-persisted —
      // otherwise it shadows the min–max range in the formatted display (the
      // "voksen po 0.86" vs "0.36–1" mismatch). Only carry them when editable.
      if (!spec.requiresMinMax) {
        if (mean !== '') build.mean = parseLocaleNumber(mean);
        if (median !== '') build.median = parseLocaleNumber(median);
      }
      if (unit) build.unit = unit;
      if (note.trim()) build.note = note.trim();
      const parsed = spec.zod.safeParse(build);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
      }
      return { ok: true, payload: parsed.data };
    }

    if (spec.kind === 'text') {
      const trimmed = textValue.trim();
      const parsed = spec.zod.safeParse(trimmed);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
      }
      return { ok: true, payload: trimmed };
    }

    if (spec.kind === 'number') {
      if (textValue.trim() === '') {
        // Nullable number params (e.g. molecularWeight) accept a blank
        // input as "clear the value"; non-nullable ones still require
        // a finite number.
        if (spec.nullable) {
          const parsed = spec.zod.safeParse(null);
          if (!parsed.success) {
            return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
          }
          return { ok: true, payload: parsed.data };
        }
        return { ok: false, message: t('paramEdit.numberRequired') };
      }
      const n = parseLocaleNumber(textValue);
      if (!Number.isFinite(n)) {
        return { ok: false, message: t('paramEdit.numberInvalid') };
      }
      // Don't pre-truncate integer fields — pass the parsed number straight
      // to the spec's zod schema so fractional input (e.g. 2244.9 on
      // pubchemCid) is rejected instead of silently rounded to a different
      // identifier.
      const parsed = spec.zod.safeParse(n);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
      }
      return { ok: true, payload: parsed.data };
    }

    if (spec.kind === 'list') {
      // Accept comma-separated or newline-separated input; normalise to the
      // same trimmed/de-duped string[] the API stores.
      const list = normalizeAliases(textValue);
      const parsed = spec.zod.safeParse(list);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
      }
      return { ok: true, payload: parsed.data };
    }

    return { ok: false, message: t('paramEdit.structNotSupported') };
  };

  const handleSave = async (submitForReview = false) => {
    if (requiresReference && !hasReferences) {
      setError(t('paramEdit.sourceRequired'));
      return;
    }
    setError(null);
    setSaving(true);

    const built = buildPayload();
    if (!built.ok) {
      setError(built.message);
      setSaving(false);
      return;
    }

    try {
      const result = await updateDrugParameter(
        drugId,
        parameter,
        built.payload,
        references.map((r) => r.id),
        editSummary || undefined,
        { submitForReview },
      );
      if ('pending' in result && result.pending) {
        showToast(t('paramEdit.changeSubmitted'));
      } else {
        showToast(t('paramEdit.parameterUpdated'));
      }
      onSaved();
    } catch (err) {
      setError(translateSaveError(err, t));
    } finally {
      setSaving(false);
    }
  };

  function handleReferenceCreated(ref: ReferenceRow) {
    const name = ref.metadata?.title ?? ref.identifier;
    setReferences((prev) =>
      prev.some((r) => r.id === ref.id) ? prev : [...prev, { id: ref.id, name }],
    );
    setShowPicker(false);
  }

  function removeReference(id: number) {
    setReferences((prev) => prev.filter((r) => r.id !== id));
  }

  const subtitle = renderSubtitle(spec, t);
  const labels = useParameterLabels(spec);
  // Defence in depth. Every caller already hides the edit control for a
  // source-value-backed parameter and the API refuses the write, but this form
  // is the one place that decides what "editing a parameter" means — so it
  // refuses to offer the inputs at all rather than letting a caller added later
  // reintroduce the typed-in value this rule exists to keep out.
  const sourceValueBacked = !parameterAcceptsAuthoredValue(parameter);
  const formDisabled =
    saving ||
    spec.kind === 'struct' ||
    sourceValueBacked ||
    (requiresReference && !hasReferences);

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t('paramEdit.editTitle', { label: labels.longLabel })}
      className="w-full max-w-md p-6"
    >
      <div>
        <h3 className="text-lg font-semibold mb-1">{t('paramEdit.editTitle', { label: labels.longLabel })}</h3>
        {subtitle && (
          <p className="text-xs text-muted-foreground mb-4">{subtitle}</p>
        )}

        <div className="flex flex-col gap-3">
          {sourceValueBacked ? (
            <p className="text-sm text-red-600">
              {t('paramEdit.errors.entryBacked')}
            </p>
          ) : spec.kind === 'struct' ? (
            <p className="text-sm text-red-600">
              {t('paramEdit.structNotSupported')}
            </p>
          ) : (
            <>
              {isRangeSpec(spec) ? (
                <RangeFields
                  spec={spec}
                  min={min}
                  max={max}
                  mean={mean}
                  median={median}
                  unit={unit}
                  note={note}
                  setMin={setMin}
                  setMax={setMax}
                  setMean={setMean}
                  setMedian={setMedian}
                  setUnit={setUnit}
                  setNote={setNote}
                />
              ) : spec.kind === 'text' ? (
                <TextField
                  spec={spec}
                  value={textValue}
                  onChange={setTextValue}
                />
              ) : spec.kind === 'number' ? (
                <NumberField
                  spec={spec}
                  value={textValue}
                  onChange={setTextValue}
                />
              ) : spec.kind === 'list' ? (
                <ListField
                  spec={spec}
                  value={textValue}
                  onChange={setTextValue}
                />
              ) : null}

              <div className="border-t border-border pt-3">
                <div className="text-xs text-muted-foreground mb-1.5">
                  {requiresReference
                    ? t('paramEdit.sources')
                    : t('paramEdit.sourcesOptional')}
                </div>
                {references.length > 0 && (
                  <ul className="mb-2 space-y-1">
                    {references.map((r, i) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1 text-xs"
                      >
                        <span className="text-muted-foreground font-mono text-[10px]">
                          [{i + 1}]
                        </span>
                        <span className="flex-1 truncate">{r.name}</span>
                        <button
                          type="button"
                          onClick={() => removeReference(r.id)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('paramEdit.removeSource')}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {showPicker || (requiresReference && references.length === 0) ? (
                  <ReferenceInput
                    drugId={drugId}
                    required={requiresReference && references.length === 0}
                    onReferenceCreated={handleReferenceCreated}
                  />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPicker(true)}
                  >
                    {t('paramEdit.addSource')}
                  </Button>
                )}
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  {t('paramEdit.editSummary')} ({t('paramEdit.optional')})
                </span>
                <Input
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  placeholder={t('paramEdit.whyChanging')}
                />
              </label>
            </>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          {isAdmin ? (
            <>
              <Button
                variant="outline"
                onClick={() => handleSave(true)}
                disabled={formDisabled}
              >
                {saving ? t('wiki.saving') : t('paramEdit.submitForReview')}
              </Button>
              <Button
                onClick={() => handleSave(false)}
                disabled={formDisabled}
              >
                {saving ? t('wiki.saving') : t('paramEdit.savePublish')}
              </Button>
            </>
          ) : (
            <Button onClick={() => handleSave(true)} disabled={formDisabled}>
              {saving ? t('wiki.saving') : t('paramEdit.suggestChange')}
            </Button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

function renderSubtitle(spec: ParameterSpec, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (isRangeSpec(spec)) {
    const bounds = t('paramEdit.allowedBounds', { min: spec.bounds.min, max: spec.bounds.max });
    return spec.requiresMinMax ? `${bounds}${t('paramEdit.minMaxRequired')}` : bounds;
  }
  if (spec.kind === 'text') {
    return t('paramEdit.textSubtitle', { max: spec.maxLength });
  }
  if (spec.kind === 'number') {
    return t('paramEdit.numberSubtitle', { min: spec.bounds.min, max: spec.bounds.max });
  }
  if (spec.kind === 'list') {
    return t('paramEdit.listSubtitle', {
      max: spec.maxItems,
      itemMax: spec.maxItemLength,
      defaultValue:
        'Comma- or newline-separated. Up to {{max}} entries, {{itemMax}} characters each.',
    });
  }
  return '';
}

interface RangeFieldsProps {
  spec: Extract<ParameterSpec, { kind: 'range' | 'fraction' | 'ratio' | 'scalar' | 'struct' }>;
  min: string;
  max: string;
  mean: string;
  median: string;
  unit: string;
  note: string;
  setMin: (v: string) => void;
  setMax: (v: string) => void;
  setMean: (v: string) => void;
  setMedian: (v: string) => void;
  setUnit: (v: string) => void;
  setNote: (v: string) => void;
}

function RangeFields({
  spec,
  min,
  max,
  mean,
  median,
  unit,
  note,
  setMin,
  setMax,
  setMean,
  setMedian,
  setUnit,
  setNote,
}: RangeFieldsProps) {
  const { t } = useTranslation();
  const unitOptions = spec.allowedUnits.map((u: string) => ({ value: u, label: u }));
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('paramEdit.min')}</span>
          <Input
            type="text"
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('paramEdit.max')}</span>
          <Input
            type="text"
            inputMode="decimal"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
      </div>

      {!spec.requiresMinMax && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('paramEdit.mean')}</span>
            <Input
              type="text"
              inputMode="decimal"
              value={mean}
              onChange={(e) => setMean(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('paramEdit.median')}</span>
            <Input
              type="text"
              inputMode="decimal"
              value={median}
              onChange={(e) => setMedian(e.target.value)}
            />
          </label>
        </div>
      )}

      {unitOptions.length > 0 && (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('paramEdit.unit')}</span>
          <Select
            options={unitOptions}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('paramEdit.noteOptional')}</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </>
  );
}

function TextField({
  spec,
  value,
  onChange,
}: {
  spec: Extract<ParameterSpec, { kind: 'text' }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const { label } = useParameterLabels(spec);
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {spec.required ? '' : ` (${t('paramEdit.optional')})`}
      </span>
      <Input
        type="text"
        value={value}
        maxLength={spec.maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function NumberField({
  spec,
  value,
  onChange,
}: {
  spec: Extract<ParameterSpec, { kind: 'number' }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const { label } = useParameterLabels(spec);
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {spec.unitLabel ? `${label} (${spec.unitLabel})` : label}
      </span>
      <Input
        type="text"
        inputMode={spec.isInteger ? 'numeric' : 'decimal'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ListField({
  spec,
  value,
  onChange,
}: {
  spec: Extract<ParameterSpec, { kind: 'list' }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const { label } = useParameterLabels(spec);
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label} ({t('paramEdit.optional')})
      </span>
      <textarea
        className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y min-h-[72px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('paramEdit.listPlaceholder', {
          defaultValue: 'e.g. Xanax, Helex, blue football',
        })}
      />
    </label>
  );
}
