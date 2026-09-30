import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { DrugTable } from '@/components/DrugTable';
import { DrugTableSidebar } from '@/components/drug-table/DrugTableSidebar';
import { useDrugStore } from '@/stores/drugStore';
import { useAuthStore } from '@/stores/authStore';
import type { AnalyticalMethod, DrugComponent } from '@/types';

vi.mock('@/data', () => ({
  // The full table always overwrites the store with the loader's result on
  // mount, so the loader — not just the seeded state — has to hold the drugs.
  loadComponents: vi.fn(async () => DRUGS),
  // Resolve with the seeded method so the auth-driven method reload (which
  // clears the store's list on every access-state change) restores it.
  loadMethods: vi.fn(async () => [METHOD]),
  clearDataCache: vi.fn(),
  clearMethodsCache: vi.fn(),
}));

const METHOD: AnalyticalMethod = {
  id: '9001',
  dbId: 6,
  name: '9001 SYNTHETIC PANEL A',
  description: '9001: Synthetic panel A positive',
  components: ['2'],
  drugIds: [2],
  componentCount: 46,
};

const DRUGS: DrugComponent[] = [
  {
    id: '1',
    _dbId: 1,
    names: { nb: 'Teststoff', en: 'Test drug' },
    _searchKey: 'teststoff\ttest drug',
  } as DrugComponent,
  {
    id: '2',
    _dbId: 2,
    names: { nb: 'Metodestoff', en: 'Method drug' },
    _searchKey: 'metodestoff\tmethod drug',
  } as DrugComponent,
];

function seedStore(searchQuery: string) {
  act(() => {
    // Methods are gated to admins / the rettstoks group, and both surfaces
    // clear the store's method list for anyone else — so the suggestions
    // only exist for a user who may see methods at all.
    useAuthStore.setState({
      user: { id: 1, email: 'admin@example.com', role: 'admin' } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useDrugStore.setState({
      components: DRUGS,
      methods: [METHOD],
      activeDrug: null,
      searchQuery,
      selectedMethod: null,
      sortColumn: '_popularityScore',
      sortDirection: 'desc',
      tableView: 'full',
    });
  });
}

describe('drug table — searching for and filtering by analytical methods', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it('suggests the matching method when the query is a method code', async () => {
    seedStore('9001');

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('button', {
        name: /filter by method 9001 SYNTHETIC PANEL A/i,
      }),
    ).toBeInTheDocument();
  });

  it('filters the table to the method components and clears the query when a suggestion is picked', async () => {
    seedStore('9001');

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /filter by method 9001 SYNTHETIC PANEL A/i,
      }),
    );

    expect(useDrugStore.getState().selectedMethod).toBe('9001');
    expect(useDrugStore.getState().searchQuery).toBe('');
    expect(await screen.findByText('Method drug')).toBeInTheDocument();
    expect(screen.queryByText('Test drug')).not.toBeInTheDocument();
  });

  it('does not re-suggest the method that is already applied', () => {
    seedStore('9001');
    act(() => {
      useDrugStore.setState({ selectedMethod: '9001' });
    });

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole('button', { name: /filter by method/i }),
    ).not.toBeInTheDocument();
  });

  it('shows no method suggestions for an ordinary drug-name query', () => {
    seedStore('test');

    render(
      <MemoryRouter>
        <DrugTable />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole('button', { name: /filter by method/i }),
    ).not.toBeInTheDocument();
  });

  it('offers the same method filter from the sidebar, which has no method dropdown', async () => {
    seedStore('synthetic');

    render(
      <MemoryRouter>
        <DrugTableSidebar />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /filter by method 9001 SYNTHETIC PANEL A/i,
      }),
    );

    expect(useDrugStore.getState().selectedMethod).toBe('9001');
    expect(await screen.findByText('Method drug')).toBeInTheDocument();
    expect(screen.queryByText('Test drug')).not.toBeInTheDocument();
  });
});
