import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPage } from './ReviewPage';
import type { LearnProgress, LearningUnitListItem } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { fetchProgress, fetchLearningUnits, fetchLearningUnit } = vi.hoisted(
  () => ({
    fetchProgress: vi.fn(),
    fetchLearningUnits: vi.fn(),
    fetchLearningUnit: vi.fn(),
  }),
);
vi.mock('@/lib/learnApi', () => ({
  fetchProgress,
  fetchLearningUnits,
  fetchLearningUnit,
}));
// Assessment imports submitAttempt from learnApi; not used in these tests.

const list: LearningUnitListItem[] = [
  { id: 1, slug: 'a', title: 'Clearance', difficulty: 'foundational', domains: [], kind: 'unit' },
  { id: 2, slug: 'b', title: 'Half-life', difficulty: 'board', domains: [], kind: 'unit' },
];

const cases: LearningUnitListItem[] = [
  { id: 9, slug: 'c', title: 'Dosering ved nyresvikt', difficulty: 'advanced_lis', domains: [], kind: 'clinical_case' },
];

// Route the two fetchLearningUnits calls (units vs cases) by their kind param.
function routeUnitsAndCases(
  unitList: LearningUnitListItem[],
  caseList: LearningUnitListItem[],
) {
  fetchLearningUnits.mockImplementation((params?: { kind?: string }) =>
    Promise.resolve(params?.kind === 'clinical_case' ? caseList : unitList),
  );
}

function progressWith(nextReviewAts: Record<number, string | null>): LearnProgress {
  return {
    units: Object.entries(nextReviewAts).map(([unitId, nextReviewAt]) => ({
      unitId: Number(unitId),
      attempts: 1,
      bestScorePct: 80,
      lastScorePct: 80,
      status: 'completed',
      nextReviewAt,
    })),
    competence: { dimensions: [], retention: { accuracyPct: null, sampleCount: 0 } },
    dueReviewCount: 0,
  };
}

describe('ReviewPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('lists units that are due for review', async () => {
    routeUnitsAndCases(list, []);
    fetchProgress.mockResolvedValue(
      progressWith({ 1: '2000-01-01T00:00:00.000Z', 2: '2999-01-01T00:00:00.000Z' }),
    );
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
    // Unit 1 is due (past), unit 2 is not (future)
    expect(await screen.findByText('Clearance')).toBeInTheDocument();
    expect(screen.queryByText('Half-life')).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing is due', async () => {
    routeUnitsAndCases(list, []);
    fetchProgress.mockResolvedValue(
      progressWith({ 1: '2999-01-01T00:00:00.000Z' }),
    );
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('learn.review.empty')).toBeInTheDocument();
  });

  it('lists published clinical cases with a link to the case', async () => {
    routeUnitsAndCases(list, cases);
    fetchProgress.mockResolvedValue(progressWith({}));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', {
      name: 'learn.review.casesOpen',
    });
    expect(screen.getByText('Dosering ved nyresvikt')).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/learn/unit/9');
  });

  it('shows the cases empty state when no clinical cases exist', async () => {
    routeUnitsAndCases(list, []);
    fetchProgress.mockResolvedValue(progressWith({}));
    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('learn.review.casesEmpty'),
    ).toBeInTheDocument();
  });
});
