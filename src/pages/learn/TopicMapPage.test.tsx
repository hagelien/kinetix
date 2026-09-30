import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopicMapPage } from './TopicMapPage';
import type { LearningUnitListItem } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { fetchLearningUnits } = vi.hoisted(() => ({
  fetchLearningUnits: vi.fn(),
}));
vi.mock('@/lib/learnApi', () => ({ fetchLearningUnits }));

const units: LearningUnitListItem[] = [
  {
    id: 1,
    slug: 'vd',
    title: 'Volume of distribution',
    difficulty: 'board',
    domains: ['pharmacokinetics'],
    kind: 'unit',
  },
  {
    id: 2,
    slug: 'clearance',
    title: 'Clearance',
    difficulty: 'foundational',
    domains: ['pharmacokinetics'],
    kind: 'unit',
  },
  {
    id: 3,
    slug: 'receptors',
    title: 'Receptor binding',
    difficulty: 'foundational',
    domains: ['pharmacodynamics'],
    kind: 'unit',
  },
];

describe('TopicMapPage', () => {
  afterEach(() => vi.clearAllMocks());

  function renderPage() {
    return render(
      <MemoryRouter>
        <TopicMapPage />
      </MemoryRouter>,
    );
  }

  it('groups units under domain headings', async () => {
    fetchLearningUnits.mockResolvedValue(units);
    renderPage();

    expect(await screen.findByText('pharmacokinetics')).toBeInTheDocument();
    expect(screen.getByText('pharmacodynamics')).toBeInTheDocument();

    const pk = screen.getByText('pharmacokinetics').closest('section')!;
    expect(within(pk).getByText('Volume of distribution')).toBeInTheDocument();
    expect(within(pk).getByText('Clearance')).toBeInTheDocument();
  });

  it('orders units within a domain by difficulty rank', async () => {
    fetchLearningUnits.mockResolvedValue(units);
    renderPage();
    await screen.findByText('pharmacokinetics');

    const pk = screen.getByText('pharmacokinetics').closest('section')!;
    const titles = within(pk)
      .getAllByRole('link')
      .map((a) => a.textContent);
    // foundational (Clearance) before board (Volume of distribution)
    expect(titles[0]).toContain('Clearance');
    expect(titles[1]).toContain('Volume of distribution');
  });

  it('shows an error state when the fetch fails', async () => {
    fetchLearningUnits.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('learn.loadError')).toBeInTheDocument();
  });
});
