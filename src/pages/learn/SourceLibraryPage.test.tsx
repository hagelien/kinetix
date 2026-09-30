import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceLibraryPage } from './SourceLibraryPage';
import type { LearningUnitListItem } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { fetchLearningUnits } = vi.hoisted(() => ({
  fetchLearningUnits: vi.fn(),
}));
vi.mock('@/lib/learnApi', () => ({
  fetchLearningUnits,
}));

const units: LearningUnitListItem[] = [
  {
    id: 1,
    slug: 'vd',
    title: 'Volume of distribution',
    difficulty: 'foundational',
    domains: ['pharmacokinetics'],
    kind: 'unit',
  },
  {
    id: 2,
    slug: 'clearance',
    title: 'Clearance',
    difficulty: 'board',
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

describe('SourceLibraryPage', () => {
  afterEach(() => vi.clearAllMocks());

  function renderPage() {
    return render(
      <MemoryRouter>
        <SourceLibraryPage />
      </MemoryRouter>,
    );
  }

  it('lists all published units', async () => {
    fetchLearningUnits.mockResolvedValue(units);
    renderPage();
    expect(await screen.findByText('Volume of distribution')).toBeInTheDocument();
    expect(screen.getByText('Clearance')).toBeInTheDocument();
    expect(screen.getByText('Receptor binding')).toBeInTheDocument();
  });

  it('narrows the list by difficulty', async () => {
    fetchLearningUnits.mockResolvedValue(units);
    renderPage();
    await screen.findByText('Volume of distribution');

    const difficultySelect = screen.getByRole('combobox', {
      name: /learn.filter.difficulty/,
    });
    fireEvent.change(difficultySelect, { target: { value: 'board' } });

    await waitFor(() => {
      expect(screen.queryByText('Volume of distribution')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Clearance')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchLearningUnits.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('learn.loadError')).toBeInTheDocument();
  });
});
