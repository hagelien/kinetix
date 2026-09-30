import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyPathPage } from './MyPathPage';
import type { LearnProgress, Recommendation } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { fetchProgress, fetchMyPath } = vi.hoisted(() => ({
  fetchProgress: vi.fn(),
  fetchMyPath: vi.fn(),
}));
vi.mock('@/lib/learnApi', () => ({
  fetchProgress,
  fetchMyPath,
}));

const progress: LearnProgress = {
  units: [],
  competence: {
    dimensions: [
      { dimension: 'factual_knowledge', accuracyPct: 80, sampleCount: 5 },
      { dimension: 'critical_appraisal', accuracyPct: null, sampleCount: 0 },
      { dimension: 'statistical_reasoning', accuracyPct: 40, sampleCount: 3 },
      { dimension: 'clinical_reasoning', accuracyPct: 60, sampleCount: 2 },
    ],
    retention: { accuracyPct: null, sampleCount: 0 },
  },
  dueReviewCount: 0,
};

const recommendations: Recommendation[] = [
  {
    unitId: 1,
    title: 'Clearance',
    difficulty: 'foundational',
    domains: ['pharmacokinetics'],
    reasonCode: 'targets_weakness',
    prerequisiteWarning: ['half_life'],
  },
];

describe('MyPathPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders recommendations with reason text and the competence profile', async () => {
    fetchProgress.mockResolvedValue(progress);
    fetchMyPath.mockResolvedValue(recommendations);
    render(
      <MemoryRouter>
        <MyPathPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Clearance')).toBeInTheDocument();
    expect(screen.getByText('learn.reason.targets_weakness')).toBeInTheDocument();
    expect(
      screen.getByText('learn.path.prerequisiteWarning'),
    ).toBeInTheDocument();
    // Competence profile rendered alongside
    expect(screen.getByText('learn.competence.title')).toBeInTheDocument();
  });

  it('shows the empty state when there are no recommendations', async () => {
    fetchProgress.mockResolvedValue(progress);
    fetchMyPath.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <MyPathPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('learn.path.empty')).toBeInTheDocument();
  });
});
