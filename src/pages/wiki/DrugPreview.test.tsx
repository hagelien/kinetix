import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DrugPreview } from './DrugPreview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

// The store and child components are not under test here; stub them so the
// preview can mount without pulling in real data fetching.
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({ user: null, isAuthenticated: false }),
}));
vi.mock('@/components/wiki/DrugMonographSidebar', () => ({
  DrugMonographSidebar: () => <div data-testid="sidebar" />,
}));
vi.mock('@/components/wiki/DrugAnalyticalMethods', () => ({
  DrugAnalyticalMethods: () => null,
}));

const fetchDrugWikiPage = vi.fn();
const fetchDrugById = vi.fn();

vi.mock('@/lib/wikiApi', () => ({
  fetchDrugWikiPage: (cid: number) => fetchDrugWikiPage(cid),
}));
vi.mock('@/lib/drugApi', () => ({
  fetchDrugById: (cid: number) => fetchDrugById(cid),
  drugRowToComponent: () => ({}),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/wiki/drug/:drugId" element={<DrugPreview />} />
        <Route path="/wiki/:slug" element={<div>slug page: {':slug'}</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DrugPreview canonical redirect', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('redirects /wiki/drug/:id to the slug page when a monograph exists', async () => {
    fetchDrugWikiPage.mockResolvedValue({ page: { slug: 'ketamine' } });

    renderAt('/wiki/drug/5');

    await waitFor(() => {
      expect(screen.getByText(/slug page/)).toBeInTheDocument();
    });
    expect(fetchDrugWikiPage).toHaveBeenCalledWith(5);
    // No need to load the drug row when we are redirecting away.
    expect(fetchDrugById).not.toHaveBeenCalled();
  });

  it('renders the preview when no monograph exists yet', async () => {
    fetchDrugWikiPage.mockResolvedValue({ page: null });
    fetchDrugById.mockResolvedValue({
      drug: { _dbId: 5, names: { en: 'Ketamine' } },
    });

    renderAt('/wiki/drug/5');

    await waitFor(() => {
      expect(screen.getByText('drugPreview.noMonographYet')).toBeInTheDocument();
    });
    expect(screen.queryByText(/slug page/)).not.toBeInTheDocument();
    expect(fetchDrugById).toHaveBeenCalledWith(5);
  });
});
