import { describe, expect, it } from 'vitest';
import {
  rankRecommendations,
  summarizeUnitForRanking,
  type RankUnit,
  type UnitProgress,
} from '../../api/_lib/learn-my-path.ts';
import type { LearningUnitContent } from '../../api/_lib/schemas.ts';

const NOW = new Date('2026-06-23T00:00:00.000Z');

function unit(partial: Partial<RankUnit>): RankUnit {
  return {
    id: 1,
    difficulty: 'foundational',
    domains: [],
    essentialPrereqConcepts: [],
    dominantDimension: null,
    ...partial,
  };
}

function base() {
  return {
    progressByUnit: new Map<number, UnitProgress>(),
    evidencedConcepts: new Set<string>(),
    weakestDimension: null as null,
    demonstratedRank: 0,
    now: NOW,
  };
}

describe('rankRecommendations', () => {
  it('ranks a due-for-review unit first', () => {
    const units = [unit({ id: 1 }), unit({ id: 2 })];
    const progressByUnit = new Map<number, UnitProgress>([
      [2, { status: 'completed', nextReviewAt: new Date('2026-06-20'), bestScorePct: 80 }],
    ]);
    const recs = rankRecommendations({ ...base(), units, progressByUnit });
    expect(recs[0]!.unitId).toBe(2);
    expect(recs[0]!.reasonCode).toBe('due_review');
  });

  it('targets the weakest dimension when nothing is due', () => {
    const units = [
      unit({ id: 1, dominantDimension: 'statistical_reasoning' }),
      unit({ id: 2, dominantDimension: 'factual_knowledge' }),
    ];
    const recs = rankRecommendations({
      ...base(),
      units,
      weakestDimension: 'statistical_reasoning',
    });
    expect(recs[0]!.unitId).toBe(1);
    expect(recs[0]!.reasonCode).toBe('targets_weakness');
  });

  it('still recommends a unit with an unmet essential prerequisite, with a warning', () => {
    const units = [unit({ id: 1, essentialPrereqConcepts: ['clearance'] })];
    const recs = rankRecommendations({
      ...base(),
      units,
      evidencedConcepts: new Set(),
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.prerequisiteWarning).toEqual(['clearance']);
  });

  it('drops mastered units unless they are due', () => {
    const units = [unit({ id: 1 })];
    const progressByUnit = new Map<number, UnitProgress>([
      [1, { status: 'mastered', nextReviewAt: null, bestScorePct: 100 }],
    ]);
    expect(rankRecommendations({ ...base(), units, progressByUnit })).toHaveLength(0);
  });
});

describe('summarizeUnitForRanking', () => {
  it('extracts essential prerequisites and the dominant dimension', () => {
    const content = {
      sourceCard: { whyItMatters: 'x', sourceStatus: ['foundational'], estimatedReadingMinutes: 10 },
      prerequisites: [
        { concept: 'clearance', level: 'essential', why: 'w' },
        { concept: 'binding', level: 'helpful', why: 'w' },
      ],
      preReadingPrompts: ['a', 'b', 'c'],
      objectives: ['o'],
      questions: [
        { stem: 'q', format: 'single_best', category: 'reasoned', difficulty: 'board', sourceSupport: 's', concepts: [], cognitiveSkill: 'statistical_reasoning', options: [] },
        { stem: 'q', format: 'single_best', category: 'reasoned', difficulty: 'board', sourceSupport: 's', concepts: [], cognitiveSkill: 'statistical_reasoning', options: [] },
        { stem: 'q', format: 'single_best', category: 'factual', difficulty: 'board', sourceSupport: 's', concepts: [], options: [] },
      ],
    } as unknown as LearningUnitContent;
    const summary = summarizeUnitForRanking(content);
    expect(summary.essentialPrereqConcepts).toEqual(['clearance']);
    expect(summary.dominantDimension).toBe('statistical_reasoning');
  });
});
