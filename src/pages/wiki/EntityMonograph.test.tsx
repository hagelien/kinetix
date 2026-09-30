/**
 * `/wiki/entity/:slug` fallback view: an entity with no monograph yet still
 * shows its own identity and linked drugs, and a slug change never leaves the
 * previous entity's name/links on screen under the new URL.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';
import { fireEvent } from '@testing-library/react';
import i18nApp from '@/i18n';
import { EntityMonograph } from './EntityMonograph';
import { fetchEntityMetabolismDrugs } from '@/lib/bioEntitiesApi';

vi.mock('@/lib/bioEntitiesApi', () => ({
  fetchEntityMetabolismDrugs: vi.fn(),
}));

function entityResponse(slug: string, symbol: string) {
  return {
    ok: true,
    json: async () => ({
      entity: {
        id: slug === 'cyp2c9' ? 1 : 2,
        slug,
        symbol,
        name: `Cytokrom P450 ${symbol.replace('CYP', '')}`,
        nameEn: null,
        organism: 'Homo sapiens',
        rank: 'gene',
        parentId: null,
        entityClass: 'CYP',
        externalIds: {},
        functions: ['metabolic_enzyme'],
      },
      // No monograph written yet — the fallback view renders.
      monographSlug: null,
    }),
  } as unknown as Response;
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/wiki/entity/:slug" element={<EntityMonograph />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EntityMonograph fallback (no monograph yet)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(fetchEntityMetabolismDrugs).mockResolvedValue([]);
    await i18nApp.changeLanguage('en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the entity instead of dead-ending on the missing-monograph line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(entityResponse('cyp2c9', 'CYP2C9')),
    );
    renderAt('/wiki/entity/cyp2c9');

    expect(
      await screen.findByRole('heading', { name: 'CYP2C9' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Cytokrom P450 2C9')).toBeInTheDocument();
    expect(screen.getByText(/no monograph yet/i)).toBeInTheDocument();
  });

  it('drops the previous entity while the next slug resolves', async () => {
    // The second lookup never settles, so whatever is on screen after the
    // navigation is state the component carried over from the first slug.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(entityResponse('cyp2c9', 'CYP2C9'))
      .mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    // Client-side navigation between two `/wiki/entity/:slug` URLs keeps the
    // same component instance and only changes the param.
    render(
      <MemoryRouter initialEntries={['/wiki/entity/cyp2c9']}>
        <NavigateButton to="/wiki/entity/cyp2d6" />
        <Routes>
          <Route path="/wiki/entity/:slug" element={<EntityMonograph />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'CYP2C9' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await waitFor(() =>
      expect(screen.getByText(/loading/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('heading', { name: 'CYP2C9' })).toBeNull();
  });
});
