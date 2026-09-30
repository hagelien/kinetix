import { useTranslation } from 'react-i18next';
import { ChevronRight, Table as TableIcon } from 'lucide-react';
import { useDrugStore } from '@/stores/drugStore';

/**
 * Slim left-edge button rendered in place of the drug table when the user
 * has fully collapsed the global shell. Clicking re-opens the sidebar view
 * (#298). The strip is intentionally narrow so the route content fills the
 * rest of the viewport.
 */
export function DrugTableCollapsedHandle() {
  const { t } = useTranslation();
  const setTableView = useDrugStore((s) => s.setTableView);

  return (
    <button
      type="button"
      onClick={() => setTableView('sidebar')}
      aria-label={t('drugTable.expandToSidebar')}
      title={t('drugTable.expandToSidebar')}
      className="flex flex-col items-center justify-center gap-2 h-full w-full bg-muted/30 hover:bg-muted/60 border-r border-border text-muted-foreground hover:text-foreground transition-colors"
    >
      <ChevronRight className="h-4 w-4" />
      <TableIcon className="h-4 w-4" />
    </button>
  );
}
