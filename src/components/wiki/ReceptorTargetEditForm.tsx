import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { ReferenceInput } from './ReferenceInput';
import type { ReferenceRow } from '@/lib/referenceApi';
import {
  ApiError,
  submitDrugReceptorTargets,
  searchReceptorTargets,
  type ReceptorMechanismInput,
  type MechanismMeasurementInput,
} from '@/lib/drugApi';
import type {
  DrugReceptorTargetSummary,
  ReceptorTargetSummary,
} from '@/lib/receptorTargets';
import { parseLocaleNumber } from '@/lib/parseNumber';
import {
  INTERACTION_GROUPS,
  formatInteractionLabel,
  isKnownInteractionType,
} from '@/lib/receptorInteractions';
import { useCan } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';

interface Props {
  drugId: number;
  drugName: string;
  receptorTargets: DrugReceptorTargetSummary[];
  onClose: () => void;
  onSaved: () => void;
}

const METRIC_KEYS = [
  'ki',
  'ic50',
  'ec50',
  'emax',
  'affinity',
  'potency',
  'efficacy',
  'selectivityRatio',
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

const METRIC_LABELS: Record<MetricKey, string> = {
  ki: 'Ki',
  ic50: 'IC50',
  ec50: 'EC50',
  emax: 'Emax',
  affinity: 'Affinity',
  potency: 'Potency',
  efficacy: 'Efficacy',
  selectivityRatio: 'Selectivity',
};

// Ki/IC50/EC50/Emax are language-neutral abbreviations; the remaining metrics
// are words that need translating. Render via `t(METRIC_LABEL_KEYS[k])` and
// fall back to METRIC_LABELS for the abbreviations (which have no key).
const METRIC_LABEL_KEYS: Partial<Record<MetricKey, string>> = {
  affinity: 'mechanismEdit.metricAffinity',
  potency: 'mechanismEdit.metricPotency',
  efficacy: 'mechanismEdit.metricEfficacy',
  selectivityRatio: 'mechanismEdit.metricSelectivity',
};

/**
 * One metric's inputs. A stored measurement is `{min, max, mean, median, unit,
 * note}` — the same shape the drug parameters use — and a mechanism measured
 * once (the common case: a single reported Ki) carries only `median`. The form
 * therefore has to edit the central values too: it used to bind min/max/unit
 * alone, which both hid a median-only value and, because the write is a full
 * replace, DELETED it on the next save. `note` is not editable here but is
 * round-tripped for the same reason.
 */
interface MeasurementInput {
  min: string;
  max: string;
  mean: string;
  median: string;
  unit: string;
  note: string;
}

/**
 * The numeric inputs shown per metric, in reading order. Short labels because
 * they render as placeholders in a six-column row — the long
 * `paramEdit.mean`/`paramEdit.median` strings carry an "(optional)" suffix that
 * does not fit here.
 */
const METRIC_FIELDS = [
  { key: 'min', labelKey: 'paramEdit.min' },
  { key: 'max', labelKey: 'paramEdit.max' },
  { key: 'mean', labelKey: 'mechanismEdit.metricMean' },
  { key: 'median', labelKey: 'mechanismEdit.metricMedian' },
] as const satisfies readonly {
  key: keyof Pick<MeasurementInput, 'min' | 'max' | 'mean' | 'median'>;
  labelKey: string;
}[];

interface PickedReference {
  id: number;
  name: string;
}

interface MechanismRow {
  key: string;
  receptorTargetId: number | null;
  targetSymbol: string;
  targetName: string;
  interactionType: string;
  tier: '' | 'primary' | 'secondary' | 'tertiary';
  metrics: Record<MetricKey, MeasurementInput>;
  references: PickedReference[];
  /**
   * Species the measurements were made in (#1017). Blank = unstated; the
   * catalog target itself stays human-canonical, so this is the only place a
   * non-human assay is visible as such.
   */
  assaySpecies: string;
  evidenceNote: string;
  showMetrics: boolean;
  showRefPicker: boolean;
}

/** Maps stable API error codes to translation keys for the React boundary. */
const RECEPTOR_TARGET_ERROR_KEYS: Record<string, string> = {
  receptor_target_drug_not_found: 'mechanismEdit.errorDrugNotFound',
  receptor_target_symbol_or_name_required: 'mechanismEdit.targetRequired',
  receptor_target_links_missing: 'mechanismEdit.errorLinksMissing',
  receptor_target_duplicate: 'mechanismEdit.errorDuplicate',
  receptor_target_create_failed: 'mechanismEdit.errorCreateFailed',
};

let rowSeq = 0;
function newKey(): string {
  rowSeq += 1;
  return `m${rowSeq}`;
}

function emptyMeasurement(): MeasurementInput {
  return { min: '', max: '', mean: '', median: '', unit: '', note: '' };
}

function emptyMetrics(): Record<MetricKey, MeasurementInput> {
  return Object.fromEntries(
    METRIC_KEYS.map((k) => [k, emptyMeasurement()]),
  ) as Record<MetricKey, MeasurementInput>;
}

function numText(value: number | undefined): string {
  return value !== undefined ? String(value) : '';
}

function metricsFrom(
  target: DrugReceptorTargetSummary,
): Record<MetricKey, MeasurementInput> {
  const metrics = emptyMetrics();
  for (const key of METRIC_KEYS) {
    const range = target[key];
    if (range) {
      metrics[key] = {
        min: numText(range.min),
        max: numText(range.max),
        mean: numText(range.mean),
        median: numText(range.median),
        unit: range.unit ?? '',
        note: range.note ?? '',
      };
    }
  }
  return metrics;
}

/** True when a mechanism already carries at least one measurement. */
function hasMeasurements(target: DrugReceptorTargetSummary): boolean {
  return METRIC_KEYS.some((key) => target[key] != null);
}

function rowFromTarget(target: DrugReceptorTargetSummary): MechanismRow {
  return {
    key: newKey(),
    receptorTargetId: target.receptorTargetId,
    targetSymbol: target.target.symbol,
    targetName: target.target.name,
    interactionType: target.interactionType,
    tier: (target.tier ?? '') as MechanismRow['tier'],
    metrics: metricsFrom(target),
    references: target.referenceIds.map((id) => ({ id, name: `#${id}` })),
    assaySpecies: target.assaySpecies ?? '',
    evidenceNote: target.evidenceNote ?? '',
    // Open the metrics panel when there is something in it: a save replaces
    // every mechanism wholesale, so stored numbers must be visible to whoever
    // is about to write over them.
    showMetrics: hasMeasurements(target),
    showRefPicker: false,
  };
}

function emptyRow(): MechanismRow {
  return {
    key: newKey(),
    receptorTargetId: null,
    targetSymbol: '',
    targetName: '',
    interactionType: 'unspecified',
    tier: '',
    metrics: emptyMetrics(),
    references: [],
    assaySpecies: '',
    evidenceNote: '',
    showMetrics: false,
    showRefPicker: false,
  };
}

/** `'invalid'` = a filled field that is not a finite number; see parseLocaleNumber. */
function buildMeasurement(
  m: MeasurementInput,
): MechanismMeasurementInput | undefined | 'invalid' {
  const out: MechanismMeasurementInput = {};
  for (const field of ['min', 'max', 'mean', 'median'] as const) {
    if (m[field].trim() === '') continue;
    const parsed = parseLocaleNumber(m[field]);
    if (!Number.isFinite(parsed)) return 'invalid';
    out[field] = parsed;
  }
  if (m.unit.trim() !== '') out.unit = m.unit.trim();
  if (m.note.trim() !== '') out.note = m.note.trim();
  // A unit or a note on its own is not a reading — the store drops such an
  // object anyway, so leaving the metric out keeps the payload honest.
  const hasReading =
    out.min !== undefined ||
    out.max !== undefined ||
    out.mean !== undefined ||
    out.median !== undefined;
  if (!hasReading) return undefined;
  return out;
}

export function ReceptorTargetEditForm({
  drugId,
  drugName,
  receptorTargets,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const isAdmin = useCan('edit.directWrite');

  const [rows, setRows] = useState<MechanismRow[]>(() =>
    receptorTargets.length > 0 ? receptorTargets.map(rowFromTarget) : [emptyRow()],
  );
  const [editSummary, setEditSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateRow(key: string, patch: Partial<MechanismRow>) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }

  function updateMetric(key: string, metric: MetricKey, patch: Partial<MeasurementInput>) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, metrics: { ...r.metrics, [metric]: { ...r.metrics[metric], ...patch } } }
          : r,
      ),
    );
  }

  function metricLabel(metricKey: MetricKey): string {
    const key = METRIC_LABEL_KEYS[metricKey];
    return key ? t(key) : METRIC_LABELS[metricKey];
  }

  function buildPayload():
    | { ok: true; mechanisms: ReceptorMechanismInput[] }
    | { ok: false; message: string } {
    const mechanisms: ReceptorMechanismInput[] = [];
    for (const row of rows) {
      const symbol = row.targetSymbol.trim();
      const name = row.targetName.trim();
      if (row.receptorTargetId == null && !symbol && !name) {
        return { ok: false, message: t('mechanismEdit.targetRequired') };
      }
      const mechanism: ReceptorMechanismInput = {
        receptorTargetId: row.receptorTargetId,
        targetSymbol: symbol || undefined,
        targetName: name || undefined,
        interactionType: row.interactionType.trim() || 'unspecified',
        tier: row.tier || null,
        referenceIds: row.references.map((r) => r.id),
        assaySpecies: row.assaySpecies.trim() || null,
        evidenceNote: row.evidenceNote.trim() || null,
      };
      for (const metricKey of METRIC_KEYS) {
        const built = buildMeasurement(row.metrics[metricKey]);
        if (built === 'invalid') {
          return {
            ok: false,
            message: t('mechanismEdit.metricNumberInvalid', {
              metric: metricLabel(metricKey),
            }),
          };
        }
        if (built) mechanism[metricKey] = built;
      }
      mechanisms.push(mechanism);
    }
    return { ok: true, mechanisms };
  }

  async function handleSave(submitForReview: boolean) {
    setError(null);
    const built = buildPayload();
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setSaving(true);
    try {
      const result = await submitDrugReceptorTargets(drugId, {
        mechanisms: built.mechanisms,
        editSummary: editSummary || undefined,
        submitForReview,
      });
      if ('pending' in result && result.pending) {
        showToast(t('paramEdit.changeSubmitted'));
      } else {
        showToast(t('paramEdit.parameterUpdated'));
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code) {
        const key = RECEPTOR_TARGET_ERROR_KEYS[err.code];
        setError(key ? t(key) : err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  const tierOptions = [
    { value: '', label: t('mechanismEdit.tierNone') },
    { value: 'primary', label: t('sidebar.mechanismPrimary') },
    { value: 'secondary', label: t('sidebar.mechanismSecondary') },
    { value: 'tertiary', label: t('sidebar.mechanismTertiary') },
  ];

  const interactionGroups = INTERACTION_GROUPS.map((group) => ({
    label: t(group.labelKey),
    options: group.options.map((opt) => ({
      value: opt.value,
      label: t(opt.labelKey),
    })),
  }));

  /**
   * Keep a legacy/custom interaction value selectable when editing an existing
   * mechanism whose stored value isn't part of the canonical taxonomy.
   */
  function interactionGroupsFor(currentValue: string) {
    if (!currentValue || isKnownInteractionType(currentValue)) {
      return interactionGroups;
    }
    return [
      {
        label: t('mechanismEdit.interactionGroups.custom'),
        options: [
          { value: currentValue, label: formatInteractionLabel(currentValue, t) },
        ],
      },
      ...interactionGroups,
    ];
  }

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={t('mechanismEdit.title', { drug: drugName })}
      className="w-full max-w-2xl p-6"
    >
      <div>
        <h3 className="text-lg font-semibold mb-1">
          {t('mechanismEdit.title', { drug: drugName })}
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          {t('mechanismEdit.subtitle')}
        </p>

        <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="rounded-md border border-border p-3 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('mechanismEdit.mechanismN', { n: index + 1 })}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setRows((prev) => prev.filter((r) => r.key !== row.key))
                  }
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('mechanismEdit.removeMechanism')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <TargetPicker
                symbol={row.targetSymbol}
                name={row.targetName}
                linked={row.receptorTargetId != null}
                onPick={(target) =>
                  updateRow(row.key, {
                    receptorTargetId: target.id,
                    targetSymbol: target.symbol,
                    targetName: target.nameEn ?? target.name,
                  })
                }
                onSymbolChange={(v) =>
                  updateRow(row.key, {
                    targetSymbol: v,
                    receptorTargetId: null,
                  })
                }
                onNameChange={(v) =>
                  updateRow(row.key, { targetName: v, receptorTargetId: null })
                }
              />

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {t('mechanismEdit.interaction')}
                  </span>
                  <Select
                    groups={interactionGroupsFor(row.interactionType)}
                    value={row.interactionType}
                    onChange={(e) =>
                      updateRow(row.key, { interactionType: e.target.value })
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {t('mechanismEdit.tier')}
                  </span>
                  <Select
                    options={tierOptions}
                    value={row.tier}
                    onChange={(e) =>
                      updateRow(row.key, {
                        tier: e.target.value as MechanismRow['tier'],
                      })
                    }
                  />
                </label>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() =>
                    updateRow(row.key, { showMetrics: !row.showMetrics })
                  }
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {row.showMetrics ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  {t('mechanismEdit.metrics')}
                </button>
                {row.showMetrics && (
                  <div className="mt-2 space-y-1.5">
                    {METRIC_KEYS.map((metricKey) => (
                      <div
                        key={metricKey}
                        className="grid grid-cols-[4.5rem_repeat(5,minmax(0,1fr))] items-center gap-1.5 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {metricLabel(metricKey)}
                        </span>
                        {METRIC_FIELDS.map((field) => (
                          <Input
                            key={field.key}
                            inputMode="decimal"
                            placeholder={t(field.labelKey)}
                            aria-label={`${metricLabel(metricKey)} ${t(
                              field.labelKey,
                            )}`}
                            value={row.metrics[metricKey][field.key]}
                            onChange={(e) =>
                              updateMetric(row.key, metricKey, {
                                [field.key]: e.target.value,
                              })
                            }
                          />
                        ))}
                        <Input
                          placeholder={t('paramEdit.unit')}
                          aria-label={`${metricLabel(metricKey)} ${t(
                            'paramEdit.unit',
                          )}`}
                          value={row.metrics[metricKey].unit}
                          onChange={(e) =>
                            updateMetric(row.key, metricKey, {
                              unit: e.target.value,
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-2">
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t('paramEdit.sourcesOptional')}
                </div>
                {row.references.length > 0 && (
                  <ul className="mb-2 space-y-1">
                    {row.references.map((r, i) => (
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
                          onClick={() =>
                            updateRow(row.key, {
                              references: row.references.filter(
                                (x) => x.id !== r.id,
                              ),
                            })
                          }
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('paramEdit.removeSource')}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {row.showRefPicker ? (
                  <ReferenceInput
                    drugId={drugId}
                    onReferenceCreated={(ref: ReferenceRow) => {
                      const name = ref.metadata?.title ?? ref.identifier;
                      updateRow(row.key, {
                        showRefPicker: false,
                        references: row.references.some((x) => x.id === ref.id)
                          ? row.references
                          : [...row.references, { id: ref.id, name }],
                      });
                    }}
                  />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateRow(row.key, { showRefPicker: true })}
                  >
                    {t('paramEdit.addSource')}
                  </Button>
                )}
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  {t('mechanismEdit.assaySpecies')}
                </span>
                <Input
                  value={row.assaySpecies}
                  placeholder={t('mechanismEdit.assaySpeciesPlaceholder')}
                  onChange={(e) =>
                    updateRow(row.key, { assaySpecies: e.target.value })
                  }
                />
                <span className="text-muted-foreground">
                  {t('mechanismEdit.assaySpeciesHint')}
                </span>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  {t('mechanismEdit.evidenceNote')}
                </span>
                <Input
                  value={row.evidenceNote}
                  onChange={(e) =>
                    updateRow(row.key, { evidenceNote: e.target.value })
                  }
                />
              </label>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRows((prev) => [...prev, emptyRow()])}
            className="self-start"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('mechanismEdit.addMechanism')}
          </Button>
        </div>

        <label className="flex flex-col gap-1 text-xs mt-4">
          <span className="text-muted-foreground">
            {t('paramEdit.editSummary')} ({t('paramEdit.optional')})
          </span>
          <Input
            value={editSummary}
            onChange={(e) => setEditSummary(e.target.value)}
            placeholder={t('paramEdit.whyChanging')}
          />
        </label>

        {error && <div className="text-sm text-red-600 mt-3">{error}</div>}

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          {isAdmin ? (
            <>
              <Button
                variant="outline"
                onClick={() => handleSave(true)}
                disabled={saving}
              >
                {saving ? t('wiki.saving') : t('paramEdit.submitForReview')}
              </Button>
              <Button onClick={() => handleSave(false)} disabled={saving}>
                {saving ? t('wiki.saving') : t('paramEdit.savePublish')}
              </Button>
            </>
          ) : (
            <Button onClick={() => handleSave(true)} disabled={saving}>
              {saving ? t('wiki.saving') : t('paramEdit.suggestChange')}
            </Button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

function TargetPicker({
  symbol,
  name,
  linked,
  onPick,
  onSymbolChange,
  onNameChange,
}: {
  symbol: string;
  name: string;
  linked: boolean;
  onPick: (target: ReceptorTargetSummary) => void;
  onSymbolChange: (v: string) => void;
  onNameChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [results, setResults] = useState<ReceptorTargetSummary[]>([]);
  const [open, setOpen] = useState(false);

  async function runSearch(q: string) {
    onSymbolChange(q);
    if (q.trim().length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    try {
      const found = await searchReceptorTargets(q);
      setResults(found);
      setOpen(found.length > 0);
    } catch {
      setResults([]);
      setOpen(false);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="relative">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t('mechanismEdit.targetSymbol')}
          </span>
          <Input
            value={symbol}
            placeholder={t('mechanismEdit.searchPlaceholder')}
            onChange={(e) => runSearch(e.target.value)}
            onFocus={() => setOpen(results.length > 0)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </label>
        {open && (
          <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-md text-xs">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="w-full px-2 py-1.5 text-left hover:bg-muted"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(r);
                    setOpen(false);
                  }}
                >
                  <span className="font-medium">{r.symbol}</span>
                  <span className="ml-1 text-muted-foreground">
                    {r.nameEn ?? r.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">
          {t('mechanismEdit.targetName')}
          {linked ? ` · ${t('mechanismEdit.linked')}` : ''}
        </span>
        <Input value={name} onChange={(e) => onNameChange(e.target.value)} />
      </label>
    </div>
  );
}
