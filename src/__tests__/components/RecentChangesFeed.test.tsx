import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecentChangesFeed } from '@/components/RecentChangesFeed';
import { fetchRecentChanges } from '@/lib/recentChangesApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
  Trans: ({
    values,
    components,
  }: {
    i18nKey: string;
    values: Record<string, string>;
    components: Record<string, ReactElement>;
  }) => {
    const link = Object.values(components ?? {})[0];
    const linkText = values.drug ?? values.page;
    return (
      <>
        {values.parameter ? `${values.parameter}: ` : ''}
        {link ? cloneElement(link, {}, linkText) : linkText}
      </>
    );
  },
}));

vi.mock('@/lib/recentChangesApi', () => ({
  fetchRecentChanges: vi.fn(),
}));

function renderFeed() {
  return render(
    <MemoryRouter>
      <RecentChangesFeed />
    </MemoryRouter>,
  );
}

const author = {
  username: 'alice',
  displayName: 'Alice',
  role: 'editor',
  isAgent: false,
};

describe('RecentChangesFeed', () => {
  const fetchMock = vi.mocked(fetchRecentChanges);

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state, then the merged feed', async () => {
    fetchMock.mockResolvedValue({
      changes: [
        {
          type: 'drug_parameter',
          id: 1,
          parameter: 'halfLife',
          editSummary: null,
          createdAt: '2026-09-18T10:00:00Z',
          drug: { id: 1, names: { en: 'Diazepam' }, nameShort: null },
          author,
        },
        {
          type: 'wiki',
          id: 10,
          editSummary: 'Clarify metabolism',
          createdAt: '2026-09-18T09:00:00Z',
          page: { slug: 'diazepam-metabolism', title: 'Diazepam metabolism' },
          author,
        },
      ],
    });

    renderFeed();

    expect(screen.getByText('recentChanges.loading')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByText('recentChanges.loading')).toBeNull(),
    );

    const drugLink = screen.getByRole('link', { name: 'diazepam' });
    expect(drugLink).toHaveAttribute('href', '/wiki/drug/1');

    const pageLink = screen.getByRole('link', {
      name: 'Diazepam metabolism',
    });
    expect(pageLink).toHaveAttribute('href', '/wiki/diazepam-metabolism');

    expect(screen.getAllByText('Alice').length).toBe(2);
  });

  it('falls back to the slug link for a stale, pre-deploy cached response with no drug id', async () => {
    fetchMock.mockResolvedValue({
      changes: [
        {
          type: 'drug_parameter',
          id: 1,
          parameter: 'halfLife',
          editSummary: null,
          createdAt: '2026-09-18T10:00:00Z',
          drug: { slug: 'diazepam', names: { en: 'Diazepam' }, nameShort: null },
          author,
        },
      ],
    });

    renderFeed();

    await waitFor(() =>
      expect(screen.queryByText('recentChanges.loading')).toBeNull(),
    );

    const drugLink = screen.getByRole('link', { name: 'diazepam' });
    expect(drugLink).toHaveAttribute('href', '/wiki/diazepam');
  });

  it('lists a source value and a revision that share an id as separate rows', async () => {
    fetchMock.mockResolvedValue({
      changes: [
        {
          type: 'drug_parameter',
          origin: 'source_value',
          id: 7,
          parameter: 'dispositionModel',
          editSummary: null,
          createdAt: '2026-10-04T08:44:00Z',
          drug: { id: 2, names: { en: 'Clonazepam' }, nameShort: null },
          author,
        },
        {
          type: 'drug_parameter',
          origin: 'revision',
          id: 7,
          parameter: 'halfLife',
          editSummary: null,
          createdAt: '2026-10-01T06:00:00Z',
          drug: { id: 1, names: { en: 'Diazepam' }, nameShort: null },
          author,
        },
      ],
    });

    renderFeed();

    await waitFor(() =>
      expect(screen.queryByText('recentChanges.loading')).toBeNull(),
    );

    expect(screen.getByRole('link', { name: 'clonazepam' })).toHaveAttribute(
      'href',
      '/wiki/drug/2',
    );
    expect(screen.getByRole('link', { name: 'diazepam' })).toHaveAttribute(
      'href',
      '/wiki/drug/1',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows an empty state when there are no changes yet', async () => {
    fetchMock.mockResolvedValue({ changes: [] });

    renderFeed();

    await waitFor(() =>
      expect(screen.getByText('recentChanges.empty')).toBeInTheDocument(),
    );
  });

  it('shows an error state when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));

    renderFeed();

    await waitFor(() =>
      expect(screen.getByText('recentChanges.error')).toBeInTheDocument(),
    );
  });
});
