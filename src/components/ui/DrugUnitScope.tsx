import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ethanolDisplayUnits } from '@/lib/ethanolUnits';

/**
 * Marks a subtree as showing one drug's concentrations, so the unit-aware
 * surfaces inside it (the monograph sidebar, prose, tooltips, source lists)
 * can pick that drug's display unit. Today the only drug with a unit of its
 * own is ethanol, shown in the reader's ethanol unit (‰ by default) instead of
 * their general primary unit.
 */
const DrugUnitScopeContext = createContext<{ isEthanol: boolean }>({
  isEthanol: false,
});

export function DrugUnitScope({
  isEthanol,
  children,
}: {
  isEthanol: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ isEthanol }), [isEthanol]);
  return (
    <DrugUnitScopeContext.Provider value={value}>
      {children}
    </DrugUnitScopeContext.Provider>
  );
}

/**
 * The reader's unit list for the current scope: first item is the primary
 * display unit, the rest are tooltip alternatives. Outside an ethanol scope this
 * is exactly `enabledUnits`.
 */
export function useDisplayUnits(): readonly string[] {
  const { isEthanol } = useContext(DrugUnitScopeContext);
  const enabledUnits = useAppStore((s) => s.enabledUnits);
  const ethanolUnit = useAppStore((s) => s.ethanolUnit);
  return useMemo(
    () => (isEthanol ? ethanolDisplayUnits(enabledUnits, ethanolUnit) : enabledUnits),
    [isEthanol, enabledUnits, ethanolUnit],
  );
}
