import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { useAuthStore } from '@/stores/authStore';
import type { MethodComponentRow, MethodDetail } from '@/lib/drugApi';
import { MethodDetailPage } from './MethodDetailPage';

const fetchMock = vi.fn();

function component(
  drugId: number,
  nb: string,
  extra: Partial<MethodComponentRow> = {},
): MethodComponentRow {
  return {
    drugId,
    lor: 0.1,
    mkk: null,
    lod: 0.05,
    unit: 'µmol/l',
    measurementUncertainty: null,
    sortOrder: drugId,
    slug: `drug-${drugId}`,
    names: { nb },
    nameShort: null,
    pubchemCid: null,
    molecularWeight: null,
    ...extra,
  };
}

function methodWith(components: MethodComponentRow[]): MethodDetail {
  return {
    id: 9002,
    code: '9002',
    name: 'SYNTHETIC LC-MS/MS PANEL B',
    description: null,
    matrices: ['blood'],
    volumeMl: 0.1,
    methodType: 'screening',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    components,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/methods/9002']}>
      <Routes>
        <Route path="/methods/:id" element={<MethodDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Component names as rendered, in row order. */
async function renderedNames(): Promise<string[]> {
  const rows = await screen.findAllByRole('row');
  return rows
    .slice(1) // drop the header row
    .map((row) => row.querySelector('a')?.textContent?.trim() ?? '');
}

describe('MethodDetailPage', () => {
  const originalAuth = useAuthStore.getState();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.setState({
      ...originalAuth,
      user: {
        ...(originalAuth.user ?? {}),
        id: 1,
        email: 'admin@example.com',
        role: 'admin',
      },
    } as never);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalAuth, true);
    await i18n.changeLanguage('nb');
  });

  function mockMethod(method: MethodDetail) {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => ({ method }) }),
    );
  }

  it('lists components alphabetically rather than in stored order', async () => {
    mockMethod(
      methodWith([
        component(1, 'paracetamol'),
        component(2, 'baklofen'),
        component(3, 'olanzapin'),
        component(4, 'gabapentin'),
      ]),
    );

    renderPage();

    expect(await renderedNames()).toEqual([
      'baklofen',
      'gabapentin',
      'olanzapin',
      'paracetamol',
    ]);
  });

  it('orders numbered metabolites numerically and Nordic letters last', async () => {
    mockMethod(
      methodWith([
        component(1, 'øksazepam'),
        component(2, '10-OH-karbazepin (MHD)'),
        component(3, 'zopiklon'),
        component(4, '7-aminoklonazepam'),
      ]),
    );

    renderPage();

    expect(await renderedNames()).toEqual([
      '7-aminoklonazepam',
      '10-OH-karbazepin (MHD)',
      'zopiklon',
      'øksazepam',
    ]);
  });

  it('sorts by the localized name, so switching language re-sorts', async () => {
    await i18n.changeLanguage('en');
    mockMethod(
      methodWith([
        component(1, 'paracetamol', {
          names: { nb: 'paracetamol', en: 'acetaminophen' },
        }),
        component(2, 'kodein', { names: { nb: 'kodein', en: 'codeine' } }),
      ]),
    );

    renderPage();

    expect(await renderedNames()).toEqual(['acetaminophen', 'codeine']);
  });
});
