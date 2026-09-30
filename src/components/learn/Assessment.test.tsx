import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Assessment } from './Assessment';
import type { LearningQuestion } from '@/lib/learnContent';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { submitAttempt } = vi.hoisted(() => ({ submitAttempt: vi.fn() }));
vi.mock('@/lib/learnApi', () => ({ submitAttempt }));

afterEach(() => vi.clearAllMocks());

const questions: LearningQuestion[] = [
  {
    stem: 'Single best question',
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
  {
    stem: 'Select all question',
    format: 'select_all',
    category: 'reasoned',
    difficulty: 'board',
    concepts: [],
    sourceSupport: 'p.2',
    options: [
      { id: 'a', text: 'One', isCorrect: true, explanation: 'yes one' },
      { id: 'b', text: 'Two', isCorrect: true, explanation: 'yes two' },
      { id: 'c', text: 'Three', isCorrect: false, explanation: 'no three' },
    ],
  },
];

describe('Assessment', () => {
  it('submit-all mode grades every question and shows explanations', () => {
    render(<Assessment questions={questions} />);

    // Answer Q0 correctly (radio a) and Q1 partially (checkbox a only -> wrong)
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    fireEvent.click(screen.getByText('learn.assessment.submit'));

    // Score badge + per-question verdicts
    expect(screen.getByText('learn.assessment.score')).toBeInTheDocument();
    expect(
      screen.getAllByText('learn.assessment.correct').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('learn.assessment.incorrect').length,
    ).toBeGreaterThanOrEqual(1);
    // Wrong option's explanation is revealed (§7.6)
    expect(screen.getByText('no wrong')).toBeInTheDocument();
  });

  it('one-at-a-time mode reveals feedback and gates the next question', () => {
    render(<Assessment questions={questions} />);
    fireEvent.click(screen.getByText('learn.assessment.modeOneAtATime'));

    // Only the first question is shown
    expect(screen.getByText('Single best question')).toBeInTheDocument();
    expect(screen.queryByText('Select all question')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByText('learn.assessment.check'));

    // Feedback appears, Q2 still gated until advancing
    expect(screen.getByText('no wrong')).toBeInTheDocument();
    expect(screen.getByText('learn.assessment.next')).toBeInTheDocument();
    expect(screen.queryByText('Select all question')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('learn.assessment.next'));
    expect(screen.getByText('Select all question')).toBeInTheDocument();
  });

  it('persists the attempt on submit when a unitId is provided', async () => {
    submitAttempt.mockResolvedValue({
      scorePct: 50,
      status: 'completed',
      nextReviewAt: null,
      perQuestion: [],
    });
    render(<Assessment questions={questions} unitId={7} />);

    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByText('learn.assessment.submit'));

    await waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(1));
    expect(submitAttempt).toHaveBeenCalledWith({
      unitId: 7,
      mode: 'submit_all',
      answers: { 0: ['a'] },
    });
    expect(await screen.findByText('learn.assessment.saved')).toBeInTheDocument();
  });

  it('still shows the local score when persistence fails', async () => {
    submitAttempt.mockRejectedValue(new Error('network'));
    render(<Assessment questions={questions} unitId={7} />);

    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByText('learn.assessment.submit'));

    // Local feedback is unaffected by the failed save.
    expect(screen.getByText('learn.assessment.score')).toBeInTheDocument();
    expect(
      await screen.findByText('learn.assessment.saveError'),
    ).toBeInTheDocument();
  });

  it('does not persist when no unitId is given', () => {
    render(<Assessment questions={questions} />);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByText('learn.assessment.submit'));
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no questions', () => {
    render(<Assessment questions={[]} />);
    expect(screen.getByText('learn.assessment.empty')).toBeInTheDocument();
  });
});
