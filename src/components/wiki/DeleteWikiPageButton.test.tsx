import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteWikiPageButton } from './DeleteWikiPageButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const can = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/usePermissions', () => ({ useCan: () => can.value }));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

function renderButton(
  over: { pageType?: string; entityId?: number | null } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/wiki/sedativer']}>
      <Routes>
        <Route
          path="/wiki/:slug"
          element={
            <DeleteWikiPageButton
              slug="sedativer"
              title="Sedativer"
              pageType={over.pageType ?? 'topic'}
              entityId={over.entityId ?? null}
            />
          }
        />
        <Route path="/wiki" element={<p>wiki home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeleteWikiPageButton', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    can.value = true;
    fetchMock.mockReset();
    showToast.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is hidden from callers without the delete capability', () => {
    can.value = false;
    renderButton();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is not offered on a monograph that belongs to a drug or bio entity', () => {
    renderButton({ pageType: 'drug_monograph' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is not offered on a bio-entity monograph whose entity still exists', () => {
    renderButton({ pageType: 'entity_monograph', entityId: 4 });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is offered on a bio-entity monograph left behind by its deleted entity', () => {
    renderButton({ pageType: 'entity_monograph', entityId: null });
    expect(screen.getByRole('button', { name: 'wiki.deletePage' })).toBeTruthy();
  });

  it('does nothing when the confirmation is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'wiki.deletePage' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes the page and returns to the wiki home once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: true });
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'wiki.deletePage' }));
    await waitFor(() => expect(screen.getByText('wiki home')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/wiki/pages?slug=sedativer', {
      method: 'DELETE',
    });
  });

  it('stays on the page and reports a failed delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'wiki.deletePage' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('wiki.deletePageError'),
    );
    expect(screen.getByRole('button', { name: 'wiki.deletePage' })).toBeTruthy();
  });
});
