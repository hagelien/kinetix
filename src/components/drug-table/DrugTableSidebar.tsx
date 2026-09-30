import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Search,
  ChevronsLeftRight,
  ChevronLeft,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useDrugStore } from '@/stores/drugStore';
import { useFractionDisplay } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { loadComponents, loadMethods } from '@/data';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { methodIncludesDrug } from '@/lib/analyticalMethods';
import { formatMethodLabel, searchMethods } from '@/lib/methodSearch';
import {
  formatRange,
  showFractionAsPercent,
  type FractionDisplay,
  normalizeRangeInput,
  extremeForSort,
} from '@/lib/rangeUtils';
import { drugComponentKey } from '@/lib/drugSearch';
import { activeLangCode } from '@/lib/useDrugName';
import { capitalizeGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import {
  DRUG_PARAMETER_IDS,
  DRUG_VALUE_PARAMETER_IDS,
  DRUG_PARAMETERS,
  getParameterLabelKey,
  type DrugParameterId,
} from '@/lib/drugParameters';
import type { DrugComponent, NumericRange } from '@/types';
import { useDrugRowSelect } from './useDrugRowSelect';
import { useDrugTableSearchResults } from './useDrugTableSearchResults';
import { MethodSearchMatches } from './MethodSearchMatches';
import { DrugNameCell } from './DrugNameCell';

interface ParamColumn {
  id: string;
  i18nKey: string;
  sortKey: DrugParameterId;
  fallback: string;
  /**
   * Format one cell. Takes the fraction-display preference so F and protein
   * binding can be written as percentages; columns that hold no fraction
   * simply ignore it.
   */
  format: (value: unknown, fractionDisplay: FractionDisplay) => string;
}

function rangeFmt(
  value: unknown,
  opts?: { asFraction?: boolean; asPercent?: boolean },
): string {
  const normalized = normalizeRangeInput(
    value as NumericRange | number | undefined,
    { asFraction: opts?.asFraction },
  );
  return formatRange(normalized, {
    showNote: false,
    showUnit: false,
    asPercent: opts?.asPercent,
  });
}

/**
 * Dimmed em dash for empty cells — see DrugTable's EMPTY_VALUE. Kept in
 * sync so both table surfaces render blanks with the same softened contrast.
 */
const EMPTY_VALUE = <span className="text-muted-foreground/40">—</span>;

const PARAM_COLUMNS: ParamColumn[] = [
  {
    id: 'molecularWeight',
    i18nKey: 'drugTable.mw',
    sortKey: 'molecularWeight',
    fallback: 'MW',
    format: (v) => (typeof v === 'number' ? v.toFixed(1) : ''),
  },
  {
    id: 'halfLife',
    i18nKey: 'drugTable.halfLife',
    sortKey: 'halfLife',
    fallback: 't½',
    format: (v) => rangeFmt(v),
  },
  {
    id: 'volumeOfDistribution',
    i18nKey: 'drugTable.vd',
    sortKey: 'volumeOfDistribution',
    fallback: 'Vd',
    format: (v) => rangeFmt(v),
  },
  {
    id: 'bioavailability',
    i18nKey: 'drugTable.f',
    sortKey: 'bioavailability',
    fallback: 'F',
    format: (v, fractionDisplay) =>
      rangeFmt(v, {
        asFraction: true,
        asPercent: fractionDisplay === 'percent',
      }),
  },
  {
    id: 'bloodPlasmaRatio',
    i18nKey: 'drugTable.bp',
    sortKey: 'bloodPlasmaRatio',
    fallback: 'B/P',
    format: (v) => rangeFmt(v),
  },
  {
    id: 'proteinBinding',
    i18nKey: 'drugTable.fb',
    sortKey: 'proteinBinding',
    fallback: 'Fb',
    format: (v, fractionDisplay) =>
      rangeFmt(v, {
        asFraction: true,
        asPercent: fractionDisplay === 'percent',
      }),
  },
  {
    id: 'tmax',
    i18nKey: 'drugTable.tmax',
    sortKey: 'tmax',
    fallback: 'Tmax',
    format: (v) => rangeFmt(v),
  },
  {
    id: 'pKa',
    i18nKey: 'drugTable.pKa',
    sortKey: 'pKa',
    fallback: 'pKa',
    format: (v) => rangeFmt(v),
  },
];

const PARAM_COLUMN_BY_ID: Record<string, ParamColumn> = Object.fromEntries(
  PARAM_COLUMNS.map((c) => [c.id, c]),
);

function isDrugParameterId(id: string): id is DrugParameterId {
  return (DRUG_PARAMETER_IDS as readonly string[]).includes(id);
}

function toSortable(
  val: unknown,
  direction: 'asc' | 'desc',
): number | string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    const joined = val.filter(Boolean).join(', ');
    return joined || null;
  }
  if (typeof val === 'object') {
    const r = val as NumericRange;
    if (
      typeof r.median === 'number' ||
      typeof r.mean === 'number' ||
      typeof r.min === 'number' ||
      typeof r.max === 'number'
    ) {
      return extremeForSort(r, direction);
    }
  }
  return null;
}

function compareSortable(
  a: number | string | null,
  b: number | string | null,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return 0;
}

function getDrugSortValue(
  drug: DrugComponent,
  sortColumn: string,
  lang: string,
): unknown {
  if (sortColumn === 'name') return resolveDrugName(drug.names, lang);
  if (sortColumn === '_popularityScore') return drug._popularityScore;
  if (sortColumn === 'nameNb') return drug.names.nb;
  if (sortColumn === 'nameEn') return drug.names.en;
  if (sortColumn === 'aliases') return drug.aliases;
  return (drug as unknown as Record<string, unknown>)[sortColumn];
}

function getDisplayColumn(sortColumn: string): ParamColumn {
  if (isDrugParameterId(sortColumn)) {
    const spec = DRUG_PARAMETERS[sortColumn];
    return (
      PARAM_COLUMN_BY_ID[sortColumn] ?? {
        id: sortColumn,
        i18nKey: getParameterLabelKey(sortColumn),
        sortKey: sortColumn,
        fallback: spec.label,
        format: (value, fractionDisplay) =>
          showFractionAsPercent(spec.kind, fractionDisplay)
            ? rangeFmt(value, { asFraction: true, asPercent: true })
            : spec.format(value) || '',
      }
    );
  }
  return PARAM_COLUMN_BY_ID.molecularWeight as ParamColumn;
}

/**
 * Narrow left-rail variant of the drug table, surfaced when the global
 * drug-table shell is in `sidebar` mode (#298). Shows the drug name plus a
 * single user-selected parameter column whose value drives sorting. Clicking
 * a row activates that drug's monograph in the route content area without
 * collapsing the sidebar — same surface, same sidebar state.
 */
export function DrugTableSidebar() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);

  const fractionDisplay = useFractionDisplay();
  const components = useDrugStore((s) => s.components);
  const methods = useDrugStore((s) => s.methods);
  const activeDrug = useDrugStore((s) => s.activeDrug);
  const searchQuery = useDrugStore((s) => s.searchQuery);
  const selectedMethod = useDrugStore((s) => s.selectedMethod);
  const sortColumn = useDrugStore((s) => s.sortColumn);
  const sortDirection = useDrugStore((s) => s.sortDirection);
  const setComponents = useDrugStore((s) => s.setComponents);
  const setMethods = useDrugStore((s) => s.setMethods);
  const setSearchQuery = useDrugStore((s) => s.setSearchQuery);
  const setSelectedMethod = useDrugStore((s) => s.setSelectedMethod);
  const setSorting = useDrugStore((s) => s.setSorting);
  const setTableView = useDrugStore((s) => s.setTableView);
  const canLoadMethods = useAuthStore((s) =>
    canAccessAnalyticalMethods(s.user, s.permissionOverrides),
  );

  const { select } = useDrugRowSelect();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Lazy-load public catalog data on mount: the sidebar can be the first
  // surface a user sees if their persisted preference is `sidebar` and they
  // land on a non-`/` route.
  useEffect(() => {
    if (components.length > 0) return;
    let mounted = true;
    loadComponents().then((comps) => {
      if (!mounted) return;
      if (components.length === 0) setComponents(comps);
    });
    return () => {
      mounted = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canLoadMethods) {
      setMethods([]);
      return;
    }
    if (methods.length > 0) return;
    let mounted = true;
    loadMethods().then((meths) => {
      if (!mounted) return;
      if (methods.length === 0) setMethods(meths);
    });
    return () => {
      mounted = false;
    };
  }, [canLoadMethods, methods.length, setMethods]);

  // The right column shows whatever numeric parameter is being sorted on.
  // Sort keys that don't map to a parameter (popularity, name) fall back to
  // MW for display only — sorting itself uses `sortColumn` directly so the
  // user's choice from the full table survives the collapse to sidebar
  // (#311).
  const displayParamColumn = useMemo(
    () => getDisplayColumn(sortColumn),
    [sortColumn],
  );

  // Search runs server-side (same endpoint as the Ctrl+K palette) so DB-only,
  // low-popularity drugs outside the preloaded catalog are findable here too;
  // `searchResults` is the preloaded catalog when there's no query.
  const { components: searchResults } = useDrugTableSearchResults();

  // Method hits for the current query. The sidebar owns no method picker, so
  // these chips are also the only way to reach a method filter from here —
  // the pill below then makes the applied filter visible and clearable.
  const methodMatches = useMemo(
    () =>
      searchMethods(methods, searchQuery).filter(
        (m) => m.id !== selectedMethod,
      ),
    [methods, searchQuery, selectedMethod],
  );

  const applyMethodFilter = useCallback(
    (methodId: string) => {
      setSelectedMethod(methodId);
      setSearchQuery('');
    },
    [setSelectedMethod, setSearchQuery],
  );

  // Label for the active-filter pill. Falls back to the bare code if the
  // method list hasn't (re)loaded yet — the filter is still in effect, so the
  // pill must render either way.
  const activeMethodLabel = useMemo(() => {
    if (!selectedMethod) return '';
    const active = methods.find((m) => m.id === selectedMethod);
    return active ? formatMethodLabel(active) : selectedMethod;
  }, [methods, selectedMethod]);

  const filteredComponents = useMemo(() => {
    let filtered = searchResults;

    if (selectedMethod) {
      const method = methods.find((m) => m.id === selectedMethod);
      if (method) {
        filtered = filtered.filter((c) => methodIncludesDrug(method, c));
      }
    }

    return [...filtered].sort((a, b) => {
      const aName = resolveDrugName(a.names, lang);
      const bName = resolveDrugName(b.names, lang);
      const aRaw = getDrugSortValue(a, sortColumn, lang);
      const bRaw = getDrugSortValue(b, sortColumn, lang);
      const aVal = toSortable(aRaw, sortDirection);
      const bVal = toSortable(bRaw, sortDirection);
      if (aVal === null && bVal === null) return aName.localeCompare(bName);
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      const cmp = compareSortable(aVal, bVal);
      if (cmp === 0) return aName.localeCompare(bName);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [
    searchResults,
    methods,
    selectedMethod,
    sortColumn,
    sortDirection,
    lang,
  ]);

  // Sidebar sort options mirror the full table's set so sorting state stays
  // coherent when the user toggles between the two views (#311).
  const paramOptions = useMemo(
    () => [
      {
        value: '_popularityScore',
        label: t('drugTable.sort.popularity', { defaultValue: 'Popularity' }),
      },
      { value: 'name', label: t('drugTable.name', { defaultValue: 'Name' }) },
      // Model-structure axes (CV-1b) have no drug-level value to sort by, so
      // they are excluded from the sort options (DRUG_VALUE_PARAMETER_IDS).
      ...DRUG_VALUE_PARAMETER_IDS.map((id) => ({
        value: id,
        label: t(getParameterLabelKey(id), {
          defaultValue: DRUG_PARAMETERS[id].label,
        }),
      })),
    ],
    [t],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <div className="flex items-center justify-between gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={() => setTableView('full')}
          aria-label={t('drugTable.expandToFull')}
          title={t('drugTable.expandToFull')}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/20"
        >
          <ChevronsLeftRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setTableView('collapsed')}
          aria-label={t('drugTable.collapseFully')}
          title={t('drugTable.collapseFully')}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/20"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="search"
            placeholder={t('drugTable.filterPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <Select
            aria-label={t('drugTable.sortBy')}
            options={paramOptions}
            value={sortColumn}
            onChange={(e) => setSorting(e.target.value, sortDirection)}
            className="flex-1 h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSorting(sortColumn, sortDirection === 'asc' ? 'desc' : 'asc')
            }
            className="h-8 px-1.5 shrink-0"
            aria-label={
              sortDirection === 'asc'
                ? t('drugTable.sortAsc')
                : t('drugTable.sortDesc')
            }
            title={
              sortDirection === 'asc'
                ? t('drugTable.sortAsc')
                : t('drugTable.sortDesc')
            }
          >
            {sortDirection === 'asc' ? (
              <ArrowUp className="h-3.5 w-3.5" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <MethodSearchMatches
          methods={methodMatches}
          onSelect={applyMethodFilter}
          compact
        />
      </div>

      {/* Method filter is shared with the full table via the store. The
          sidebar has no method dropdown (only the search chips above), so a
          user who selected a method in the full view and then collapsed
          could see a mysteriously short list. Surface the active filter as a
          clearable pill so that state is visible and recoverable in the
          sidebar (#299 review). */}
      {selectedMethod && (
        <div className="px-2 pb-2 -mt-1">
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground truncate">
              {t('drugTable.filteredByMethod', {
                method: activeMethodLabel,
              })}
            </span>
            <button
              type="button"
              onClick={() => setSelectedMethod(null)}
              aria-label={t('drugTable.clearMethodFilter')}
              title={t('drugTable.clearMethodFilter')}
              className="ml-auto inline-flex items-center justify-center h-4 w-4 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent/30"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {/* Independent-scroll list area: the surrounding shell owns the height,
          this child owns the overflow so neither the route content nor the
          parameter rail moves when the user scrolls drugs (#298). */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* `table-fixed` enforces the name column's 55% width so long names
            truncate with ellipsis instead of stretching the column wider
            than the rail (#399). */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[55%] py-2">
                {t('drugTable.name')}
              </TableHead>
              <TableHead className="py-2 text-right whitespace-nowrap">
                {t(displayParamColumn.i18nKey, {
                  defaultValue: displayParamColumn.fallback,
                })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredComponents.map((drug) => {
              const value = getDrugSortValue(
                drug,
                displayParamColumn.sortKey,
                lang,
              );
              const display = displayParamColumn.format(value, fractionDisplay);
              const isSelected = activeDrug?.id === drug.id;
              // Match the main table: show the full generic name in the row;
              // shortnames and aliases remain available from the name tooltip.
              const displayName = capitalizeGenericDrugName(
                resolveDrugName(drug.names, lang),
              );
              return (
                <TableRow
                  key={drugComponentKey(drug)}
                  active={isSelected}
                  onClick={() => void select(drug)}
                  className="cursor-pointer [&>td]:py-1.5"
                >
                  <TableCell className="font-medium truncate">
                    <div className="block w-full max-w-full overflow-hidden">
                      <DrugNameCell
                        drug={drug}
                        displayName={displayName}
                        t={t}
                        nameClassName={
                          isSelected ? 'text-primary font-bold' : 'font-medium'
                        }
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {displayParamColumn.id === 'molecularWeight'
                      ? typeof value === 'number'
                        ? value.toFixed(1)
                        : EMPTY_VALUE
                      : display || EMPTY_VALUE}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <p className="text-[11px] text-muted-foreground px-2 py-1.5 border-t border-border">
        {t('drugTable.drugsShown', {
          shown: filteredComponents.length,
          total: components.length,
        })}
      </p>
    </div>
  );
}
