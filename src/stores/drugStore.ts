import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DrugComponent, AnalyticalMethod, NumericRange } from '@/types';
import { meanRange } from '@/lib/rangeUtils';
import { searchDrugs } from '@/lib/drugSearch';
import { methodIncludesDrug } from '@/lib/analyticalMethods';

export type DrugTableView = 'full' | 'sidebar' | 'collapsed';

interface DrugState {
  components: DrugComponent[];
  methods: AnalyticalMethod[];
  activeDrug: DrugComponent | null;
  searchQuery: string;
  selectedMethod: string | null;
  sortColumn: string;
  sortDirection: 'asc' | 'desc';
  tableView: DrugTableView;
  /**
   * Columns another surface has asked the table to switch to, pending until
   * the table picks them up.
   *
   * The visible-column set lives inside `DrugTable` (and is persisted from
   * there), so a caller that wants the register opened on a particular axis —
   * the detection-times page's "every substance" link — has nowhere to put its
   * request: the table may not even be mounted yet when the request is made.
   * This is that handover, and it is one-shot on purpose. Left standing, it
   * would re-assert itself over the reader's own column picker on the table's
   * next render.
   */
  pendingColumnPreset: string[] | null;

  // Actions
  setComponents: (components: DrugComponent[]) => void;
  setMethods: (methods: AnalyticalMethod[]) => void;
  setActiveDrug: (drug: DrugComponent | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedMethod: (methodId: string | null) => void;
  setSorting: (column: string, direction: 'asc' | 'desc') => void;
  toggleSort: (column: string) => void;
  setTableView: (view: DrugTableView) => void;
  requestColumnPreset: (columnIds: string[]) => void;
  /** Take the pending preset, clearing it. Returns null when there is none. */
  consumeColumnPreset: () => string[] | null;
}

const TABLE_VIEW_STORAGE_KEY = 'kinetix.drugTable';

export const useDrugStore = create<DrugState>()(
  persist(
    (set, get) => ({
      components: [],
      methods: [],
      activeDrug: null,
      searchQuery: '',
      selectedMethod: null,
      sortColumn: '_popularityScore',
      sortDirection: 'desc',
      tableView: 'full',
      pendingColumnPreset: null,

      setComponents: (components) => set({ components }),
      setMethods: (methods) => set({ methods }),
      setActiveDrug: (drug) => set({ activeDrug: drug }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSelectedMethod: (methodId) => set({ selectedMethod: methodId }),
      setSorting: (column, direction) =>
        set({ sortColumn: column, sortDirection: direction }),
      toggleSort: (column) => {
        const state = get();
        if (state.sortColumn === column) {
          set({
            sortDirection: state.sortDirection === 'asc' ? 'desc' : 'asc',
          });
        } else {
          set({ sortColumn: column, sortDirection: 'asc' });
        }
      },
      setTableView: (view) => set({ tableView: view }),
      requestColumnPreset: (columnIds) =>
        set({ pendingColumnPreset: [...columnIds] }),
      consumeColumnPreset: () => {
        const pending = get().pendingColumnPreset;
        if (pending) set({ pendingColumnPreset: null });
        return pending;
      },
    }),
    {
      name: TABLE_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist only user-facing table preferences. Catalog data, search,
      // and selection are runtime-only and should not survive reloads.
      partialize: (state) => ({
        tableView: state.tableView,
        sortColumn: state.sortColumn,
        sortDirection: state.sortDirection,
      }),
    },
  ),
);

// ─── Sort helpers ───────────────────────────────────────────────────────────

function toSortable(val: unknown): number | string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    // NumericRange-like
    const r = val as NumericRange;
    if (
      typeof r.median === 'number' ||
      typeof r.mean === 'number' ||
      typeof r.min === 'number' ||
      typeof r.max === 'number'
    ) {
      return meanRange(r);
    }
  }
  return null;
}

function compareSortable(
  aVal: number | string | null,
  bVal: number | string | null,
): number {
  // Nulls always sort to the bottom regardless of direction (stable policy).
  if (aVal === null && bVal === null) return 0;
  if (aVal === null) return 1;
  if (bVal === null) return -1;
  if (typeof aVal === 'string' && typeof bVal === 'string') {
    return aVal.localeCompare(bVal);
  }
  if (typeof aVal === 'number' && typeof bVal === 'number') {
    return aVal - bVal;
  }
  return 0;
}

// Selectors
export const selectFilteredComponents = (state: DrugState): DrugComponent[] => {
  let filtered = state.searchQuery
    ? searchDrugs(state.components, state.searchQuery)
    : state.components;

  if (state.selectedMethod) {
    const method = state.methods.find((m) => m.id === state.selectedMethod);
    if (method) {
      filtered = filtered.filter((c) => methodIncludesDrug(method, c));
    }
  }

  // Sort: handles scalars, strings, and NumericRange-shaped values.
  filtered = [...filtered].sort((a, b) => {
    const aRaw = a[state.sortColumn as keyof DrugComponent];
    const bRaw = b[state.sortColumn as keyof DrugComponent];
    const aVal = toSortable(aRaw);
    const bVal = toSortable(bRaw);

    // Keep nulls at the bottom regardless of direction.
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;

    const comparison = compareSortable(aVal, bVal);
    return state.sortDirection === 'asc' ? comparison : -comparison;
  });

  return filtered;
};
