import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BarChartHorizontal,
  ChevronDown,
  ChevronUp,
  Edit2,
  Flag,
  History,
  MessageSquare,
  Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/authStore';
import { useCan, usePermissionOverrides } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';
import {
  DRUG_PARAMETERS,
  PARAMETER_GROUPS,
  getParameterLongLabelKey,
  getParametersInGroup,
  isDrugParameterId,
  isModelStructureParameter,
  parameterAcceptsAuthoredValue,
  parameterIsSummarizable,
  type DrugParameterId,
  type ParameterGroupId,
} from '@/lib/drugParameters';
import { ROUTE_LABEL_KEYS, ROUTE_OPTIONS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';
import { ParameterSourcesDialog } from './ParameterSourcesDialog';
import { ModelStructureSection } from './ModelStructureSection';
import { CmaxSection } from './CmaxSection';
import { readDrugMetadataValue } from '@/lib/drugNames';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { deriveDrugIpmr, IPMR_WIKI_SLUG } from '@/lib/ipmr';
import {
  formatRange,
  representativeValue,
  showFractionAsPercent,
} from '@/lib/rangeUtils';
import { summaryToNumericRange } from '@/lib/parameterEntryAggregation';
import {
  convertConcentrationRange,
  isConcentrationUnit,
  isEthanolDisplayUnit,
  normalizeUnit,
} from '@/lib/unitConversion';
import { isEthanolDrug } from '@/lib/ethanolUnits';
import { DrugUnitScope } from '@/components/ui/DrugUnitScope';
import {
  primaryUnit,
  useAppStore,
  useFractionDisplay,
} from '@/stores/appStore';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import type { NumericRange } from '@/types';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import {
  fetchPendingEdits,
  type PendingEditRow,
} from '@/lib/pendingEditsApi';
import { ParameterEditForm } from './ParameterEditForm';
import {
  type DrugCoverageAreaId,
  getDrugCoverageArea,
} from '@/lib/drugCoverageAreas';
import { MetabolismEditForm } from './MetabolismEditForm';
import { ReceptorTargetEditForm } from './ReceptorTargetEditForm';
import { ParameterFlagDialog } from './ParameterFlagDialog';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import { ParameterDiscussionPanel } from './ParameterDiscussionPanel';
import { ParameterBadges } from './ParameterBadges';
import { fetchParameterVerificationLevels } from '@/lib/verificationLevelsApi';
import type { VerificationLevelInfo } from '@/lib/verificationLevel';
import { buildDrugBibliography } from '@/lib/bibliography';
import type { OrderedReference } from '@/lib/useDrugBibliography';
import { buildSimulatorUrl } from '@/lib/simulatorRouting';
import { buildDrugComponentId } from '@/lib/drugComponentId';
import { useDrugSidebarData } from './useDrugSidebarData';
import { loadJSON, persist } from '@/lib/storage';
import { useBasketStore } from '@/stores/basketStore';
import {
  eliminationRouteEnzymeLabel,
  eliminationRouteKindKey,
  formatFractionRangePercent,
  hasMetabolismData,
  isEnzymeGroupRank,
  type DrugEliminationRoute,
  type DrugMetaboliteLink,
} from '@/lib/metabolism';
import { fetchDrugReferences, type CitationRow } from '@/lib/referencesApi';
import {
  fetchMethodLimitsForDrug,
  type MethodLimitForDrug,
} from '@/lib/drugApi';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { DrugPmConcentrations } from '@/components/wiki/DrugPmConcentrations';
import {
  cancelPriorityFlag,
  fetchPriorityFlags,
  type PriorityFlagRow,
} from '@/lib/parameterPriorityFlagsApi';
import {
  MECHANISM_TIERS,
  type DrugReceptorTargetSummary,
  type MechanismTier,
} from '@/lib/receptorTargets';
import { formatInteractionLabel } from '@/lib/receptorInteractions';

interface DrugMonographSidebarProps {
  drugCid: number;
  /**
   * Page-level citation ordering supplied by the monograph page, where the
   * inline prose footnotes are numbered first (see `useDrugBibliography`).
   * When present, the sidebar numbers its parameter- and mechanism-value
   * `[n]` markers against this shared ordering so they agree with the prose
   * footnotes and the bottom references list — the same source is never
   * numbered twice on one page. Omitted when the sidebar renders standalone
   * (e.g. the drug-preview pane), where it falls back to a self-computed,
   * parameter-first numbering built from its own reference fetch.
   */
  sharedReferences?: OrderedReference[] | null;
  /**
   * Render a single section's contents, without the collapsible box around
   * it. The monograph page uses this to show the box that matches the active
   * tab at the top of the article. Omitted, the component renders every
   * section as an accordion (the standalone drug-preview pane).
   */
  section?: SidebarSectionId;
}

type DialogKind = 'edit' | 'history' | 'discussion' | 'flag' | 'sources';
export type SidebarSectionId = 'metabolism' | ParameterGroupId;

const PARAMETER_GROUP_BY_ID = new Map(PARAMETER_GROUPS.map((g) => [g.id, g]));

/**
 * Column layout for lists of short, independent items (parameter rows,
 * mechanisms, metabolism blocks, method limits) when a section fills the
 * monograph tab: one column on small screens, two from `md`, three from `xl`.
 * Wide content — the postmortem cohort table, Cmax readings, free-text
 * notes — stays full width outside these grids.
 */
const TAB_COLUMNS = 'grid gap-x-8 md:grid-cols-2 xl:grid-cols-3';
const SIDEBAR_SECTION_STORAGE_KEY = 'kinetix.monographSidebar.expandedSection';
const DEFAULT_SECTION: SidebarSectionId = 'chemistry';

function isSidebarSectionId(value: unknown): value is SidebarSectionId {
  return (
    value === 'metabolism' ||
    (typeof value === 'string' &&
      PARAMETER_GROUPS.some((group) => group.id === value))
  );
}

function loadExpandedSection(): SidebarSectionId {
  const stored = loadJSON<unknown>(
    SIDEBAR_SECTION_STORAGE_KEY,
    DEFAULT_SECTION,
  );
  return isSidebarSectionId(stored) ? stored : DEFAULT_SECTION;
}

export function DrugMonographSidebar({
  drugCid,
  sharedReferences,
  section,
}: DrugMonographSidebarProps) {
  const { t, i18n } = useTranslation();
  const {
    drug,
    indicators,
    pendingCounts,
    ownPendingParams,
    pendingEditsByParam,
    reload: loadDrug,
  } = useDrugSidebarData(drugCid);
  const [dialog, setDialog] = useState<{
    kind: DialogKind;
    parameter: DrugParameterId;
    /** Revision (history) or comment (discussion) a deep link points at. */
    focusId?: number;
  } | null>(null);
  // A notification links to `?param=<id>&view=history|discussion` plus the
  // `revision` or `comment` it is about: open that dialog once the drug has
  // loaded, and drop the query again when the reader closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const loadedDrugId = drug?.id;
  const linkParam = searchParams.get('param');
  const linkView = searchParams.get('view');
  const linkFocus = searchParams.get(
    linkView === 'history' ? 'revision' : 'comment',
  );
  useEffect(() => {
    if (loadedDrugId == null) return;
    if (!linkParam || !isDrugParameterId(linkParam)) return;
    if (linkView !== 'history' && linkView !== 'discussion') return;
    const focus = Number(linkFocus);
    setDialog({
      kind: linkView,
      parameter: linkParam,
      focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
    });
  }, [loadedDrugId, linkParam, linkView, linkFocus]);
  const closeLinkedDialog = useCallback(() => {
    setDialog(null);
    if (!searchParams.has('view')) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of ['param', 'view', 'revision', 'comment']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);
  // Coverage-area flagging keeps its own state rather than joining the union
  // above: metabolism and pharmacodynamics are flaggable work targets but have
  // no parameter id, and every other dialog kind here takes a real one.
  const [flagArea, setFlagArea] = useState<DrugCoverageAreaId | null>(null);
  const [reviewingParam, setReviewingParam] = useState<DrugParameterId | null>(
    null,
  );
  const [expandedSection, setExpandedSection] = useState<SidebarSectionId>(() =>
    loadExpandedSection(),
  );
  const [referenceRows, setReferenceRows] = useState<CitationRow[] | null>(
    null,
  );
  const [activeFlags, setActiveFlags] = useState<PriorityFlagRow[]>([]);
  const [verificationLevels, setVerificationLevels] = useState<
    Record<string, VerificationLevelInfo>
  >({});
  const [methodLimits, setMethodLimits] = useState<MethodLimitForDrug[]>([]);
  const [showMetabolismEditor, setShowMetabolismEditor] = useState(false);
  // Bumped after a metabolism save so the completeness panel re-reads the edge
  // set it asks a curator to vouch for.
  const [metabolismPendingEdits, setMetabolismPendingEdits] = useState<
    PendingEditRow[]
  >([]);
  const [reviewingMetabolism, setReviewingMetabolism] = useState(false);
  const [showReceptorEditor, setShowReceptorEditor] = useState(false);
  const [receptorPendingEdits, setReceptorPendingEdits] = useState<
    PendingEditRow[]
  >([]);
  const [reviewingReceptor, setReviewingReceptor] = useState(false);
  const currentDrugIdRef = useRef<number | null>(null);
  const userPrimaryUnit = useAppStore(primaryUnit);
  const ethanolUnit = useAppStore((s) => s.ethanolUnit);
  const fractionDisplay = useFractionDisplay();
  const addToBasket = useBasketStore((s) => s.addItem);
  const addComparisonParameter = useBasketStore(
    (s) => s.addComparisonParameter,
  );
  // When the monograph page hands down its page-level ordering we defer to it
  // entirely — the sidebar must not compute a second, parameter-first numbering
  // that disagrees with the prose footnotes and the bottom references list.
  const usesSharedReferences = sharedReferences !== undefined;
  // Self-computed fallback numbering, used only when no page-level ordering is
  // supplied (e.g. the drug-preview pane). Parameter refs are numbered first,
  // then trailing drug references (mechanism-only citations) are appended,
  // matching how the page-level list numbers trailing citations.
  const localBibliography = useMemo(
    () => buildDrugBibliography(indicators.refs),
    [indicators.refs],
  );
  const localOrdered = useMemo<OrderedReference[] | null>(() => {
    if (!referenceRows) return null;
    const rowsById = new Map(referenceRows.map((row) => [row.id, row]));
    const ordered = [...localBibliography.entries()]
      .map(([id, index]) => {
        const row = rowsById.get(id);
        return row ? { index, row } : null;
      })
      .filter((item): item is OrderedReference => item !== null)
      .sort((a, b) => a.index - b.index);
    const used = new Set(ordered.map((item) => item.row.id));
    let nextIndex = localBibliography.size + 1;
    for (const row of referenceRows) {
      if (used.has(row.id)) continue;
      ordered.push({ index: nextIndex++, row });
      used.add(row.id);
    }
    return ordered;
  }, [localBibliography, referenceRows]);
  // The single ordering the whole box renders against. Prefer the page-level
  // one so a `[3]` on the PPB value points at the very same bibliography entry
  // as `[3]` in the prose and in the bottom references list.
  const ordered = usesSharedReferences ? sharedReferences : localOrdered;
  const referencesById = useMemo(() => {
    const map = new Map<number, CitationRow>();
    for (const item of ordered ?? []) {
      map.set(item.row.id, item.row);
    }
    return map;
  }, [ordered]);
  // Citation number for any drug reference id (parameter-cited or trailing),
  // shared by parameter values and receptor-target mechanisms so a `[n]`
  // marker means the same entry everywhere in the box.
  const refIndexById = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of ordered ?? []) {
      map.set(item.row.id, item.index);
    }
    return map;
  }, [ordered]);
  const activeFlagByParam = useMemo(() => {
    const map = new Map<string, PriorityFlagRow>();
    for (const flag of activeFlags) {
      if (flag.drugId === drug?.id && flag.parameter) {
        map.set(flag.parameter, flag);
      }
    }
    return map;
  }, [activeFlags, drug?.id]);
  const { user } = useAuthStore();
  const canEdit = useCan('edit.parameter.submit');
  const canEditMetabolism = useCan('edit.metabolism.submit');
  const canEditMechanisms = useCan('edit.receptorTarget.submit');
  const canReview = useCan('review.edit.decide');
  const canDirectWrite = useCan('edit.directWrite');
  const canSubmitParameterEntry = useCan('edit.parameterEntry.submit');
  const permissionOverrides = usePermissionOverrides();
  const canFlag = useCan('parameterFlag.write');

  const loadPriorityFlags = useCallback(
    (
      drugId: number,
      isCurrent: () => boolean = () => currentDrugIdRef.current === drugId,
    ) => {
      fetchPriorityFlags({ drugId, status: 'active' })
        .then((data) => {
          if (isCurrent()) setActiveFlags(data.flags);
        })
        .catch(() => {
          if (isCurrent()) setActiveFlags([]);
        });
    },
    [],
  );

  const loadMetabolismPendingEdits = useCallback((drugId: number) => {
    fetchPendingEdits({
      status: 'pending',
      editType: 'metabolism',
      targetId: drugId,
    })
      .then((data) => {
        if (currentDrugIdRef.current === drugId) {
          setMetabolismPendingEdits(data.pendingEdits);
        }
      })
      .catch(() => {
        if (currentDrugIdRef.current === drugId) setMetabolismPendingEdits([]);
      });
  }, []);

  const loadReceptorPendingEdits = useCallback((drugId: number) => {
    fetchPendingEdits({
      status: 'pending',
      editType: 'receptor_targets',
      targetId: drugId,
    })
      .then((data) => {
        if (currentDrugIdRef.current === drugId) {
          setReceptorPendingEdits(data.pendingEdits);
        }
      })
      .catch(() => {
        if (currentDrugIdRef.current === drugId) setReceptorPendingEdits([]);
      });
  }, []);

  useEffect(() => {
    // Only the accordion's own choice is remembered; the monograph's tab
    // selection is persisted separately by the page.
    if (section) return;
    persist(SIDEBAR_SECTION_STORAGE_KEY, expandedSection);
  }, [expandedSection, section]);

  useEffect(() => {
    // Skip the self-fetch when the parent supplies the numbering: its ordering
    // already carries every row we render, so this request would be redundant.
    if (usesSharedReferences || !drug?.id) {
      setReferenceRows(null);
      return;
    }
    let cancelled = false;
    setReferenceRows(null);
    fetchDrugReferences(drug.id)
      .then((rows) => {
        if (!cancelled) setReferenceRows(rows);
      })
      .catch(() => {
        if (!cancelled) setReferenceRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [drug?.id, usesSharedReferences]);

  // The matrix can arrive after the user does (checkAuth loads both), so this
  // must re-run when it lands — otherwise a user granted methods.read by
  // capability rather than by group clears the limits once and never refetches.
  const canReadMethods = canAccessAnalyticalMethods(user, permissionOverrides);

  useEffect(() => {
    if (!drug?.id || !canReadMethods) {
      setMethodLimits([]);
      return;
    }
    let cancelled = false;
    setMethodLimits([]);
    fetchMethodLimitsForDrug(drug.id)
      .then(({ methods }) => {
        if (!cancelled) setMethodLimits(methods);
      })
      .catch(() => {
        if (!cancelled) setMethodLimits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [drug?.id, canReadMethods]);

  useEffect(() => {
    if (!drug?.id) {
      setVerificationLevels({});
      return;
    }
    let cancelled = false;
    setVerificationLevels({});
    fetchParameterVerificationLevels(drug.id)
      .then((levels) => {
        if (!cancelled) setVerificationLevels(levels);
      })
      .catch(() => {
        if (!cancelled) setVerificationLevels({});
      });
    return () => {
      cancelled = true;
    };
  }, [drug?.id]);

  useEffect(() => {
    currentDrugIdRef.current = drug?.id ?? null;
    if (!drug?.id || !canFlag) {
      setActiveFlags([]);
      return;
    }
    const drugId = drug.id;
    let cancelled = false;
    setActiveFlags([]);
    loadPriorityFlags(drugId, () => !cancelled && drug?.id === drugId);
    return () => {
      cancelled = true;
    };
  }, [canFlag, drug?.id, loadPriorityFlags]);

  useEffect(() => {
    if (!drug?.id || !user || !(canEditMetabolism || canEditMechanisms)) {
      setMetabolismPendingEdits([]);
      setReceptorPendingEdits([]);
      return;
    }
    currentDrugIdRef.current = drug.id;
    loadMetabolismPendingEdits(drug.id);
    loadReceptorPendingEdits(drug.id);
    // The capability booleans belong here too: the matrix can arrive after the
    // user, so without them a newly-eligible viewer never fetches these and a
    // viewer who just lost the capability keeps a stale pending banner.
  }, [
    drug?.id,
    user,
    canEditMetabolism,
    canEditMechanisms,
    loadMetabolismPendingEdits,
    loadReceptorPendingEdits,
  ]);

  if (!drug) return null;
  // Capture the post-guard non-null reference so closures below don't have
  // to re-narrow the union (TypeScript can't track the early-return
  // through `renderParameterRow`).
  const drugRow = drug;
  // Ethanol is shown in the reader's ethanol unit (‰ by default), every other
  // drug in their primary unit. The scope below hands the same choice to the
  // tooltips and source dialogs rendered inside the sidebar.
  const isEthanol = isEthanolDrug(drugRow);
  const displayPrimaryUnit = isEthanol ? ethanolUnit : userPrimaryUnit;
  const drugDisplayName =
    formatGenericDrugName(resolveDrugName(drugRow.names, i18n.language)) ||
    drugRow.slug;

  async function handleClearFlag(flagId: number) {
    try {
      await cancelPriorityFlag(flagId);
      loadPriorityFlags(drugRow.id);
    } catch {
      showToast(t('review.flagUpdateFailed'));
    }
  }

  /**
   * The flag toggle for a whole coverage area — the section-level counterpart
   * of the per-parameter one in `renderParameterRow`. Metabolism and
   * pharmacodynamics are the two parts of a monograph with no parameter row to
   * hang a flag on, which is exactly why they were the two nobody could put in
   * front of the agents.
   */
  function renderCoverageFlagButton(areaId: DrugCoverageAreaId) {
    if (!canFlag) return null;
    const area = getDrugCoverageArea(areaId);
    const label = t(area?.i18nKey ?? areaId, { defaultValue: areaId });
    const activeFlag = activeFlagByParam.get(areaId);
    // Hover-revealed like every other section action; the flagged STATE stays
    // visible through the notice below, the way a parameter row carries it.
    const className =
      'hover-actions h-6 gap-1 px-1.5 text-xs opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none';
    return activeFlag ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleClearFlag(activeFlag.id)}
        className={`${className} text-amber-600`}
        title={t('review.unflagAreaForAgent', { area: label })}
        aria-label={t('review.unflagAreaForAgent', { area: label })}
      >
        <Flag className="h-3 w-3 fill-current" />
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setFlagArea(areaId)}
        className={`${className} text-muted-foreground`}
        title={t('review.flagAreaForAgent', { area: label })}
        aria-label={t('review.flagAreaForAgent', { area: label })}
      >
        <Flag className="h-3 w-3" />
      </Button>
    );
  }

  /** The persistent "this is queued for an agent" line, as parameter rows show. */
  function renderCoverageFlagNotice(areaId: DrugCoverageAreaId) {
    const activeFlag = activeFlagByParam.get(areaId);
    if (!canFlag || !activeFlag) return null;
    return (
      <div
        className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
        title={activeFlag.note ?? undefined}
      >
        {t('review.flaggedForAgent')}
      </div>
    );
  }

  function renderParameterRow(pid: DrugParameterId) {
    const spec = DRUG_PARAMETERS[pid];
    const rawValue = readDrugMetadataValue(
      drug as unknown as Record<string, unknown>,
      pid,
    );
    // Concentration-kind range params (#397): re-express the stored value
    // in the user's primary unit before formatting and wrap the result in
    // UnitTooltip so hover surfaces the rest of the user's enabled units.
    // Falls back to the original range when the source unit isn't a
    // recognised concentration unit or when a cross-kind conversion can't
    // be performed (e.g. missing molecularWeight).
    const isRangeKind =
      spec.kind === 'range' ||
      spec.kind === 'fraction' ||
      spec.kind === 'ratio' ||
      spec.kind === 'scalar' ||
      spec.kind === 'struct';
    const isConcentrationParam =
      spec.kind === 'range' &&
      isConcentrationUnit(normalizeUnit(spec.canonicalUnit));
    let displayRange: NumericRange | null | undefined = isRangeKind
      ? (rawValue as NumericRange | null | undefined)
      : null;
    if (isConcentrationParam && displayRange) {
      const converted = convertConcentrationRange(
        displayRange,
        displayPrimaryUnit,
        drugRow.molecularWeight ?? null,
      );
      if (converted) displayRange = converted;
    }
    // The tooltip converts FROM a catalog unit, which ‰ and % are not: when the
    // figure on screen is in one of those, the tooltip works from the stored
    // range instead (and lists its authored unit first).
    const tooltipRange: NumericRange | null | undefined =
      displayRange?.unit && isEthanolDisplayUnit(displayRange.unit)
        ? (rawValue as NumericRange)
        : displayRange;
    // A fraction parameter (F, plasma protein binding) follows the user's
    // decimal-vs-percent preference; every other kind formats as before.
    const asPercent = showFractionAsPercent(spec.kind, fractionDisplay);
    const formatted =
      (isRangeKind
        ? formatRange(displayRange, { showNote: false, asPercent })
        : spec.format(rawValue)) || '—';
    const value = rawValue;

    const paramRefIds = indicators.refs[pid] ?? [];
    // Resolve index and row from the one shared ordering so a parameter's
    // `[n]` marker matches the prose footnotes and the bottom references list
    // (same approach as receptor-target mechanisms below).
    const refItems = paramRefIds
      .map((id) => {
        const index = refIndexById.get(id);
        const row = referencesById.get(id);
        return index !== undefined && row ? { index, row } : null;
      })
      .filter(
        (item): item is { index: number; row: CitationRow } => item !== null,
      );
    const refIndices = refItems.map((item) => item.index);
    const commentCount = indicators.comments[pid] ?? 0;
    const hasValue = value != null;
    const activeFlag = activeFlagByParam.get(pid);
    // The pooled aggregate, when this parameter is entry-backed. Its presence
    // decides whether the sources action reads "N source values" (open the plot)
    // or "Add source values" (contributor seeding the first one).
    const summary = drugRow.parameterSummaries?.[pid];
    // Per-route pools (CV-2c-4). A route-scoped F/Tmax never enters the drug-level aggregate, so
    // once a curator moves a drug's only entries onto a route the field above goes empty — these
    // are what it falls back to, labelled with the route rather than pretending to be the drug's
    // own figure.
    const routeSummaryEntries = Object.entries(
      drugRow.parameterRouteSummaries?.[pid] ?? {},
    ).sort(([a], [b]) => ROUTE_OPTIONS.indexOf(a as RouteId) - ROUTE_OPTIONS.indexOf(b as RouteId));
    const totalEntryCount =
      (summary?.entryCount ?? 0) +
      routeSummaryEntries.reduce((n, [, rs]) => n + rs.entryCount, 0);
    const sourcesActionLabel = totalEntryCount
      ? t('parameterEntries.sources', { count: totalEntryCount })
      : t('parameterEntries.addSources');
    // A source-value parameter's figure is the pooled aggregate of its source
    // values, so the figure itself opens the sources dialog (the same one as
    // the hover action) instead of trailing `[n]` markers: the per-source
    // citations are listed there, next to the values they back.
    const opensSources =
      parameterIsSummarizable(pid) &&
      Boolean(summary || routeSummaryEntries.length > 0 || canSubmitParameterEntry);
    const openSources = () => setDialog({ kind: 'sources', parameter: pid });

    const renderValueContent = (nested: boolean) => (
      <>
        {!hasValue && routeSummaryEntries.length > 0 ? null : isConcentrationParam &&
          displayRange &&
          tooltipRange ? (
          <UnitTooltip
            value={representativeValue(tooltipRange)}
            low={
              typeof tooltipRange.min === 'number' ? tooltipRange.min : null
            }
            high={
              typeof tooltipRange.max === 'number' ? tooltipRange.max : null
            }
            unit={displayRange.unit}
            sourceUnit={tooltipRange.unit}
            molecularWeight={drugRow.molecularWeight ?? null}
            focusable={!nested}
          >
            {formatted}
          </UnitTooltip>
        ) : (
          <span>{formatted}</span>
        )}
        {!hasValue && routeSummaryEntries.length > 0 ? (
          <span className="space-y-0.5">
            {routeSummaryEntries.map(([route, rs]) => (
              <span key={route} className="block text-xs">
                <span className="mr-1 font-normal text-muted-foreground">
                  {t(ROUTE_LABEL_KEYS[route as RouteId] ?? route, {
                    defaultValue: route,
                  })}
                </span>
                {/* Formatted through the SAME summary→range conversion the drug-level cache
                    is built with, so a route line reads exactly as the drug-level one would:
                    the pooled span, not a bare weighted median that would imply a point
                    estimate where the sources report an interval. */}
                {formatRange(summaryToNumericRange(rs), {
                  showNote: false,
                  asPercent,
                }) || '—'}
              </span>
            ))}
          </span>
        ) : null}
      </>
    );

    return (
      <div key={pid} className="group">
        <div className="flex items-center justify-between gap-1">
          <dt className="text-muted-foreground text-xs">
            {/* Translation is keyed on parameter id; fall back to the
                hardcoded English longLabel if a translation is missing
                so newly-added parameters degrade gracefully. */}
            {t(getParameterLongLabelKey(pid), { defaultValue: spec.longLabel })}
          </dt>
          <div
            className="hover-actions flex items-center gap-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
            data-testid={`parameter-actions-${pid}`}
          >
            {/* A summarizable parameter has no authored value to edit: what it
                displays is the aggregate of its source values, and the direct
                editor is refused by the API (409). The action next to it — the
                forest plot + per-source list — is where such a value is
                curated, whether or not it has sources yet. */}
            {canEdit && parameterAcceptsAuthoredValue(pid) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDialog({ kind: 'edit', parameter: pid })}
                className="h-5 w-5 p-0"
                title={t('sidebar.editParam')}
              >
                <Edit2 className="h-3 w-3" />
              </Button>
            )}
            {canFlag &&
              (activeFlag ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleClearFlag(activeFlag.id)}
                  className="h-5 w-5 p-0 text-amber-600"
                  title={t('review.unflagForAgent')}
                  aria-label={t('review.unflagForAgent')}
                >
                  <Flag className="h-3 w-3 fill-current" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ kind: 'flag', parameter: pid })}
                  className="h-5 w-5 p-0"
                  title={t('review.flagForAgent')}
                  aria-label={t('review.flagForAgent')}
                >
                  <Flag className="h-3 w-3" />
                </Button>
              ))}
            {/* Source values used to hang under every summarizable parameter
                as an always-visible "Add source values" expander, which shouted
                over the values themselves. It's an action like the others now:
                hover-revealed, opening the forest plot + per-source list in a
                dialog with room to compare them. */}
            {opensSources ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={openSources}
                className="h-5 w-5 p-0"
                title={sourcesActionLabel}
                aria-label={sourcesActionLabel}
              >
                <BarChartHorizontal className="h-3 w-3" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                addToBasket({
                  drugId: drugRow.id,
                  pubchemCid: drugRow.pubchemCid,
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
              className="h-5 w-5 p-0"
              title={t('sidebar.compareParam')}
              aria-label={t('sidebar.compareParam')}
            >
              <Scale className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialog({ kind: 'history', parameter: pid })}
              className="h-5 w-5 p-0"
              title={t('sidebar.historyParam')}
            >
              <History className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialog({ kind: 'discussion', parameter: pid })}
              className="h-5 w-5 p-0"
              title={t('sidebar.discussionParam')}
            >
              <MessageSquare className="h-3 w-3" />
            </Button>
          </div>
        </div>
        {activeFlag ? (
          <div
            className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
            title={activeFlag.note ?? undefined}
          >
            {t('review.flaggedForAgent')}
          </div>
        ) : null}
        <dd className="font-medium">
          {/* Prefix the value with the parameter's conventional symbol
              (e.g. t½, Vd, B/P) so a glance at the number tells you which
              quantity it is. Only shown when a value exists — a lone "—"
              reads better without a dangling symbol. */}
          {spec.symbol && hasValue ? (
            <span className="mr-1 font-normal text-muted-foreground">
              {spec.symbol}
            </span>
          ) : null}
          {opensSources && (hasValue || routeSummaryEntries.length > 0) ? (
            <button
              type="button"
              onClick={openSources}
              className="cursor-pointer text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
              title={sourcesActionLabel}
              data-testid={`parameter-value-sources-${pid}`}
            >
              {renderValueContent(true)}
            </button>
          ) : (
            renderValueContent(false)
          )}
          {hasValue ? (
            <ParameterBadges
              commentCount={commentCount}
              refCount={paramRefIds.length}
              refIndices={opensSources ? undefined : refIndices}
              references={opensSources ? undefined : refItems}
              onCommentClick={() =>
                setDialog({ kind: 'discussion', parameter: pid })
              }
            />
          ) : null}
        </dd>
        {pendingCounts[pid] ? (
          canReview ? (
            <button
              type="button"
              className="ml-1 text-[10px] text-accent hover:underline"
              onClick={() =>
                setReviewingParam((current) => (current === pid ? null : pid))
              }
            >
              {ownPendingParams.has(pid)
                ? t('sidebar.yourSuggestion')
                : t('sidebar.pendingCount', { count: pendingCounts[pid] })}
            </button>
          ) : (
            <span className="ml-1 text-[10px] text-accent">
              {ownPendingParams.has(pid)
                ? t('sidebar.yourSuggestion')
                : t('sidebar.pendingCount', { count: pendingCounts[pid] })}
            </span>
          )
        ) : null}
        {canReview &&
        reviewingParam === pid &&
        (pendingEditsByParam[pid]?.length ?? 0) > 0 ? (
          <div className="mt-2 space-y-2 rounded-md border border-accent/30 bg-accent/10 p-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-accent">
                {t('sidebar.pendingReview')}
              </span>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setReviewingParam(null)}
              >
                {t('sidebar.close')}
              </button>
            </div>
            {pendingEditsByParam[pid]?.map((edit) => (
              <PendingEditCard
                key={edit.id}
                edit={edit}
                onReviewed={() => {
                  setReviewingParam(null);
                  loadDrug();
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderDerivedIpmrRow() {
    const result = deriveDrugIpmr(
      drugRow as unknown as Record<string, unknown>,
    );
    const longLabel = t('parameters.ipmr.longLabel');
    const formatted = result
      ? t('parameters.ipmr.score', { score: result.score })
      : '—';
    const bandLabel = result
      ? t(`parameters.ipmr.bands.${result.band}`)
      : null;
    return (
      <div className="group" data-testid="parameter-derived-ipmr">
        <div className="flex items-center justify-between gap-1">
          <dt className="text-muted-foreground text-xs" title={t('parameters.ipmr.description')}>
            <Link
              to={`/wiki/${IPMR_WIKI_SLUG}`}
              className="hover:text-foreground hover:underline"
            >
              {longLabel}
            </Link>
          </dt>
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('parameters.ipmr.derived')}
          </span>
        </div>
        <dd className="font-medium">
          <span>{formatted}</span>
          {bandLabel ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              · {bandLabel}
            </span>
          ) : null}
        </dd>
      </div>
    );
  }

  // Read-only "Fra metoder" rows for the analytics-and-detection section: the
  // Påvisn. limit (`lor`) the drug carries in each analytical method it
  // belongs to.
  // The sheet's other two columns stay on the method detail page (MKK is blank
  // for most methods). All three are the laboratory's limit-type names, which
  // tell limits apart without defining them (#1058), so none is labelled as an
  // LOD, LOQ or LLOQ.
  // These mirror the method sheets, and since the drug-level `loq`/`lod`
  // parameters were retired they are the ONLY place the monograph states an
  // analytical limit — which is the point: a limit belongs to a validated
  // method in a lab, so it is shown per method, sourced from that method's own
  // sheet, and never as a property of the substance. The labels are shared with
  // the method detail table so one vocabulary covers both surfaces.
  function renderMethodLimitsRows() {
    if (methodLimits.length === 0) return null;
    // Wrap each figure in UnitTooltip so hovering surfaces the value in the
    // user's other enabled units. Falls back to plain text (an em dash) when
    // the value is absent.
    const renderFigure = (value: number | null, unit: string | null) => {
      if (value == null) return <>—</>;
      const label = `${value}${unit ? ` ${unit}` : ''}`;
      return (
        <UnitTooltip
          value={value}
          unit={unit}
          molecularWeight={drugRow.molecularWeight ?? null}
        >
          {label}
        </UnitTooltip>
      );
    };
    return (
      <div
        className="mt-2 border-t border-border/60 pt-2"
        data-testid="method-derived-limits"
      >
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('sidebar.methodLimitsTitle')}
        </div>
        <ul
          className={
            section ? `${TAB_COLUMNS} gap-y-1 text-xs` : 'space-y-1 text-xs'
          }
        >
          {methodLimits.map((method) => (
            <li
              key={method.id}
              className="flex items-baseline justify-between gap-2"
            >
              <Link
                to={`/methods/${method.id}`}
                className="font-medium hover:text-primary hover:underline"
                title={method.name}
              >
                {method.code}
              </Link>
              <span className="text-muted-foreground tabular-nums">
                <span title={t('methods.lorFull')}>{t('methods.lor')}</span>{' '}
                {renderFigure(method.lor, method.unit)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function renderMetaboliteLink(link: DrugMetaboliteLink) {
    const activity =
      link.activity === 'active'
        ? t('sidebar.metabolismActive')
        : link.activity === 'inactive'
          ? t('sidebar.metabolismInactive')
          : t('sidebar.metabolismUnknownActivity');
    const resolvedName = link.drug
      ? formatGenericDrugName(resolveDrugName(link.drug.names, i18n.language))
      : '';
    const label = resolvedName || link.metaboliteName;
    const conversion = formatFractionRangePercent(link.conversionFraction);
    const content = (
      <>
        <span>{label}</span>
        <span className="text-muted-foreground">
          {conversion ? ` ${conversion}` : ''} · {activity}
        </span>
      </>
    );

    return (
      <li key={link.id}>
        {link.drug ? (
          <Link to={`/wiki/drug/${link.drug.id}`} className="hover:underline">
            {content}
          </Link>
        ) : (
          // The named metabolite/precursor has no monograph in the
          // database yet. Keep it clickable so it leads to the
          // new-monograph flow with its name pre-filled, rather than
          // dead-ending on plain text.
          <Link
            to={`/wiki/new?type=drug_monograph&q=${encodeURIComponent(label)}`}
            className="hover:underline"
            title={t('sidebar.metabolismCreateMonograph', { name: label })}
          >
            {content}
          </Link>
        )}
      </li>
    );
  }

  function renderMetabolismEditorControls() {
    const ownPending = metabolismPendingEdits.filter(
      (edit) => edit.submittedBy === user?.id,
    );
    return (
      <div className="space-y-2">
        {canEditMetabolism || canFlag ? (
          <div className="flex items-center justify-end gap-1">
            {canEditMetabolism ? (
              <Button
                variant="ghost"
                size="sm"
                className="hover-actions h-6 gap-1 px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                onClick={() => setShowMetabolismEditor(true)}
              >
                <Edit2 className="h-3 w-3" />
                {hasMetabolismData(drugRow.metabolism)
                  ? t('sidebar.metabolismEdit')
                  : t('sidebar.metabolismAdd')}
              </Button>
            ) : null}
            {renderCoverageFlagButton('metabolism')}
          </div>
        ) : null}
        {renderCoverageFlagNotice('metabolism')}
        {metabolismPendingEdits.length > 0 ? (
          canReview ? (
            <button
              type="button"
              className="text-[11px] text-accent hover:underline"
              onClick={() => setReviewingMetabolism((v) => !v)}
            >
              {t('sidebar.metabolismPendingCount', {
                count: metabolismPendingEdits.length,
              })}
            </button>
          ) : ownPending.length > 0 ? (
            <span className="text-[11px] text-accent">
              {t('sidebar.metabolismYourSuggestion')}
            </span>
          ) : null
        ) : null}
        {canReview && reviewingMetabolism ? (
          <div className="space-y-2 rounded-md border border-accent/30 bg-accent/10 p-2">
            {metabolismPendingEdits.map((edit) => (
              <PendingEditCard
                key={edit.id}
                edit={edit}
                onReviewed={() => {
                  setReviewingMetabolism(false);
                  loadDrug();
                  if (drug?.id) loadMetabolismPendingEdits(drug.id);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderMetabolismSection() {
    const metabolism = drugRow.metabolism;
    if (!hasMetabolismData(metabolism)) {
      return (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">{t('sidebar.metabolismEmpty')}</p>
          {renderMetabolismEditorControls()}
        </div>
      );
    }

    const routeLabel = (route: DrugEliminationRoute): string => {
      if (route.kind === 'enzyme') {
        const name =
          eliminationRouteEnzymeLabel(route, i18n.language) ||
          t('metabolismRoute.enzyme');
        // Flag family/subfamily/superfamily picks so a group-level annotation
        // (gene unknown) reads distinctly from a specific enzyme.
        const rank = route.enzyme?.rank;
        return isEnzymeGroupRank(rank) && rank
          ? `${name} (${t(`enzymeRank.${rank}`)})`
          : name;
      }
      const base = t(`metabolismRoute.${eliminationRouteKindKey(route.kind)}`);
      return route.label ? `${base} (${route.label})` : base;
    };

    return (
      <div className="space-y-3 text-xs">
        {renderMetabolismEditorControls()}
        {/* Routes, metabolites and precursors are short lists that sit side
            by side on a wide tab; the evidence note below spans the width. */}
        {metabolism?.routes.length ||
        metabolism?.metabolites.length ||
        metabolism?.precursors.length ? (
        <div className={section ? `${TAB_COLUMNS} gap-y-3` : 'space-y-3'}>
          {metabolism?.routes.length ? (
            <div>
              <h4 className="mb-1 font-medium">{t('sidebar.metabolismRoutes')}</h4>
              <dl className="space-y-1">
                {metabolism.routes.map((route) => (
                  <div key={route.id} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">
                      {/* A route resolved to the bio-entity catalog links to that
                          entity's page, where the reverse view lists every drug
                          routed through it. Free-text routes stay plain. */}
                      {route.enzyme?.slug ? (
                        <Link
                          to={`/wiki/entity/${encodeURIComponent(route.enzyme.slug)}`}
                          className="hover:text-foreground hover:underline"
                        >
                          {routeLabel(route)}
                        </Link>
                      ) : (
                        routeLabel(route)
                      )}
                    </dt>
                    <dd className="font-medium">
                      {formatFractionRangePercent(route.fraction) ?? ''}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {metabolism?.metabolites.length ? (
            <div>
              <h4 className="mb-1 font-medium">
                {t('sidebar.metabolismMetabolites')}
              </h4>
              <ul className="space-y-1 text-muted-foreground">
                {metabolism.metabolites.map(renderMetaboliteLink)}
              </ul>
            </div>
          ) : null}

          {metabolism?.precursors.length ? (
            <div>
              <h4 className="mb-1 font-medium">
                {t('sidebar.metabolismPrecursors')}
              </h4>
              <ul className="space-y-1 text-muted-foreground">
                {metabolism.precursors.map(renderMetaboliteLink)}
              </ul>
            </div>
          ) : null}
        </div>
        ) : null}

        {metabolism?.evidenceNote ? (
          <div>
            <h4 className="mb-1 font-medium">{t('sidebar.metabolismNote')}</h4>
            <p className="text-muted-foreground">{metabolism.evidenceNote}</p>
          </div>
        ) : null}
      </div>
    );
  }

  function renderReceptorTargetMetric(
    target: DrugReceptorTargetSummary,
    key: keyof Pick<
      DrugReceptorTargetSummary,
      | 'affinity'
      | 'potency'
      | 'efficacy'
      | 'ki'
      | 'ic50'
      | 'ec50'
      | 'emax'
      | 'selectivityRatio'
    >,
    label: string,
  ) {
    const value = target[key];
    const formatted = value ? formatRange(value, { showNote: false }) : '';
    return formatted ? `${label} ${formatted}` : null;
  }

  function renderMechanismEntry(target: DrugReceptorTargetSummary) {
    const targetName =
      i18n.language.startsWith('en') && target.target.nameEn
        ? target.target.nameEn
        : target.target.name;
    // "<interaction> at <SYMBOL>", e.g. "full agonist at MOR" — leads with the
    // action so the mechanism reads as a sentence fragment.
    const phrase = `${formatInteractionLabel(target.interactionType, t)} ${t(
      'sidebar.mechanismAt',
    )} ${target.target.symbol}`;
    // Per-target measurements use their conventional, language-neutral
    // notation. The drug-level Ki/IC50/EC50/Emax/selectivity parameters were
    // retired; the same quantities live here, on the mechanism itself.
    const metrics = [
      renderReceptorTargetMetric(target, 'affinity', t('sidebar.receptorAffinity')),
      renderReceptorTargetMetric(target, 'potency', t('sidebar.receptorPotency')),
      renderReceptorTargetMetric(target, 'efficacy', t('sidebar.receptorEfficacy')),
      renderReceptorTargetMetric(target, 'ki', 'Ki'),
      renderReceptorTargetMetric(target, 'ic50', 'IC50'),
      renderReceptorTargetMetric(target, 'ec50', 'EC50'),
      renderReceptorTargetMetric(target, 'emax', 'Emax'),
      renderReceptorTargetMetric(target, 'selectivityRatio', 'Selectivity'),
      // The species the numbers were measured in qualifies every metric on the
      // row, so it rides the same line (#1017). Absent means unstated — the
      // catalog target is human-canonical, but silence is not a human claim.
      target.assaySpecies
        ? `${t('sidebar.assaySpecies')} ${target.assaySpecies}`
        : null,
    ].filter((metric): metric is string => metric !== null);
    // Render citations exactly like parameter values do (compacted, linked
    // [n] markers with hover tooltips into the shared bibliography), via the
    // same ParameterBadges component.
    const refItems = target.referenceIds
      .map((id) => {
        const index = refIndexById.get(id);
        const row = referencesById.get(id);
        return index !== undefined && row ? { index, row } : null;
      })
      .filter(
        (item): item is { index: number; row: CitationRow } => item !== null,
      );
    const refIndices = refItems.map((item) => item.index);

    return (
      <li key={target.id} className="space-y-0.5">
        <div className="font-medium">
          {phrase}
          {refIndices.length > 0 ? (
            <span className="ml-0.5 align-middle">
              <ParameterBadges
                refCount={target.referenceIds.length}
                refIndices={refIndices}
                references={refItems}
                showRefWarning={false}
              />
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground">{targetName}</div>
        {metrics.length > 0 ? (
          <div className="text-muted-foreground">{metrics.join(' · ')}</div>
        ) : null}
      </li>
    );
  }

  function mechanismTierLabel(tier: MechanismTier | 'other'): string {
    switch (tier) {
      case 'primary':
        return t('sidebar.mechanismPrimary');
      case 'secondary':
        return t('sidebar.mechanismSecondary');
      case 'tertiary':
        return t('sidebar.mechanismTertiary');
      default:
        return t('sidebar.mechanismOther');
    }
  }

  function renderMechanismEditorControls() {
    const ownPending = receptorPendingEdits.filter(
      (edit) => edit.submittedBy === user?.id,
    );
    return (
      <div className="space-y-2">
        {canEditMechanisms || canFlag ? (
          <div className="flex items-center justify-end gap-1">
            {canEditMechanisms ? (
              <Button
                variant="ghost"
                size="sm"
                className="hover-actions h-6 gap-1 px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                onClick={() => setShowReceptorEditor(true)}
              >
                <Edit2 className="h-3 w-3" />
                {(drugRow.receptorTargets ?? []).length > 0
                  ? t('sidebar.mechanismsEdit')
                  : t('sidebar.mechanismsAdd')}
              </Button>
            ) : null}
            {renderCoverageFlagButton('pharmacodynamics')}
          </div>
        ) : null}
        {renderCoverageFlagNotice('pharmacodynamics')}
        {receptorPendingEdits.length > 0 ? (
          canReview ? (
            <button
              type="button"
              className="text-[11px] text-accent hover:underline"
              onClick={() => setReviewingReceptor((v) => !v)}
            >
              {t('sidebar.mechanismsPendingCount', {
                count: receptorPendingEdits.length,
              })}
            </button>
          ) : ownPending.length > 0 ? (
            <span className="text-[11px] text-accent">
              {t('sidebar.mechanismsYourSuggestion')}
            </span>
          ) : null
        ) : null}
        {canReview && reviewingReceptor ? (
          <div className="space-y-2 rounded-md border border-accent/30 bg-accent/10 p-2">
            {receptorPendingEdits.map((edit) => (
              <PendingEditCard
                key={edit.id}
                edit={edit}
                onReviewed={() => {
                  setReviewingReceptor(false);
                  loadDrug();
                  if (drug?.id) loadReceptorPendingEdits(drug.id);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // The pharmacodynamics box presents the drug's receptor-target mechanisms
  // grouped by tier — Primary / Secondary / Tertiary mechanism(s) — with any
  // unranked mechanisms gathered under "Other".
  function renderMechanismsSection() {
    const targets = drugRow.receptorTargets ?? [];
    if (targets.length === 0) {
      return (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">{t('sidebar.mechanismsEmpty')}</p>
          {renderMechanismEditorControls()}
        </div>
      );
    }

    const tierOrder: Array<MechanismTier | 'other'> = [
      ...MECHANISM_TIERS,
      'other',
    ];
    const byTier = new Map<MechanismTier | 'other', DrugReceptorTargetSummary[]>(
      tierOrder.map((tier) => [tier, []]),
    );
    for (const target of targets) {
      byTier.get(target.tier ?? 'other')!.push(target);
    }

    return (
      <div className="space-y-3">
        {renderMechanismEditorControls()}
        <dl className="space-y-3 text-sm">
          {tierOrder
            .filter((tier) => byTier.get(tier)!.length > 0)
            .map((tier) => (
              <div key={tier}>
                <dt className="text-muted-foreground text-xs">
                  {mechanismTierLabel(tier)}
                </dt>
                <dd>
                  <ul
                    className={
                      section
                        ? `${TAB_COLUMNS} gap-y-1.5 text-xs`
                        : 'space-y-1.5 text-xs'
                    }
                  >
                    {byTier
                      .get(tier)!
                      .map((target) => renderMechanismEntry(target))}
                  </ul>
                </dd>
              </div>
            ))}
        </dl>
      </div>
    );
  }

  const hasReceptorTargets = (drugRow.receptorTargets ?? []).length > 0;
  // Pharmacodynamics carries no drug-level parameters, so it isn't in
  // getNonEmptyParameterGroups; surface its box whenever the drug has ranked
  // receptor-target mechanisms to show — or when the viewer can add/review them.
  // `canFlag` is in there because a moderator who can only flag still has to be
  // able to SEE an empty section — an absent pharmacodynamics box is exactly
  // what they would want to put in front of an agent.
  const showPharmacodynamics =
    hasReceptorTargets ||
    canEditMechanisms ||
    canFlag ||
    receptorPendingEdits.length > 0;
  const groupsToRender = PARAMETER_GROUPS.map((group) => group.id).filter(
    (id) =>
      getParametersInGroup(id).length > 0 ||
      (id === 'pharmacodynamics' && showPharmacodynamics),
  );
  const showMetabolism =
    hasMetabolismData(drugRow.metabolism) || canEditMetabolism || canFlag;

  /**
   * The contents of one section, or `null` when this drug has nothing to show
   * there and the viewer cannot add anything either.
   */
  function renderSectionContent(id: SidebarSectionId): ReactNode {
    if (id === 'metabolism') {
      return showMetabolism ? renderMetabolismSection() : null;
    }
    if (!groupsToRender.includes(id)) return null;
    const groupId = id;
    // In tab mode the section fills the article column, so the postmortem
    // cohort table gets its full layout instead of the rail's compact one.
    const compactTables = !section;
    // Model-structure axes (CV-1b) live in the pharmacokinetics group but are
    // categorical, cited declarations — not numeric rows. They render in
    // their own sub-section below, so keep them out of the numeric row loop.
    const params = getParametersInGroup(groupId).filter(
      (pid) => !isModelStructureParameter(pid),
    );
    const showModelStructure = groupId === 'pharmacokinetics';
    return (
      <>
        {groupId === 'pharmacodynamics' ? renderMechanismsSection() : null}
        {params.length > 0 || groupId === 'postmortem' ? (
          <dl
            className={
              section ? `${TAB_COLUMNS} gap-y-2 text-sm` : 'space-y-2 text-sm'
            }
          >
            {params.map((pid) => renderParameterRow(pid))}
            {groupId === 'postmortem' ? renderDerivedIpmrRow() : null}
          </dl>
        ) : null}
        {/* The section owns its heading + divider so it renders nothing
            at all when a read-only monograph has no declarations. */}
        {showModelStructure ? (
          <ModelStructureSection
            drugId={drugRow.id}
            canEdit={canSubmitParameterEntry}
            isAdmin={canDirectWrite}
            onMutated={loadDrug}
          />
        ) : null}
        {/* Cmax has no drug-level row above (a peak concentration means
            nothing without its dose context); its cited readings live
            in their own section. */}
        {groupId === 'dose_exposure' ? (
          <CmaxSection
            drugId={drugRow.id}
            drugName={drugDisplayName}
            canEdit={canSubmitParameterEntry}
            isAdmin={canDirectWrite}
            onMutated={loadDrug}
            molecularWeight={drugRow.molecularWeight ?? null}
          />
        ) : null}
        {groupId === 'analytics_detection' ? renderMethodLimitsRows() : null}
        {/* The postmortem cohort's own table sits with the other postmortem
            quantities, and only here. Renders nothing without the
            rettstoks/admin gate. */}
        {groupId === 'postmortem' ? (
          <div className="mt-2">
            <DrugPmConcentrations
              drugDbId={drugRow.id}
              molecularWeight={drugRow.molecularWeight ?? null}
              compact={compactTables}
            />
          </div>
        ) : null}
        {section === 'pharmacokinetics' ? renderSimulatorLink() : null}
      </>
    );
  }

  function renderSimulatorLink() {
    return (
      <div className="pt-1">
        <Link
          to={buildSimulatorUrl({
            id: buildDrugComponentId(drugRow),
            pubchemCid: drugRow.pubchemCid,
            dbId: drugRow.id,
          })}
          className="text-xs text-primary hover:underline"
        >
          {t('sidebar.openInSimulator')}
        </Link>
      </div>
    );
  }

  function renderSectionBox(id: SidebarSectionId, title: string) {
    const content = renderSectionContent(id);
    if (content == null) return null;
    const isExpanded = expandedSection === id;
    const buttonId = `parameter-section-${id}-button`;
    const panelId = `parameter-section-${id}-panel`;
    return (
      <section
        key={id}
        data-testid={`parameter-group-${id}`}
        className="group/section rounded-lg border border-border bg-card"
      >
        <h3 className="text-sm font-semibold">
          <button
            id={buttonId}
            type="button"
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
            aria-expanded={isExpanded}
            aria-controls={panelId}
            onClick={() => setExpandedSection(id)}
          >
            <span>{title}</span>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </h3>
        {isExpanded ? (
          <div id={panelId} aria-labelledby={buttonId} className="px-3 pb-3">
            {content}
          </div>
        ) : null}
      </section>
    );
  }

  function renderAccordion() {
    return (
      <>
        {renderSectionBox('metabolism', t('sidebar.metabolism'))}

        {/* Parameter sections, grouped by category (#302). Each section is
            its own box; only the persisted active section renders rows. */}
        {groupsToRender.map((groupId: ParameterGroupId) => {
          const groupDef = PARAMETER_GROUP_BY_ID.get(groupId);
          return groupDef
            ? renderSectionBox(groupId, t(groupDef.i18nKey))
            : null;
        })}

        {renderSimulatorLink()}
      </>
    );
  }

  function renderSingleSection(id: SidebarSectionId) {
    const content = renderSectionContent(id);
    return content == null ? (
      <p className="text-xs text-muted-foreground">
        {t('monographTabs.noParameters')}
      </p>
    ) : (
      content
    );
  }

  return (
    <DrugUnitScope isEthanol={isEthanol}>
    <div
      // In tab mode there is no section box around the content, so the root
      // is the hover group that reveals the section-level actions (edit
      // metabolism / mechanisms, flag for agent).
      className={section ? 'group/section space-y-2' : 'space-y-2'}
      data-testid={
        section ? `drug-monograph-section-${section}` : 'drug-monograph-sidebar'
      }
    >
      {section ? renderSingleSection(section) : renderAccordion()}

      {/* Dialogs */}
      {showMetabolismEditor && canEditMetabolism && (
        <MetabolismEditForm
          drugId={drug.id}
          drugName={drugDisplayName}
          metabolism={drugRow.metabolism ?? null}
          onClose={() => setShowMetabolismEditor(false)}
          onSaved={() => {
            setShowMetabolismEditor(false);
            loadDrug();
            loadMetabolismPendingEdits(drug.id);
          }}
        />
      )}

      {showReceptorEditor && canEditMechanisms && (
        <ReceptorTargetEditForm
          drugId={drug.id}
          drugName={drugDisplayName}
          receptorTargets={drugRow.receptorTargets ?? []}
          onClose={() => setShowReceptorEditor(false)}
          onSaved={() => {
            setShowReceptorEditor(false);
            loadDrug();
            loadReceptorPendingEdits(drug.id);
          }}
        />
      )}

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
            loadPriorityFlags(drug.id);
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <ParameterHistoryDialog
          drugId={drug.id}
          parameter={dialog.parameter}
          verification={verificationLevels[dialog.parameter]}
          focusRevisionId={dialog.focusId}
          onClose={closeLinkedDialog}
        />
      )}

      {dialog?.kind === 'discussion' && (
        <ParameterDiscussionPanel
          drugId={drug.id}
          parameter={dialog.parameter}
          verification={verificationLevels[dialog.parameter]}
          focusCommentId={dialog.focusId}
          onClose={closeLinkedDialog}
        />
      )}

      {dialog?.kind === 'sources' && (
        <ParameterSourcesDialog
          drugId={drugRow.id}
          drugName={drugDisplayName}
          parameter={dialog.parameter}
          summaries={drugRow.parameterSummaries}
          routeSummaries={drugRow.parameterRouteSummaries}
          molecularWeight={drugRow.molecularWeight ?? null}
          bloodPlasmaRatio={drugRow.bloodPlasmaRatio ?? null}
          canEdit={canSubmitParameterEntry}
          isAdmin={canDirectWrite}
          onMutated={loadDrug}
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
            loadPriorityFlags(drug.id);
          }}
        />
      )}

      {flagArea && canFlag && (
        <ParameterFlagDialog
          drugId={drug.id}
          parameter={flagArea}
          onClose={() => setFlagArea(null)}
          onFlagged={() => {
            setFlagArea(null);
            loadPriorityFlags(drug.id);
          }}
        />
      )}
    </div>
    </DrugUnitScope>
  );
}
