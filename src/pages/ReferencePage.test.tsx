import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import i18n from 'i18next';
import { ReferencePage } from './ReferencePage';

const fetchMock = vi.fn();

function renderPage(path = '/references/12') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/references/:referenceId" element={<ReferencePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReferencePage', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('nb');
  });

  const referenceRow = {
    id: 12,
    drugId: null,
    type: 'doi',
    identifier: '10.1093/jat/bkaa044',
    metadata: {
      title: 'Forensic toxicology reference ranges',
      authors: ['Huertas T', 'Smith A'],
      journal: 'Journal of Analytical Toxicology',
      year: 2020,
    },
    createdAt: '2026-05-01T00:00:00.000Z',
  };

  function mockEndpoints(review: unknown, usage: unknown[] = []) {
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.includes('/api/paper-reviews')) {
        return Promise.resolve({ ok: true, json: async () => ({ review }) });
      }
      if (url.includes('view=usage')) {
        return Promise.resolve({ ok: true, json: async () => ({ usage }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ reference: referenceRow }),
      });
    });
  }

  it('renders reference metadata, source link, and empty agent review state', async () => {
    mockEndpoints(null);

    renderPage();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Forensic toxicology reference ranges',
    );
    expect(screen.queryByRole('link', { name: /back to wiki/i })).toBeNull();
    expect(screen.getByText('Huertas & Smith, 2020')).toBeTruthy();
    expect(screen.getByText('Huertas T, Smith A')).toBeTruthy();
    expect(screen.getByText('Journal of Analytical Toxicology')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open source/i })).toHaveAttribute(
      'href',
      'https://doi.org/10.1093/jat/bkaa044',
    );
    expect(
      screen.getByText(
        'No agent review has been recorded for this reference yet.',
      ),
    ).toBeTruthy();
  });

  it('renders the paper takeaway before score metadata when a review exists', async () => {
    mockEndpoints({
      id: 1,
      citationId: 12,
      reviewMarkdown: '## Hovedpoeng\n\nStudien er **solid**.',
      overallScore: 78,
      conclusionSupport: 'stort sett støttet',
      reviewConfidence: 'high',
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    renderPage();

    const takeaway = await screen.findByRole('heading', { name: 'Hovedpoeng' });
    const score = screen.getByText('78/100');
    expect(takeaway.compareDocumentPosition(score) & 4).toBe(4);
    expect(screen.getByText('stort sett støttet')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(
      screen.queryByText(
        'No agent review has been recorded for this reference yet.',
      ),
    ).toBeNull();
  });

  it('surfaces paper-review fetch failures separately from empty reviews', async () => {
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.includes('/api/paper-reviews')) {
        return Promise.resolve({ ok: false, status: 502 });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ reference: referenceRow }),
      });
    });

    renderPage();

    expect(
      await screen.findByText("Couldn't load the agent review."),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'No agent review has been recorded for this reference yet.',
      ),
    ).toBeNull();
  });

  it('lists the monographs and wiki pages that cite the reference', async () => {
    mockEndpoints(null, [
      {
        kind: 'drug',
        id: 5,
        slug: 'diazepam',
        names: { nb: 'Diazepam', en: 'Diazepam' },
        href: '/wiki/drug/5',
      },
      {
        kind: 'wiki',
        id: 9,
        slug: 'half-life',
        title: 'Half-life',
        pageType: 'topic',
        href: '/wiki/half-life',
      },
    ]);

    renderPage();

    const drugLink = await screen.findByRole('link', { name: /^diazepam$/i });
    expect(drugLink).toHaveAttribute('href', '/wiki/drug/5');
    const wikiLink = screen.getByRole('link', { name: 'Half-life' });
    expect(wikiLink).toHaveAttribute('href', '/wiki/half-life');
  });

  it('shows an empty cited-in state when the reference is unused', async () => {
    mockEndpoints(null, []);

    renderPage();

    expect(
      await screen.findByText(
        'This reference is not cited by any monograph or wiki page yet.',
      ),
    ).toBeTruthy();
  });
});
