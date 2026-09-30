import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningUnitPage } from './LearningUnitPage';
import type { LearningUnitDetail } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { fetchLearningUnit } = vi.hoisted(() => ({
  fetchLearningUnit: vi.fn(),
}));
vi.mock('@/lib/learnApi', () => ({ fetchLearningUnit }));

const detail: LearningUnitDetail = {
  id: 1,
  slug: 'vd',
  title: 'Volume of distribution',
  difficulty: 'foundational',
  domains: ['pharmacokinetics'],
  kind: 'unit',
  source: {
    citationId: 10,
    type: 'doi',
    identifier: '10.1/x',
    url: 'https://doi.org/10.1/x',
    metadata: { title: 'Original paper' },
  },
  content: {
    sourceCard: {
      whyItMatters: 'It matters a lot.',
      sourceStatus: ['foundational'],
      estimatedReadingMinutes: 20,
    },
    prerequisites: [
      { concept: 'Clearance', level: 'essential', why: 'needed' },
    ],
    preReadingPrompts: ['Prompt one', 'Prompt two', 'Prompt three'],
    objectives: ['Understand VD'],
    questions: [
      {
        stem: 'Which is correct?',
        format: 'single_best',
        category: 'factual',
        difficulty: 'foundational',
        concepts: [],
        sourceSupport: 'p.1',
        options: [
          { id: 'a', text: 'Right', isCorrect: true, explanation: 'yes right' },
          { id: 'b', text: 'Wrong', isCorrect: false, explanation: 'no wrong' },
        ],
      },
    ],
  },
};

function renderAt(path = '/learn/unit/1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learn/unit/:id" element={<LearningUnitPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LearningUnitPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the full unit: source card, prerequisites, prompts, objectives, assessment', async () => {
    fetchLearningUnit.mockResolvedValue(detail);
    renderAt();

    expect(await screen.findByText('Volume of distribution')).toBeInTheDocument();
    expect(screen.getByText('Original paper')).toBeInTheDocument();
    expect(screen.getByText('Clearance')).toBeInTheDocument();
    expect(screen.getByText('Prompt one')).toBeInTheDocument();
    expect(screen.getByText('Understand VD')).toBeInTheDocument();
    expect(screen.getByText('learn.assessment.title')).toBeInTheDocument();
    expect(fetchLearningUnit).toHaveBeenCalledWith(1);
  });

  it('renders a clinical case: safety notice + scenario + assessment, no source card', async () => {
    const caseDetail: LearningUnitDetail = {
      id: 2,
      slug: 'klinisk-case',
      title: 'Klinisk case om dosering',
      difficulty: 'advanced_lis',
      domains: ['pharmacokinetics'],
      kind: 'clinical_case',
      source: null,
      content: {
        safetyNotice: 'Kun til opplæring — ikke pasientspesifikke kliniske råd.',
        scenario: 'En fiktiv pasient presenterer med uventede symptomer.',
        prerequisites: [
          { concept: 'Clearance', level: 'essential', why: 'needed' },
        ],
        objectives: ['Anvend retningslinjen'],
        questions: detail.content.questions,
      },
    };
    fetchLearningUnit.mockResolvedValue(caseDetail);
    renderAt('/learn/unit/2');

    expect(
      await screen.findByText('Klinisk case om dosering'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Kun til opplæring — ikke pasientspesifikke kliniske råd.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('En fiktiv pasient presenterer med uventede symptomer.'),
    ).toBeInTheDocument();
    expect(screen.getByText('learn.assessment.title')).toBeInTheDocument();
    // A clinical case must NOT render the unit-only source-card heading.
    expect(screen.queryByText('learn.sourceCard.heading')).toBeNull();
  });

  it('shows a not-found message on a 404', async () => {
    fetchLearningUnit.mockRejectedValue(
      Object.assign(new Error('Learning unit not found'), { status: 404 }),
    );
    renderAt('/learn/unit/999');
    expect(await screen.findByText('learn.notFound')).toBeInTheDocument();
  });
});
