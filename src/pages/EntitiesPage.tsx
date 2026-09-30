import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dna, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BioEntitySearchDropdown } from '@/components/BioEntitySearchDropdown';
import { useCan } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';
import {
  createBioEntity,
  deleteBioEntity,
  fetchAllBioEntities,
  updateBioEntity,
  type BioEntityInput,
  type BioEntityWriteResult,
} from '@/lib/bioEntitiesApi';
import {
  BIO_ENTITY_FUNCTIONS,
  ENTITY_RANKS,
  type BioEntityFunction,
  type BioEntitySummary,
  type EntityRank,
} from '@/lib/bioEntities';

// Coarse families used to group/filter the catalog. Free text is still allowed
// server-side; these are convenient presets spanning enzyme and target classes.
const ENTITY_CLASSES = [
  'CYP',
  'UGT',
  'SULT',
  'dehydrogenase',
  'oxidase',
  'transferase',
  'esterase',
  'GPCR',
  'LGIC',
  'transporter',
  'kinase',
  'other',
] as const;

interface FormState {
  symbol: string;
  name: string;
  nameEn: string;
  entityClass: string;
  rank: '' | EntityRank;
  functions: BioEntityFunction[];
  parentId: number | null;
  parentLabel: string;
}

const EMPTY_FORM: FormState = {
  symbol: '',
  name: '',
  nameEn: '',
  entityClass: '',
  rank: '',
  functions: [],
  parentId: null,
  parentLabel: '',
};

function entityToForm(
  e: BioEntitySummary,
  byId: Map<number, BioEntitySummary>,
): FormState {
  return {
    symbol: e.symbol,
    name: e.name,
    nameEn: e.nameEn ?? '',
    entityClass: e.entityClass ?? '',
    rank: e.rank ?? '',
    functions: [...e.functions],
    parentId: e.parentId,
    parentLabel:
      e.parentId != null ? (byId.get(e.parentId)?.symbol ?? `#${e.parentId}`) : '',
  };
}

function buildPayload(
  form: FormState,
  t: (key: string) => string,
): { ok: true; data: BioEntityInput } | { ok: false; error: string } {
  const symbol = form.symbol.trim();
  const name = form.name.trim();
  if (!symbol) return { ok: false, error: t('entities.errorSymbolRequired') };
  if (!name) return { ok: false, error: t('entities.errorNameRequired') };
  return {
    ok: true,
    data: {
      symbol,
      name,
      nameEn: form.nameEn.trim() || null,
      entityClass: form.entityClass.trim() || null,
      rank: form.rank || null,
      functions: form.functions,
      parentId: form.parentId,
    },
  };
}

interface RowFormProps {
  form: FormState;
  setForm: (next: FormState) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
  /** Id of the entity being edited, excluded from the parent picker. */
  selfId?: number;
}

function RowForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  selfId,
}: RowFormProps) {
  const { t } = useTranslation();
  function toggleFunction(fn: BioEntityFunction) {
    setForm({
      ...form,
      functions: form.functions.includes(fn)
        ? form.functions.filter((f) => f !== fn)
        : [...form.functions, fn],
    });
  }
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-2 border border-border rounded-lg p-3 bg-muted/20"
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('entities.symbol')}
          <Input
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            placeholder="CYP3A4"
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('entities.nameNb')}
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Cytokrom P450 3A4"
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('entities.nameEn')}
          <Input
            value={form.nameEn}
            onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
            placeholder="Cytochrome P450 3A4"
          />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('entities.class')}
          <input
            list="bio-entity-class-options"
            className="bg-background border border-input rounded px-2 py-1 text-sm h-9"
            value={form.entityClass}
            onChange={(e) => setForm({ ...form, entityClass: e.target.value })}
            placeholder={t('entities.classNone')}
          />
          <datalist id="bio-entity-class-options">
            {ENTITY_CLASSES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          {t('entities.rank')}
          <select
            className="bg-background border border-input rounded px-2 py-1 text-sm h-9"
            value={form.rank}
            onChange={(e) =>
              setForm({ ...form, rank: e.target.value as '' | EntityRank })
            }
          >
            <option value="">{t('entities.rankNone')}</option>
            {ENTITY_RANKS.map((r) => (
              <option key={r} value={r}>
                {t(`bioEntity.ranks.${r}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-3 pt-1">
        <legend className="text-xs text-muted-foreground mb-1 w-full">
          {t('entities.functions')}
        </legend>
        {BIO_ENTITY_FUNCTIONS.map((fn) => (
          <label key={fn} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={form.functions.includes(fn)}
              onChange={() => toggleFunction(fn)}
            />
            {t(`bioEntity.functions.${fn}`)}
          </label>
        ))}
      </fieldset>
      <div className="text-xs text-muted-foreground flex flex-col gap-1">
        {t('entities.parent')}
        {form.parentId != null ? (
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {form.parentLabel || `#${form.parentId}`}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm({ ...form, parentId: null, parentLabel: '' })}
            >
              {t('entities.clearParent')}
            </Button>
          </div>
        ) : (
          <BioEntitySearchDropdown
            excludeIds={selfId != null ? [selfId] : []}
            placeholder={t('entities.parentPlaceholder')}
            onSelect={(entity) =>
              setForm({
                ...form,
                parentId: entity.id,
                parentLabel: entity.symbol,
              })
            }
          />
        )}
      </div>
      <div className="flex gap-2 justify-end">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
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

export function EntitiesPage() {
  const { t } = useTranslation();
  const canEdit = useCan('edit.bioEntity.submit');
  // `isAdmin` here means "writes land directly instead of in the review
  // queue", which is the direct-write capability; deletion is its own.
  const isAdmin = useCan('edit.directWrite');
  const canDelete = useCan('bioEntity.delete');

  const [entities, setEntities] = useState<BioEntitySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setEntities(await fetchAllBioEntities());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('entities.loadError'));
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const byId = useMemo(
    () => new Map(entities.map((e) => [e.id, e])),
    [entities],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter(
      (e) =>
        e.symbol.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (e.nameEn ?? '').toLowerCase().includes(q) ||
        (e.entityClass ?? '').toLowerCase().includes(q),
    );
  }, [entities, filter]);

  // A contributor's write is queued for review; an admin's is applied at once.
  // Surface the difference and only refetch when the catalog actually changed.
  function handleWriteResult(result: BioEntityWriteResult) {
    if (result.pending) {
      showToast(t('entities.submittedForReview'));
    } else {
      showToast(t('entities.saved'));
      void load();
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const built = buildPayload(addForm, t);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      handleWriteResult(await createBioEntity(built.data));
      setAddForm(EMPTY_FORM);
      setShowAdd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('entities.addError'));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(entity: BioEntitySummary) {
    setEditingId(entity.id);
    setEditForm(entityToForm(entity, byId));
    setError('');
  }

  async function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (editingId == null) return;
    const built = buildPayload(editForm, t);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      handleWriteResult(await updateBioEntity(editingId, built.data));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('entities.updateError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(entity: BioEntitySummary) {
    if (
      !window.confirm(t('entities.confirmDelete', { symbol: entity.symbol }))
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await deleteBioEntity(entity.id);
      showToast(t('entities.saved'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('entities.deleteError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Dna className="h-5 w-5 text-primary" />
            {t('entities.title')}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('entities.subtitle')}
          </p>
          {canEdit && !isAdmin && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('entities.reviewNote')}
            </p>
          )}
        </div>
        {canEdit && (
          <Button
            type="button"
            className="shrink-0"
            variant={showAdd ? 'outline' : 'default'}
            onClick={() => {
              setShowAdd((v) => !v);
              setAddForm(EMPTY_FORM);
              setError('');
            }}
          >
            {showAdd ? (
              t('common.cancel')
            ) : (
              <>
                <Plus className="mr-1 h-4 w-4" />
                {t('entities.addEntity')}
              </>
            )}
          </Button>
        )}
      </div>

      <div className="mb-3 max-w-xs">
        <Input
          placeholder={t('entities.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {showAdd && canEdit && (
        <div className="mb-4">
          <RowForm
            form={addForm}
            setForm={setAddForm}
            onSubmit={handleAdd}
            onCancel={() => {
              setShowAdd(false);
              setAddForm(EMPTY_FORM);
            }}
            submitLabel={isAdmin ? t('common.add') : t('entities.submitForReview')}
            busy={busy}
          />
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {!loading && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {entities.length === 0
            ? t('entities.empty')
            : t('entities.noMatches')}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="border border-border rounded-lg divide-y divide-border">
          {visible.map((entity) => (
            <li key={entity.id} className="p-3 text-sm">
              {editingId === entity.id ? (
                <RowForm
                  form={editForm}
                  setForm={setEditForm}
                  onSubmit={handleEditSubmit}
                  onCancel={() => setEditingId(null)}
                  submitLabel={
                    isAdmin ? t('common.save') : t('entities.submitForReview')
                  }
                  busy={busy}
                  selfId={entity.id}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      <Link
                        to={`/wiki/entity/${encodeURIComponent(entity.slug)}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {entity.symbol}
                      </Link>
                      {entity.entityClass && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {entity.entityClass}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {entity.name}
                      {entity.nameEn && entity.nameEn !== entity.name
                        ? ` · ${entity.nameEn}`
                        : ''}
                    </div>
                    {entity.functions.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {entity.functions.map((fn) => (
                          <span
                            key={fn}
                            className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                          >
                            {t(`bioEntity.functions.${fn}`)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {(canEdit || canDelete) && (
                    <div className="flex gap-2">
                      {canEdit && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => startEdit(entity)}
                          disabled={busy}
                        >
                          {t('common.edit')}
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleDelete(entity)}
                          disabled={busy}
                        >
                          {t('common.delete')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
