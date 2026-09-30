import { useCallback, useState } from 'react';
import { useDrugStore, type DrugTableView } from '@/stores/drugStore';
import { useKeyboardShortcut } from '@/lib/useKeyboardShortcut';
import { UnitConversionDialog } from '@/components/UnitConversionDialog';

const TABLE_VIEW_CYCLE: DrugTableView[] = ['full', 'sidebar', 'collapsed'];

/**
 * App-shell mounted host for the global keyboard shortcuts (#308):
 *
 *  - **Ctrl+B** — cycle the drug table between full / sidebar / collapsed.
 *  - **Ctrl+Shift+U** — open the unit-conversion dialog with the active
 *    drug prefilled.
 *
 * The Ctrl+K command palette and the Ctrl+Enter "send to simulator"
 * shortcut live inside `CommandPalette` directly because they need
 * the palette's own state.
 */
export function GlobalShortcuts() {
  const tableView = useDrugStore((s) => s.tableView);
  const setTableView = useDrugStore((s) => s.setTableView);
  const [unitDialogOpen, setUnitDialogOpen] = useState(false);

  const cycleTableView = useCallback(() => {
    const idx = TABLE_VIEW_CYCLE.indexOf(tableView);
    const next = TABLE_VIEW_CYCLE[(idx + 1) % TABLE_VIEW_CYCLE.length]!;
    setTableView(next);
  }, [tableView, setTableView]);

  useKeyboardShortcut({
    key: 'b',
    ctrl: true,
    handler: (e) => {
      e.preventDefault();
      cycleTableView();
    },
  });

  useKeyboardShortcut({
    key: 'u',
    ctrl: true,
    shift: true,
    handler: (e) => {
      e.preventDefault();
      setUnitDialogOpen(true);
    },
  });

  return (
    <UnitConversionDialog
      open={unitDialogOpen}
      onClose={() => setUnitDialogOpen(false)}
    />
  );
}
