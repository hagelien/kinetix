import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseLocaleNumber } from '@/lib/parseNumber';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { getDrugDisplayName } from '@/lib/useDrugName';
import { useTranslation } from 'react-i18next';
import {
  createReferenceConcentration,
  deleteReferenceConcentration,
  fetchReferenceConcentrations,
  updateReferenceConcentration,
  type ReferenceConcentrationRow,
} from '@/lib/referenceConcentrationsApi';
import {
  REFERENCE_MATRICES,
  REFERENCE_MATRIX_LABEL_KEYS,
  REFERENCE_SCENARIOS,
  REFERENCE_SCENARIO_LABEL_KEYS,
  REFERENCE_UNITS,
  type ReferenceConcentrationInput,
  type ReferenceConcentrationUpdateInput,
  type ReferenceMatrix,
  type ReferenceScenario,
  type ReferenceUnit,
} from '@/lib/referenceConcentrations';

interface DrugSelection {
  dbId: number;
  name: string;
  molecularWeight: number | null;
}

interface FormState {
  low: string;
  high: string;
  unit: ReferenceUnit;
  matrix: ReferenceMatrix;
  scenario: ReferenceScenario;
  n: string;
  comments: string;
  citationId: string;
}

const EMPTY_FORM: FormState = {
  low: '',
  high: '',
  unit: 'ng/mL',
  matrix: 'serum',
  scenario: 'living_therapeutic',
  n: '',
  comments: '',
  citationId: '',
};

function rowToForm(row: ReferenceConcentrationRow): FormState {
  return {
    low: row.low != null ? String(row.low) : '',
    high: row.high != null ? String(row.high) : '',
    unit: row.unit,
    matrix: row.matrix,
    scenario: row.scenario,
    n: row.n != null ? String(row.n) : '',
    comments: row.comments ?? '',
    citationId: row.citationId != null ? String(row.citationId) : '',
  };
}

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = parseLocaleNumber(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}

function buildPayload(
  form: FormState,
  t: (key: string) => string,
): { ok: true; data: Omit<ReferenceConcentrationInput, 'drugId'> } | { ok: false; error: string } {
  const low = parseOptionalNumber(form.low);
  const high = parseOptionalNumber(form.high);
  if (Number.isNaN(low)) return { ok: false, error: t('admin.referenceConc.errorLowNotNumber') };
  if (Number.isNaN(high)) return { ok: false, error: t('admin.referenceConc.errorHighNotNumber') };
  if (low === undefined && high === undefined) {
    return { ok: false, error: t('admin.referenceConc.errorLowOrHighRequired') };
  }
  if (low !== undefined && high !== undefined && low > high) {
    return { ok: false, error: t('admin.referenceConc.errorLowGreaterThanHigh') };
  }

  const n = parseOptionalNumber(form.n);
  if (Number.isNaN(n)) return { ok: false, error: t('admin.referenceConc.errorNNotPositiveInt') };
  if (n !== undefined && (!Number.isInteger(n) || n <= 0)) {
    return { ok: false, error: t('admin.referenceConc.errorNNotPositiveInt') };
  }

  const citationId = parseOptionalNumber(form.citationId);
  if (Number.isNaN(citationId)) return { ok: false, error: t('admin.referenceConc.errorCitationIdNotNumber') };
  if (citationId !== undefined && (!Number.isInteger(citationId) || citationId <= 0)) {
    return { ok: false, error: t('admin.referenceConc.errorCitationIdNotPositiveInt') };
  }

  const trimmedComments = form.comments.trim();

  return {
    ok: true,
    data: {
      low,
      high,
      unit: form.unit,
      matrix: form.matrix,
      scenario: form.scenario,
      n,
      comments: trimmedComments ? trimmedComments : undefined,
      citationId,
    },
  };
}

function formatRange(row: ReferenceConcentrationRow): string {
  if (row.low != null && row.high != null) return `${row.low}–${row.high} ${row.unit}`;
  if (row.low != null) return `≥ ${row.low} ${row.unit}`;
  if (row.high != null) return `≤ ${row.high} ${row.unit}`;
  return '—';
}

interface RowFormProps {
  form: FormState;
  setForm: (next: FormState) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
}

function RowForm({ form, setForm, onSubmit, onCancel, submitLabel, busy }: RowFormProps) {
  const { t } = useTranslation();
  return (
    <form onSubmit={onSubmit} className="space-y-2 border border-border rounded-lg p-3 bg-muted/20">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.low')}
          <Input
            type="number"
            step="any"
            min="0"
            value={form.low}
            onChange={(e) => setForm({ ...form, low: e.target.value })}
            placeholder={t('admin.referenceConc.blankNonePlaceholder')}
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.high')}
          <Input
            type="number"
            step="any"
            min="0"
            value={form.high}
            onChange={(e) => setForm({ ...form, high: e.target.value })}
            placeholder={t('admin.referenceConc.blankNonePlaceholder')}
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.unit')}
          <select
            className="bg-background border border-input rounded px-2 py-1 text-sm h-9"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value as ReferenceUnit })}
          >
            {REFERENCE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.matrix')}
          <select
            className="bg-background border border-input rounded px-2 py-1 text-sm h-9"
            value={form.matrix}
            onChange={(e) => setForm({ ...form, matrix: e.target.value as ReferenceMatrix })}
          >
            {REFERENCE_MATRICES.map((m) => (
              <option key={m} value={m}>
                {t(REFERENCE_MATRIX_LABEL_KEYS[m])}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.scenario')}
          <select
            className="bg-background border border-input rounded px-2 py-1 text-sm h-9"
            value={form.scenario}
            onChange={(e) => setForm({ ...form, scenario: e.target.value as ReferenceScenario })}
          >
            {REFERENCE_SCENARIOS.map((s) => (
              <option key={s} value={s}>
                {t(REFERENCE_SCENARIO_LABEL_KEYS[s])}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.nOptional')}
          <Input
            type="number"
            step="1"
            min="1"
            value={form.n}
            onChange={(e) => setForm({ ...form, n: e.target.value })}
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1 sm:col-span-2">
          {t('admin.referenceConc.commentsOptional')}
          <Input
            value={form.comments}
            onChange={(e) => setForm({ ...form, comments: e.target.value })}
            placeholder={t('admin.referenceConc.commentsPlaceholder')}
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('admin.referenceConc.citationIdOptional')}
          <Input
            type="number"
            step="1"
            min="1"
            value={form.citationId}
            onChange={(e) => setForm({ ...form, citationId: e.target.value })}
          />
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? '…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function ReferenceConcentrationsAdminSection() {
  const { t, i18n } = useTranslation();
  const [drug, setDrug] = useState<DrugSelection | null>(null);
  const [rows, setRows] = useState<ReferenceConcentrationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  // Discriminator so a stale fetch (e.g. drug A's response arriving after the
  // user already switched to drug B) can't overwrite the current drug's rows.
  const loadRequestIdRef = useRef(0);

  const grouped = useMemo(() => {
    const map = new Map<ReferenceScenario, ReferenceConcentrationRow[]>();
    for (const row of rows) {
      const list = map.get(row.scenario) ?? [];
      list.push(row);
      map.set(row.scenario, list);
    }
    return map;
  }, [rows]);

  async function load(dbId: number) {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const items = await fetchReferenceConcentrations(dbId, { fresh: true });
      if (requestId !== loadRequestIdRef.current) return;
      setRows(items);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : t('admin.referenceConc.loadError'));
      setRows([]);
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    // Clear rows and any in-flight edit/add state immediately so the previous
    // drug's actionable rows can't appear under the new drug's header during
    // the swap.
    setRows([]);
    setEditingId(null);
    setShowAdd(false);
    if (!drug) return;
    void load(drug.dbId);
  }, [drug]);

  function resetAddForm() {
    setAddForm(EMPTY_FORM);
    setShowAdd(false);
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!drug) return;
    const built = buildPayload(addForm, t);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload: ReferenceConcentrationInput = { drugId: drug.dbId, ...built.data };
      await createReferenceConcentration(payload);
      resetAddForm();
      await load(drug.dbId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.referenceConc.addError'));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: ReferenceConcentrationRow) {
    setEditingId(row.id);
    setEditForm(rowToForm(row));
    setError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(EMPTY_FORM);
  }

  async function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (editingId == null || !drug) return;
    const built = buildPayload(editForm, t);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload: ReferenceConcentrationUpdateInput = built.data;
      await updateReferenceConcentration(editingId, payload);
      cancelEdit();
      await load(drug.dbId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.referenceConc.updateError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(row: ReferenceConcentrationRow) {
    if (!drug) return;
    if (
      !window.confirm(
        t('admin.referenceConc.confirmDelete', {
          scenario: t(REFERENCE_SCENARIO_LABEL_KEYS[row.scenario]),
        }),
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await deleteReferenceConcentration(row.id);
      await load(drug.dbId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.referenceConc.deleteError'));
    } finally {
      setBusy(false);
    }
  }

  function handleDuplicate(row: ReferenceConcentrationRow) {
    setAddForm(rowToForm(row));
    setShowAdd(true);
    setError('');
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('referenceConc.title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('admin.referenceConc.description')}
      </p>

      <div className="max-w-md mb-4">
        <DrugSearchDropdown
          placeholder={t('admin.referenceConc.searchPlaceholder')}
          onSelect={(d) => {
            if (d._dbId == null) {
              setError(t('admin.referenceConc.errorNoDbId'));
              return;
            }
            setDrug({
              dbId: d._dbId,
              name: getDrugDisplayName(d, i18n.language),
              molecularWeight: d.molecularWeight ?? null,
            });
            setShowAdd(false);
            setEditingId(null);
            setError('');
          }}
        />
      </div>

      {drug && (
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm">
            <span className="text-muted-foreground">{t('admin.referenceConc.editingRowsFor')} </span>
            <span className="font-semibold">{drug.name}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant={showAdd ? 'outline' : 'default'}
            onClick={() => {
              if (showAdd) {
                resetAddForm();
              } else {
                setAddForm(EMPTY_FORM);
                setShowAdd(true);
              }
            }}
          >
            {showAdd ? t('common.cancel') : t('admin.referenceConc.addRow')}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {drug && showAdd && (
        <div className="mb-4">
          <RowForm
            form={addForm}
            setForm={setAddForm}
            onSubmit={handleAdd}
            onCancel={resetAddForm}
            submitLabel={t('common.add')}
            busy={busy}
          />
        </div>
      )}

      {drug && loading && (
        <p className="text-sm text-muted-foreground">{t('admin.referenceConc.loadingRows')}</p>
      )}

      {drug && !loading && rows.length === 0 && !showAdd && (
        <p className="text-sm text-muted-foreground">{t('admin.referenceConc.empty')}</p>
      )}

      {drug && rows.length > 0 && (
        <div className="space-y-4">
          {REFERENCE_SCENARIOS.map((scenario) => {
            const items = grouped.get(scenario);
            if (!items || items.length === 0) return null;
            return (
              <div key={scenario}>
                <h3 className="text-sm font-semibold mb-2">
                  {t(REFERENCE_SCENARIO_LABEL_KEYS[scenario])}
                </h3>
                <ul className="border border-border rounded-lg divide-y divide-border">
                  {items.map((row) => (
                    <li key={row.id} className="p-3 text-sm">
                      {editingId === row.id ? (
                        <RowForm
                          form={editForm}
                          setForm={setEditForm}
                          onSubmit={handleEditSubmit}
                          onCancel={cancelEdit}
                          submitLabel={t('common.save')}
                          busy={busy}
                        />
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">
                              <UnitTooltip
                                low={row.low ?? null}
                                high={row.high ?? null}
                                unit={row.unit}
                                molecularWeight={drug?.molecularWeight ?? null}
                              >
                                {formatRange(row)}
                              </UnitTooltip>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t(REFERENCE_MATRIX_LABEL_KEYS[row.matrix])}
                              {row.n != null && ` · n = ${row.n}`}
                              {row.comments && ` · ${row.comments}`}
                              {row.citation &&
                                ` · ${t('admin.referenceConc.citationRef', { id: row.citation.id })}`}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => startEdit(row)}
                              disabled={busy}
                            >
                              {t('common.edit')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleDuplicate(row)}
                              disabled={busy}
                            >
                              {t('common.duplicate')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void handleDelete(row)}
                              disabled={busy}
                            >
                              {t('common.delete')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
