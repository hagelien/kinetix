import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { WikiPage } from './WikiPage';
import { useDrugStore } from '@/stores/drugStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

// Everything around the page's own layout is stubbed: this suite is about
// which drug and which tab the monograph page says it shows.
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({ user: null }),
}));
vi.mock('@/lib/usePermissions', () => ({ useCan: () => false }));
vi.mock('@/components/wiki/WikiRenderer', () => ({
  WikiRenderer: ({ contentHtml }: { contentHtml: string }) => (
    <div data-testid="prose" dangerouslySetInnerHTML={{ __html: contentHtml }} />
  ),
  extractFootnoteIds: () => [],
}));
vi.mock('@/components/wiki/DrugMonographSidebar', () => ({
  DrugMonographSidebar: ({ section }: { section?: string }) => (
    <div data-testid="parameter-box">{section}</div>
  ),
}));
vi.mock('@/components/wiki/DrugMetadataHeader', () => ({
  DrugMetadataHeader: () => null,
}));
vi.mock('@/components/wiki/DrugAnalyticalMethods', () => ({
  DrugAnalyticalMethods: () => null,
}));
vi.mock('@/components/wiki/DrugSeedPromptButton', () => ({
  DrugSeedPromptButton: () => null,
}));
vi.mock('@/components/wiki/DrugReferencesList', () => ({
  DrugReferencesList: () => null,
}));
vi.mock('@/lib/useDrugBibliography', () => ({
  useDrugBibliography: () => ({
    ordered: null,
    bibliographyMap: new Map(),
    refsByParameter: {},
  }),
}));
vi.mock('@/lib/verificationLevelsApi', () => ({
  fetchFactVerificationLevels: () => Promise.resolve({}),
}));
vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEdits: () => Promise.resolve({ pendingEdits: [] }),
}));
vi.mock('@/lib/drugIndicatorsApi', () => ({
  fetchDrugIndicators: () => Promise.resolve({ comments: {} }),
  fetchWikiPageIndicators: () => Promise.resolve({ comments: {} }),
}));
// The drug row never resolves: the page must still say which drug it is.
vi.mock('@/lib/drugApi', () => ({
  fetchDrugByWikiDrugId: () => Promise.reject(new Error('unavailable')),
  drugRowToComponent: () => ({}),
}));

const page = {
  id: 3,
  slug: 'paracetamol',
  title: 'Paracetamol',
  content: {},
  contentHtml:
    '<section data-monograph-section="pk"><h2 data-monograph-section-title="pk">Farmakokinetikk</h2><p>PK text</p></section>' +
    '<section data-monograph-section="toxicity"><h2 data-monograph-section-title="toxicity">Toksisitet</h2><p>Tox text</p></section>',
  pageType: 'drug_monograph',
  drugCid: 7,
  entityId: null,
  parentId: null,
  updatedAt: '2026-09-02T10:00:00Z',
  updatedBy: null,
};

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/wiki/:slug/:tab?"
          element={
            <>
              <WikiPage />
              <Location />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WikiPage drug monograph tabs', () => {
  const originalDrugState = useDrugStore.getState();

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ page, ancestors: [], children: [] }),
        }),
      ),
    );
    vi.mocked(localStorage.getItem).mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useDrugStore.setState(originalDrugState);
  });

  it('names its own drug even while the header still shows another one', async () => {
    // The header reads the global active drug, which still describes the
    // monograph the reader came from until this page's row resolves.
    useDrugStore.setState({
      activeDrug: { id: '9', names: { nb: 'morfin' } } as never,
    });
    renderAt('/wiki/paracetamol/pharmacokinetics');

    expect(
      (await screen.findByTestId('monograph-drug-name')).textContent,
    ).toBe('Paracetamol');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'parameterGroups.pharmacokinetics',
      }),
    ).toBeInTheDocument();
  });

  it("shows only the tab's parameter box and prose", async () => {
    renderAt('/wiki/paracetamol/interpretive_concentrations');

    expect((await screen.findByTestId('parameter-box')).textContent).toBe(
      'interpretive_concentrations',
    );
    const prose = screen.getByTestId('prose');
    expect(prose.textContent).toContain('Tox text');
    expect(prose.textContent).not.toContain('PK text');
  });

  it('opens a bare monograph link on the tab a deep-linked parameter lives on', async () => {
    renderAt('/wiki/paracetamol?param=halfLife&view=history');

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/wiki/paracetamol/pharmacokinetics',
      ),
    );
  });
});
