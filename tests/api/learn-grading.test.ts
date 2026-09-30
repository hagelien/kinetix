import { describe, expect, it } from 'vitest';
import { gradeUnitAttempt } from '../../api/_lib/learn-grading.ts';
import type { LearningUnitContent } from '../../api/_lib/schemas.ts';

function content(): LearningUnitContent {
  return {
    sourceCard: {
      whyItMatters: 'x',
      sourceStatus: ['foundational'],
      estimatedReadingMinutes: 10,
    },
    prerequisites: [],
    preReadingPrompts: ['a', 'b', 'c'],
    objectives: ['o'],
    questions: [
      {
        stem: 'single best',
        format: 'single_best',
        category: 'factual',
        difficulty: 'foundational',
        concepts: ['clearance'],
        sourceSupport: 's',
        options: [
          { id: 'a', text: 'A', isCorrect: true, explanation: 'because aaaa' },
          { id: 'b', text: 'B', isCorrect: false, explanation: 'because bbbb' },
        ],
      },
      {
        stem: 'select all',
        format: 'select_all',
        category: 'reasoned',
        difficulty: 'board',
        concepts: ['stats'],
        sourceSupport: 's',
        cognitiveSkill: 'statistical_reasoning',
        options: [
          { id: 'a', text: 'A', isCorrect: true, explanation: 'because aaaa' },
          { id: 'b', text: 'B', isCorrect: true, explanation: 'because bbbb' },
          { id: 'c', text: 'C', isCorrect: false, explanation: 'because cccc' },
        ],
      },
    ],
  } as LearningUnitContent;
}

describe('gradeUnitAttempt', () => {
  it('grades single-best and select-all with frozen tags', () => {
    const result = gradeUnitAttempt(content(), { 0: ['a'], 1: ['a'] });
    // Q0 correct (exact), Q1 partial -> incorrect
    expect(result.perQuestion).toHaveLength(2);
    const q0 = result.perQuestion.find((q) => q.questionIndex === 0)!;
    const q1 = result.perQuestion.find((q) => q.questionIndex === 1)!;
    expect(q0.correct).toBe(true);
    expect(q0.category).toBe('factual');
    expect(q0.cognitiveSkill).toBeNull();
    expect(q1.correct).toBe(false);
    expect(q1.cognitiveSkill).toBe('statistical_reasoning');
    expect(q1.difficulty).toBe('board');
    expect(result.scorePct).toBe(50);
  });

  it('counts a full select-all match as correct', () => {
    const result = gradeUnitAttempt(content(), { 1: ['a', 'b'] });
    expect(result.perQuestion[0]!.correct).toBe(true);
    expect(result.scorePct).toBe(100);
  });

  it('ignores out-of-range question indexes and scores 0 when nothing valid', () => {
    const result = gradeUnitAttempt(content(), { 9: ['a'] });
    expect(result.perQuestion).toHaveLength(0);
    expect(result.scorePct).toBe(0);
  });
});
