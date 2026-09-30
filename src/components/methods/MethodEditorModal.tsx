import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import {
  createMethod,
  updateMethod,
  fetchMethodDetail,
  type MethodMatrix,
  type MethodType,
  type MethodInput,
} from '@/lib/drugApi';
import { resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import {
  METHOD_MATRICES,
  METHOD_TYPES,
  matrixColor,
  matrixLabelKey,
  methodTypeLabelKey,
} from '@/lib/methodMeta';
import { X, Trash2 } from 'lucide-react';

interface EditRow {
  drugId: number;
  name: string;
  lor: string;
  mkk: string;
  lod: string;
  unit: string;
  uncertainty: string;
}

interface MethodEditorModalProps {
  /** When set, edit this method; otherwise create a new one. */
  methodId?: number;
  onClose: () => void;
  /** Called after a successful save with the saved method id. */
  onSaved: (methodId: number) => void;
}

function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function MethodEditorModal({
  methodId,
  onClose,
  onSaved,
}: MethodEditorModalProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const isEdit = methodId != null;
  // One string for the visible heading and the dialog's accessible name, so
  // the two can never drift apart.
  const heading = isEdit ? t('methods.editTitle') : t('methods.createTitle');

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [matrices, setMatrices] = useState<MethodMatrix[]>([]);
  const [volume, setVolume] = useState('');
  const [methodType, setMethodType] = useState<MethodType | ''>('');
  const [rows, setRows] = useState<EditRow[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (methodId == null) return;
    let active = true;
    setLoading(true);
    fetchMethodDetail(methodId)
      .then(({ method }) => {
        if (!active) return;
        setCode(method.code);
        setName(method.name);
        setDescription(method.description ?? '');
        setMatrices(method.matrices ?? []);
        setVolume(method.volumeMl != null ? String(method.volumeMl) : '');
        setMethodType(method.methodType ?? '');
        setRows(
          method.components.map((c) => ({
            drugId: c.drugId,
            name: resolveDrugName(c.names, lang) || c.slug,
            lor: c.lor != null ? String(c.lor) : '',
            mkk: c.mkk != null ? String(c.mkk) : '',
            lod: c.lod != null ? String(c.lod) : '',
            unit: c.unit ?? '',
            uncertainty:
              c.measurementUncertainty != null
                ? String(c.measurementUncertainty)
                : '',
          })),
        );
      })
      .catch(() => {
        if (active) setErrorMsg(t('methods.loadError'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [methodId, lang, t]);

  const defaultUnit = useMemo(() => {
    const last = rows.find((r) => r.unit)?.unit;
    return last ?? 'µmol/l';
  }, [rows]);

  function toggleMatrix(m: MethodMatrix) {
    setMatrices((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m],
    );
  }

  function addComponent(drugId: number | undefined, displayName: string) {
    if (drugId == null) return;
    setRows((prev) => {
      if (prev.some((r) => r.drugId === drugId)) return prev;
      return [
        ...prev,
        {
          drugId,
          name: displayName,
          lor: '',
          mkk: '',
          lod: '',
          unit: defaultUnit,
          uncertainty: '',
        },
      ];
    });
  }

  function updateRow(drugId: number, patch: Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => (r.drugId === drugId ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(drugId: number) {
    setRows((prev) => prev.filter((r) => r.drugId !== drugId));
  }

  async function handleSave() {
    if (!code.trim() || !name.trim()) {
      setErrorMsg(t('methods.required'));
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    const payload: MethodInput = {
      code: code.trim(),
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      matrices,
      volumeMl: numOrNull(volume),
      methodType: methodType === '' ? null : methodType,
      components: rows.map((r) => ({
        drugId: r.drugId,
        lor: numOrNull(r.lor),
        mkk: numOrNull(r.mkk),
        lod: numOrNull(r.lod),
        unit: r.unit.trim() ? r.unit.trim() : null,
        measurementUncertainty: numOrNull(r.uncertainty),
      })),
    };
    try {
      const result = isEdit
        ? await updateMethod(methodId as number, payload)
        : await createMethod(payload);
      onSaved(result.method.id);
    } catch (err) {
      setErrorMsg((err as Error).message || t('methods.saveError'));
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      onClose={onClose}
      ariaLabel={heading}
      className="w-full max-w-3xl max-h-[90vh] flex flex-col"
    >
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-base font-semibold">{heading}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t('methods.cancel')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="p-6 text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                {t('methods.code')}
              </span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('methods.codePlaceholder')}
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium">
                {t('methods.name')}
              </span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('methods.namePlaceholder')}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                {t('methods.type')}
              </span>
              <Select
                value={methodType}
                onChange={(e) =>
                  setMethodType(e.target.value as MethodType | '')
                }
                options={[
                  { value: '', label: t('methods.type_unknown') },
                  ...METHOD_TYPES.map((mt) => ({
                    value: mt,
                    label: t(methodTypeLabelKey(mt)),
                  })),
                ]}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                {t('methods.volume')}
              </span>
              <Input
                type="number"
                step="0.1"
                min="0"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                placeholder="ml"
              />
            </label>
          </div>

          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">
              {t('methods.matrices')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {METHOD_MATRICES.map((m) => {
                const active = matrices.includes(m);
                return (
                  <Button
                    key={m}
                    type="button"
                    variant="toggle"
                    size="sm"
                    data-active={active}
                    onClick={() => toggleMatrix(m)}
                    style={
                      active
                        ? {
                            backgroundColor: `${matrixColor(m)}26`,
                            borderColor: matrixColor(m),
                            color: matrixColor(m),
                          }
                        : undefined
                    }
                  >
                    <span
                      aria-hidden
                      className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                      style={{ backgroundColor: matrixColor(m) }}
                    />
                    {t(matrixLabelKey(m))}
                  </Button>
                );
              })}
            </div>
          </fieldset>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              {t('methods.description')}
            </span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t('methods.manageComponents', { count: rows.length })}
              </h3>
            </div>
            <DrugSearchDropdown
              placeholder={t('methods.searchComponent')}
              onSelect={(drug) =>
                addComponent(drug._dbId, resolveDrugName(drug.names, lang))
              }
              className="mb-3"
            />
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('methods.noComponents')}
              </p>
            ) : (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.component')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.lor')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.mkk')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.lod')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.unit')}
                      </th>
                      <th className="px-2 py-1.5 text-left font-medium">
                        {t('methods.uncertainty')}
                      </th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.drugId} className="border-t">
                        <td className="px-2 py-1 font-medium">{r.name}</td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 w-20"
                            value={r.lor}
                            onChange={(e) =>
                              updateRow(r.drugId, { lor: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 w-20"
                            value={r.mkk}
                            onChange={(e) =>
                              updateRow(r.drugId, { mkk: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 w-20"
                            value={r.lod}
                            onChange={(e) =>
                              updateRow(r.drugId, { lod: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 w-24"
                            value={r.unit}
                            onChange={(e) =>
                              updateRow(r.drugId, { unit: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 w-16"
                            value={r.uncertainty}
                            onChange={(e) =>
                              updateRow(r.drugId, {
                                uncertainty: e.target.value,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => removeRow(r.drugId)}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={t('methods.removeComponent')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
        <span className="text-sm text-destructive">{errorMsg}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('methods.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            {t('methods.save')}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
