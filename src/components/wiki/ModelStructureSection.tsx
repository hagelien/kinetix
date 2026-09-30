import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';
import { ParameterEntryEditor } from '@/components/wiki/ParameterEntryEditor';
import {
  deleteParameterEntry,
  fetchParameterEntries,
  type ParameterEntryRow,
} from '@/lib/parameterEntriesApi';
import { referenceModulePath } from '@/lib/referencesApi';
import {
  DRUG_PARAMETERS,
  getParameterLongLabelKey,
  MODEL_STRUCTURE_PARAMETER_IDS,
  type DrugParameterId,
} from '@/lib/drugParameters';
import { ROUTE_LABEL_KEYS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';

const ROUTE_VALUE_PARAMETERS = ['ka'] as const satisfies readonly DrugParameterId[];

/**
 * The drug's PK model structure (CV-1b): the disposition, elimination and
 * absorption axes the engine composes into a model family. Each axis is declared
 * as one or more cited `parameter_entries` rows — a categorical value, not a
 * number — so this section lists the declarations per axis and, for editors,
 * offers a pick-from-a-list to add one. It deliberately sits apart from the
 * numeric parameter rows and their forest-plot dialog: a shape is asserted with
 * a citation, never pooled.
 */
interface Props {
  drugId: number;
  /** Show add/delete controls (contributor+). */
  canEdit?: boolean;
  /** Admin writes apply directly; contributors submit for review. */
  isAdmin?: boolean;
  /** Reload the parent after a direct write (admins) so derived surfaces refresh. */
  onMutated?: () => void;
}

export function ModelStructureSection({
  drugId,
  canEdit = false,
  isAdmin = false,
  onMutated,
}: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ParameterEntryRow[]>([]);
  const [addingAxis, setAddingAxis] = useState<DrugParameterId | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // A delete that the API rejects (e.g. an already-open mutation on the entry)
  // must not fail silently and leave the same trash control sitting there.
  const [actionFailed, setActionFailed] = useState(false);
  // Monotonic token: the sidebar can be reused across monographs, so an
  // out-of-order response for the SAME drug must not overwrite a newer one.
  const loadTokenRef = useRef(0);
  // The currently-mounted drug. A mutation reload (handleDelete / onSaved) calls
  // the closure's `load()`, which targets the drug that closure was created for;
  // if navigation switched drugs before it resolves, that stale load would grab
  // the newest token and replace the new drug's data. Guarding on the drug the
  // load was issued for — against the drug mounted now — discards it. Updated on
  // every render so it always reflects the live prop.
  const currentDrugIdRef = useRef(drugId);
  currentDrugIdRef.current = drugId;

  const load = useCallback(async () => {
    const token = ++loadTokenRef.current;
    const forDrug = drugId; // the drug THIS load targets
    try {
      const all = await Promise.all(
        [...MODEL_STRUCTURE_PARAMETER_IDS, ...ROUTE_VALUE_PARAMETERS].map((axis) =>
          // Only an editor could have just mutated a declaration, so only they
          // need the uncached (no-store) variant. An anonymous monograph view
          // stays on the CDN-cached endpoint instead of three origin reads.
          fetchParameterEntries(forDrug, { parameter: axis, fresh: canEdit }),
        ),
      );
      // Discard if superseded by a newer load for this drug, or if the mounted
      // drug has changed since this load was issued (a stale cross-drug reload).
      if (token !== loadTokenRef.current || forDrug !== currentDrugIdRef.current)
        return;
      // A transient fetch failure must not read as "no declarations": leave any
      // previously-loaded entries in place and surface an error/retry instead.
      setEntries(all.flat());
      setLoadFailed(false);
    } catch {
      if (token !== loadTokenRef.current || forDrug !== currentDrugIdRef.current)
        return;
      setLoadFailed(true);
    } finally {
      if (token === loadTokenRef.current && forDrug === currentDrugIdRef.current)
        setLoaded(true);
    }
  }, [drugId, canEdit]);

  useEffect(() => {
    // A new drug: drop the previous monograph's declarations up front so its
    // data is never shown under the new drug while the fresh load is in flight,
    // and close any open add form — its editor holds hook state (the citation
    // picked for the previous drug), which must not carry into the new one.
    setEntries([]);
    setLoaded(false);
    setLoadFailed(false);
    setActionFailed(false);
    setAddingAxis(null);
    void load();
  }, [load]);

  async function handleDelete(id: number) {
    // Match the numeric entry list: a direct (admin) delete removes a cited
    // declaration immediately, so confirm first — an accidental click on the
    // small trash control should not silently drop a source.
    if (!window.confirm(t('parameterEntries.editor.confirmDelete'))) return;
    setActionFailed(false);
    try {
      await deleteParameterEntry(id, { submitForReview: !isAdmin });
      await load();
      onMutated?.();
    } catch {
      // e.g. a second delete while a mutation edit is already open (409).
      setActionFailed(true);
    }
  }

  const valueLabel = (value: string) =>
    t(`parameters.modelStructure.value.${value}`, { defaultValue: value });

  // A failed load with no data to fall back on is an error, not an absence —
  // say so (with a retry) rather than showing every axis as "not declared" or,
  // for a reader, hiding the section as if the drug had no model structure.
  if (loadFailed && entries.length === 0) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="model-structure-section"
      >
        <span role="alert">{t('modelStructure.loadError')}</span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2"
          onClick={() => {
            void load();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  // Initial load in flight: show a loading line rather than labeling every axis
  // "not declared" and offering add controls before the existing rows arrive —
  // otherwise a slow request reads as absence and an editor could start a
  // duplicate declaration. (A reload after a mutation keeps `loaded` true and
  // its prior entries, so this only gates the first load per drug.)
  if (!loaded) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="model-structure-section"
      >
        {t('common.loading')}
      </p>
    );
  }

  // Nothing to show and nothing to add: render nothing rather than an empty box.
  if (loaded && entries.length === 0 && !canEdit) return null;

  return (
    // The heading + divider live here, not in the parent, so an empty read-only
    // monograph (the common case — migration 0109 creates no declarations)
    // renders nothing at all rather than a bare bordered "Model structure" box.
    <div
      className="mt-3 border-t border-border pt-3"
      data-testid="model-structure-section"
    >
      <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
        {t('modelStructure.heading')}
      </h4>
      {actionFailed && (
        <p className="mb-2 text-xs text-destructive" role="alert">
          {t('modelStructure.actionError')}
        </p>
      )}
      <dl className="space-y-3 text-sm">
        {MODEL_STRUCTURE_PARAMETER_IDS.map((axis) => {
        const axisEntries = entries.filter((e) => e.parameter === axis);
        return (
          <div key={axis} className="space-y-1">
            <div className="flex items-center justify-between gap-1">
              <dt className="text-muted-foreground text-xs">
                {t(getParameterLongLabelKey(axis), {
                  defaultValue: DRUG_PARAMETERS[axis].longLabel,
                })}
              </dt>
              {canEdit && addingAxis !== axis && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  title={t('modelStructure.declare')}
                  aria-label={t('modelStructure.declare')}
                  onClick={() => setAddingAxis(axis)}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              )}
            </div>

            {axisEntries.length > 0 ? (
              <dd className="flex flex-wrap gap-1.5">
                {axisEntries.map((e) => (
                  <span
                    key={e.id}
                    className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 text-xs"
                  >
                    <span className="font-medium">
                      {valueLabel(e.categoricalValue ?? '')}
                    </span>
                    {e.route && (
                      // Per-route declaration (CV-2c-4): show which administration route it is scoped
                      // to, so a curator sees the route they authored (a route-less one shows nothing).
                      <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                        {ROUTE_LABEL_KEYS[e.route as RouteId]
                          ? t(ROUTE_LABEL_KEYS[e.route as RouteId])
                          : e.route}
                      </span>
                    )}
                    {e.citationId != null && (
                      <a
                        href={referenceModulePath(e.citationId)}
                        className="text-primary hover:underline"
                        title={t('modelStructure.source')}
                      >
                        #{e.citationId}
                      </a>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                        onClick={() => {
                          void handleDelete(e.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </dd>
            ) : (
              <dd className="text-xs text-muted-foreground">
                {t('modelStructure.undeclared')}
              </dd>
            )}

            {/*
              The source's own words behind each declaration. A model-structure
              axis is entry-backed, so it is calculation-driving and high-risk
              for auto-apply exactly like a numeric parameter — and a quote that
              is required to publish a value but invisible once published is
              provenance nobody can audit. It goes BELOW the chip row rather
              than inside a chip: the chips are deliberately compact, and a
              sentence does not belong in one. Each is labelled with the value
              it backs, because an axis can carry several declarations (per
              route) and an unattributed quote would not say which it supports.
            */}
            {axisEntries.some((e) => e.sourceQuote) && (
              <dd className="mt-1 space-y-1">
                {axisEntries
                  .filter((e) => e.sourceQuote)
                  .map((e) => (
                    <p
                      key={e.id}
                      className="border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground"
                    >
                      {/*
                        The value alone does not identify a declaration. An
                        `absorptionModel` axis is per-route (CV-2c-4), so two
                        entries can legitimately share a categorical value and
                        differ only by route — and two papers can back the same
                        route. With quote-less entries filtered out of this
                        list, the reader cannot recover the mapping by counting
                        against the chips either. So the label carries the route
                        where there is one and the citation that backs it, which
                        together pick out exactly one declaration.
                      */}
                      <span className="not-italic font-medium">
                        {valueLabel(e.categoricalValue ?? '')}
                        {e.route
                          ? ` · ${
                              ROUTE_LABEL_KEYS[e.route as RouteId]
                                ? t(ROUTE_LABEL_KEYS[e.route as RouteId])
                                : e.route
                            }`
                          : ''}
                        {e.citationId != null ? ` · #${e.citationId}` : ''}:
                      </span>{' '}
                      {e.sourceQuote}
                    </p>
                  ))}
              </dd>
            )}

            {addingAxis === axis && (
              <ParameterEntryEditor
                drugId={drugId}
                parameter={axis}
                isAdmin={isAdmin}
                onSaved={() => {
                  setAddingAxis(null);
                  void load();
                  onMutated?.();
                }}
                onCancel={() => setAddingAxis(null)}
              />
            )}
          </div>
          );
        })}
      </dl>
      {canEdit && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-1">
            <div>
              <h5 className="text-xs font-medium text-muted-foreground">
                {t('modelStructure.routeValuesHeading')}
              </h5>
              <p className="text-[11px] text-muted-foreground">
                {t('modelStructure.routeValuesHint')}
              </p>
            </div>
            {addingAxis !== 'ka' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                title={t('modelStructure.addRouteValue')}
                aria-label={t('modelStructure.addRouteValue')}
                onClick={() => setAddingAxis('ka')}
              >
                <Plus className="h-3 w-3" />
              </Button>
            )}
          </div>
          {addingAxis === 'ka' && (
            <ParameterEntryEditor
              drugId={drugId}
              parameter="ka"
              isAdmin={isAdmin}
              onSaved={() => {
                setAddingAxis(null);
                void load();
                onMutated?.();
              }}
              onCancel={() => setAddingAxis(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default ModelStructureSection;
