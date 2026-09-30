import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit2, Flag, History, MessageSquare, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/usePermissions';
import {
  DRUG_PARAMETERS,
  VISIBLE_PARAMETER_IDS,
  getParameterLongLabelKey,
  parameterAcceptsAuthoredValue,
  type DrugParameterId,
} from '@/lib/drugParameters';
import { readDrugMetadataValue } from '@/lib/drugNames';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { fetchDrugByWikiDrugId, type DrugRow } from '@/lib/drugApi';
import {
  fetchDrugIndicators,
  type DrugIndicators,
} from '@/lib/drugIndicatorsApi';
import {
  cancelPriorityFlag,
  fetchPriorityFlags,
  type PriorityFlagRow,
} from '@/lib/parameterPriorityFlagsApi';
import { buildDrugBibliography } from '@/lib/bibliography';
import { ParameterBadges } from './ParameterBadges';
import { ParameterEditForm } from './ParameterEditForm';
import { ParameterFlagDialog } from './ParameterFlagDialog';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import { ParameterDiscussionPanel } from './ParameterDiscussionPanel';
import { useBasketStore } from '@/stores/basketStore';
import { showToast } from '@/lib/toast';

interface Props {
  drugCid: number;
}

type DialogKind = 'edit' | 'history' | 'discussion' | 'flag';

export function DrugParameterHeader({ drugCid }: Props) {
  const { t, i18n } = useTranslation();
  const [drug, setDrug] = useState<DrugRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    kind: DialogKind;
    parameter: DrugParameterId;
  } | null>(null);
  const [indicators, setIndicators] = useState<DrugIndicators>({
    comments: {},
    refs: {},
  });
  const [activeFlags, setActiveFlags] = useState<PriorityFlagRow[]>([]);

  // The edit control opens ParameterEditForm, which posts to
  // /api/drug-parameter — so it follows that endpoint's capability.
  const canEdit = useCan('edit.parameter.submit');
  const canFlag = useCan('parameterFlag.write');
  const addToBasket = useBasketStore((s) => s.addItem);
  const addComparisonParameter = useBasketStore(
    (s) => s.addComparisonParameter,
  );

  const loadFlags = useCallback((drugId: number) => {
    fetchPriorityFlags({ drugId, status: 'active' })
      .then((data) => setActiveFlags(data.flags))
      .catch(() => setActiveFlags([]));
  }, []);

  const loadDrug = useCallback(() => {
    fetchDrugByWikiDrugId(drugCid)
      .then((data) => setDrug(data.drug))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [drugCid]);

  useEffect(() => {
    loadDrug();
  }, [loadDrug]);

  useEffect(() => {
    if (!drug) return;
    fetchDrugIndicators(drug.id)
      .then(setIndicators)
      .catch(() => {});
    loadFlags(drug.id);
  }, [drug, loadFlags]);

  const flagByParameter = new Map<string, PriorityFlagRow>();
  for (const f of activeFlags) {
    if (f.parameter) flagByParameter.set(f.parameter, f);
  }

  async function handleClearFlag(flagId: number, drugId: number) {
    try {
      await cancelPriorityFlag(flagId);
      loadFlags(drugId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {t('drugTable.parametersLoadError', { error })}
      </div>
    );
  }

  if (!drug) {
    return (
      <div className="text-sm text-muted-foreground">{t('drugTable.parametersLoading')}</div>
    );
  }

  const bibliography = buildDrugBibliography(indicators.refs);
  const drugDisplayName =
    formatGenericDrugName(resolveDrugName(drug.names, i18n.language)) ||
    drug.slug;

  return (
    <div className="rounded-lg border border-border bg-card p-4 mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {t('drugTable.pkPdParametersTitle')}
        </h2>
        <span className="text-xs text-muted-foreground">
          {drug.pubchemCid ? `PubChem CID ${drug.pubchemCid}` : null}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {VISIBLE_PARAMETER_IDS.map((pid) => {
          const spec = DRUG_PARAMETERS[pid];
          const value = (drug as unknown as Record<string, unknown>)[pid];
          const formatted = spec.format(value) || '—';
          const paramRefIds = indicators.refs[pid] ?? [];
          const refIndices = paramRefIds
            .map((id) => bibliography.get(id))
            .filter((n): n is number => typeof n === 'number');
          const commentCount = indicators.comments[pid] ?? 0;
          const hasValue = value != null;
          const flag = flagByParameter.get(pid);
          return (
            <div
              key={pid}
              className={`group rounded-md border bg-background p-3 flex flex-col gap-1 ${
                flag
                  ? 'border-amber-500/40 ring-1 ring-amber-500/20'
                  : 'border-border'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs font-semibold uppercase text-muted-foreground"
                  title={t(getParameterLongLabelKey(pid), {
                    defaultValue: spec.longLabel,
                  })}
                >
                  {t(getParameterLongLabelKey(pid), {
                    defaultValue: spec.longLabel,
                  })}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {/* Summarizable parameters are edited through their source
                      values (the sources dialog in the monograph sidebar), not
                      as an authored number — /api/drug-parameter refuses those
                      writes, so the control would only ever produce a 409. */}
                  {canEdit && parameterAcceptsAuthoredValue(pid) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDialog({ kind: 'edit', parameter: pid })
                      }
                      className="h-6 w-6 p-0"
                      title={t('sidebar.editParam')}
                    >
                      <Edit2 className="h-3 w-3" />
                    </Button>
                  )}
                  {canFlag &&
                    (flag ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleClearFlag(flag.id, drug.id)}
                        className="h-6 w-6 p-0 text-amber-600"
                        title={t('review.unflagForAgent')}
                      >
                        <Flag className="h-3 w-3 fill-current" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDialog({ kind: 'flag', parameter: pid })
                        }
                        className="h-6 w-6 p-0"
                        title={t('review.flagForAgent')}
                      >
                        <Flag className="h-3 w-3" />
                      </Button>
                    ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      addToBasket({
                        drugId: drug.id,
                        pubchemCid: drug.pubchemCid,
                        drugName: drugDisplayName,
                      });
                      addComparisonParameter(pid);
                      showToast(
                        t('comparison.addedToast', {
                          drug: drugDisplayName,
                          parameter: t(getParameterLongLabelKey(pid), {
                            defaultValue: spec.longLabel,
                          }),
                        }),
                      );
                    }}
                    className="h-6 w-6 p-0"
                    title={t('sidebar.compareParam')}
                    aria-label={t('sidebar.compareParam')}
                  >
                    <Scale className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDialog({ kind: 'history', parameter: pid })
                    }
                    className="h-6 w-6 p-0"
                    title={t('sidebar.historyParam')}
                  >
                    <History className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDialog({ kind: 'discussion', parameter: pid })
                    }
                    className="h-6 w-6 p-0"
                    title={t('sidebar.discussionParam')}
                  >
                    <MessageSquare className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              {flag ? (
                <div
                  className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
                  title={flag.note ?? undefined}
                >
                  {t('review.flaggedForAgent')}
                </div>
              ) : null}
              <div className="text-sm font-medium">
                <span>{formatted}</span>
                {hasValue ? (
                  <ParameterBadges
                    commentCount={commentCount}
                    refCount={paramRefIds.length}
                    refIndices={refIndices}
                    onCommentClick={() =>
                      setDialog({ kind: 'discussion', parameter: pid })
                    }
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {dialog?.kind === 'edit' && canEdit && (
        <ParameterEditForm
          drugId={drug.id}
          parameter={dialog.parameter}
          currentValue={readDrugMetadataValue(
            drug as unknown as Record<string, unknown>,
            dialog.parameter,
          )}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            loadDrug();
            // A committed value change auto-resolves any priority flag on
            // this parameter server-side; refetch so it disappears here too.
            loadFlags(drug.id);
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <ParameterHistoryDialog
          drugId={drug.id}
          parameter={dialog.parameter}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'discussion' && (
        <ParameterDiscussionPanel
          drugId={drug.id}
          parameter={dialog.parameter}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'flag' && canFlag && (
        <ParameterFlagDialog
          drugId={drug.id}
          parameter={dialog.parameter}
          onClose={() => setDialog(null)}
          onFlagged={() => {
            setDialog(null);
            loadFlags(drug.id);
          }}
        />
      )}
    </div>
  );
}
