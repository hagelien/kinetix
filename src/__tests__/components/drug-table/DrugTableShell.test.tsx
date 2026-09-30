import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DrugTableShell } from '@/components/drug-table/DrugTableShell';
import { useDrugStore } from '@/stores/drugStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/data', () => ({
  loadComponents: vi.fn().mockResolvedValue([]),
  loadMethods: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/components/DrugTable', () => ({
  DrugTable: ({ fullScreen }: { fullScreen?: boolean }) => (
    <div data-testid={fullScreen ? 'full-table' : 'table'} />
  ),
}));

vi.mock('@/components/drug-table/DrugTableSidebar', () => ({
  DrugTableSidebar: () => <div data-testid="sidebar" />,
}));

describe('drugStore — tableView state machine', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useDrugStore.setState({
        tableView: 'full',
        sortColumn: '_popularityScore',
        sortDirection: 'desc',
      });
    });
  });

  it('defaults to full view', () => {
    expect(useDrugStore.getState().tableView).toBe('full');
  });

  it('transitions full → sidebar', () => {
    act(() => {
      useDrugStore.getState().setTableView('sidebar');
    });
    expect(useDrugStore.getState().tableView).toBe('sidebar');
  });

  it('transitions sidebar → collapsed', () => {
    act(() => {
      useDrugStore.getState().setTableView('sidebar');
      useDrugStore.getState().setTableView('collapsed');
    });
    expect(useDrugStore.getState().tableView).toBe('collapsed');
  });

  it('transitions collapsed → sidebar (reveal)', () => {
    act(() => {
      useDrugStore.getState().setTableView('collapsed');
      useDrugStore.getState().setTableView('sidebar');
    });
    expect(useDrugStore.getState().tableView).toBe('sidebar');
  });

  it('preserves sortColumn and sortDirection across view changes', () => {
    act(() => {
      useDrugStore.getState().setSorting('halfLife', 'asc');
      useDrugStore.getState().setTableView('sidebar');
      useDrugStore.getState().setTableView('full');
    });
    const state = useDrugStore.getState();
    expect(state.sortColumn).toBe('halfLife');
    expect(state.sortDirection).toBe('asc');
  });

  it('includes sortColumn and sortDirection in persisted preferences', () => {
    act(() => {
      useDrugStore.getState().setSorting('toxicConcentration', 'desc');
    });

    const persistable = useDrugStore.persist.getOptions().partialize!(
      useDrugStore.getState(),
    ) as Partial<ReturnType<typeof useDrugStore.getState>>;
    expect(persistable.sortColumn).toBe('toxicConcentration');
    expect(persistable.sortDirection).toBe('desc');
  });
});

describe('DrugTableShell', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useDrugStore.setState({ tableView: 'full' });
    });
  });

  it('collapses persisted full view on non-root routes while preserving manual expansion', async () => {
    render(
      <MemoryRouter initialEntries={['/wiki']}>
        <DrugTableShell>
          <main>Wiki route</main>
        </DrugTableShell>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('full-table')).toBeNull();
    await waitFor(() => {
      expect(useDrugStore.getState().tableView).toBe('sidebar');
    });
    expect(await screen.findByTestId('sidebar')).toBeTruthy();

    act(() => {
      useDrugStore.getState().setTableView('full');
    });

    expect(await screen.findByTestId('full-table')).toBeTruthy();
  });
});
