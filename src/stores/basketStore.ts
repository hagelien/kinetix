import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  getStoredValue,
  removeStoredValues,
  setStoredValue,
} from '@/lib/storage';
import { DRUG_PARAMETER_IDS, type DrugParameterId } from '@/lib/drugParameters';

/**
 * The shared drug basket.
 *
 * Both the comparison module and the analytical-method suggester operate on
 * this single list of drugs, so adding a drug anywhere on the site immediately
 * makes it available to every basket-driven feature. (Previously the comparison
 * page and the method suggester each kept their own separate basket.)
 *
 * The basket itself is just a list of drugs; the comparison module layers a few
 * view preferences on top — which parameters to compare and which drug is the
 * reference — so those live here too rather than as page-local state.
 */
export interface BasketItem {
  drugId: number;
  pubchemCid: number | null;
  drugName: string;
  addedAt: number;
}

interface BasketState {
  items: BasketItem[];
  /** Parameters the comparison page renders the basket drugs against. */
  comparisonParameterIds: DrugParameterId[];
  /**
   * Receptor targets (bio-entity ids) the comparison page lines the basket
   * drugs up at — the pharmacodynamic counterpart of the parameter list.
   */
  comparisonTargetIds: number[];
  /** Reference drug for comparison ratios. */
  referenceDrugId: number | null;
  addItem: (item: Omit<BasketItem, 'addedAt'>) => void;
  removeItem: (drugId: number) => void;
  clear: () => void;
  setReferenceDrugId: (drugId: number | null) => void;
  /** Add a parameter to the comparison view (no-op if already present). */
  addComparisonParameter: (parameterId: DrugParameterId) => void;
  toggleComparisonParameter: (parameterId: DrugParameterId) => void;
  toggleComparisonTarget: (targetId: number) => void;
}

const BASKET_STORAGE_KEY = 'kinetix.basket';
const LEGACY_COMPARISON_KEY = 'kinetix.comparisonBasket';
const LEGACY_METHOD_KEY = 'kinetix.methodBasket';
const DEFAULT_COMPARISON_PARAMETERS: DrugParameterId[] = ['halfLife'];

function isParameterId(value: unknown): value is DrugParameterId {
  return (
    typeof value === 'string' &&
    (DRUG_PARAMETER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Seed the unified basket from the two legacy baskets the first time the app
 * runs after this change, so existing users don't lose their saved work. Only
 * consulted when there is no persisted `kinetix.basket` yet — the persist
 * middleware rehydrates over this whenever the unified key exists.
 */
function migratedLegacyState(): Pick<
  BasketState,
  'items' | 'comparisonParameterIds' | 'referenceDrugId'
> {
  const items = new Map<number, BasketItem>();
  const parameters = new Set<DrugParameterId>();
  let referenceDrugId: number | null = null;

  const readLegacy = (key: string): Record<string, unknown> | null => {
    try {
      const raw = getStoredValue(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // zustand persist wraps state as { state, version }.
      return (parsed?.state ?? parsed) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const ingestItems = (state: Record<string, unknown> | null) => {
    if (!state || !Array.isArray(state.items)) return;
    for (const raw of state.items) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const drugId = Number(entry.drugId);
      if (!Number.isFinite(drugId)) continue;
      if (!items.has(drugId)) {
        items.set(drugId, {
          drugId,
          pubchemCid:
            typeof entry.pubchemCid === 'number' ? entry.pubchemCid : null,
          drugName: String(entry.drugName ?? drugId),
          addedAt:
            typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
        });
      }
      if (isParameterId(entry.parameterId)) parameters.add(entry.parameterId);
    }
  };

  const comparison = readLegacy(LEGACY_COMPARISON_KEY);
  ingestItems(comparison);
  if (comparison && typeof comparison.referenceDrugId === 'number') {
    referenceDrugId = comparison.referenceDrugId;
  }
  ingestItems(readLegacy(LEGACY_METHOD_KEY));

  // Drop the legacy keys now that we've folded them in.
  removeStoredValues(LEGACY_COMPARISON_KEY);
  removeStoredValues(LEGACY_METHOD_KEY);

  const list = [...items.values()];
  return {
    items: list,
    comparisonParameterIds: parameters.size
      ? DRUG_PARAMETER_IDS.filter((id) => parameters.has(id))
      : DEFAULT_COMPARISON_PARAMETERS,
    referenceDrugId:
      referenceDrugId !== null && items.has(referenceDrugId)
        ? referenceDrugId
        : (list[0]?.drugId ?? null),
  };
}

const legacy = migratedLegacyState();

export const useBasketStore = create<BasketState>()(
  persist(
    (set) => ({
      items: legacy.items,
      comparisonParameterIds: legacy.comparisonParameterIds,
      comparisonTargetIds: [],
      referenceDrugId: legacy.referenceDrugId,
      addItem: (item) =>
        set((state) => {
          // De-dupe on drugId; refresh the existing entry rather than append.
          const existingIndex = state.items.findIndex(
            (current) => current.drugId === item.drugId,
          );
          const nextItem: BasketItem = { ...item, addedAt: Date.now() };
          const items =
            existingIndex >= 0
              ? state.items.map((current, index) =>
                  index === existingIndex ? nextItem : current,
                )
              : [...state.items, nextItem];
          return {
            items,
            referenceDrugId: state.referenceDrugId ?? item.drugId,
          };
        }),
      removeItem: (drugId) =>
        set((state) => {
          const items = state.items.filter((item) => item.drugId !== drugId);
          const referenceStillSelected = items.some(
            (item) => item.drugId === state.referenceDrugId,
          );
          return {
            items,
            referenceDrugId: referenceStillSelected
              ? state.referenceDrugId
              : (items[0]?.drugId ?? null),
          };
        }),
      clear: () => set({ items: [], referenceDrugId: null }),
      setReferenceDrugId: (drugId) => set({ referenceDrugId: drugId }),
      addComparisonParameter: (parameterId) =>
        set((state) =>
          state.comparisonParameterIds.includes(parameterId)
            ? state
            : {
                comparisonParameterIds: DRUG_PARAMETER_IDS.filter(
                  (id) =>
                    id === parameterId ||
                    state.comparisonParameterIds.includes(id),
                ),
              },
        ),
      toggleComparisonParameter: (parameterId) =>
        set((state) => {
          const has = state.comparisonParameterIds.includes(parameterId);
          return {
            comparisonParameterIds: has
              ? state.comparisonParameterIds.filter((id) => id !== parameterId)
              : DRUG_PARAMETER_IDS.filter(
                  (id) =>
                    id === parameterId ||
                    state.comparisonParameterIds.includes(id),
                ),
          };
        }),
      toggleComparisonTarget: (targetId) =>
        set((state) => {
          const current = Array.isArray(state.comparisonTargetIds)
            ? state.comparisonTargetIds
            : [];
          return {
            comparisonTargetIds: current.includes(targetId)
              ? current.filter((id) => id !== targetId)
              : [...current, targetId],
          };
        }),
    }),
    {
      name: BASKET_STORAGE_KEY,
      storage: createJSONStorage(() => ({
        getItem: (name) => getStoredValue(name),
        setItem: (name, value) => setStoredValue(name, value),
        removeItem: (name) => removeStoredValues(name),
      })),
    },
  ),
);
