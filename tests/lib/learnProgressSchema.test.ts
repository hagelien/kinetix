import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  learningQuestionAttempts,
  learningUnitProgress,
} from '../../db/schema.ts';

describe('Phase C learner-state schema', () => {
  it('learning_question_attempts has the expected columns', () => {
    const cols = getTableConfig(learningQuestionAttempts).columns.map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'unit_id',
        'question_index',
        'category',
        'cognitive_skill',
        'difficulty',
        'concepts',
        'correct',
        'selected_option_ids',
        'mode',
        'created_at',
      ]),
    );
  });

  it('learning_unit_progress carries rollup + SM-2 columns and a composite PK', () => {
    const config = getTableConfig(learningUnitProgress);
    const cols = config.columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'user_id',
        'unit_id',
        'attempts',
        'best_score_pct',
        'last_score_pct',
        'status',
        'review_reps',
        'review_ease',
        'review_interval_days',
        'next_review_at',
        'last_attempt_at',
        'created_at',
        'updated_at',
      ]),
    );
    const pkCols = config.primaryKeys[0]?.columns.map((c) => c.name).sort();
    expect(pkCols).toEqual(['unit_id', 'user_id']);
  });
});
