import { describe, expect, it } from 'vitest';
import {
  aggregateCompetence,
  type AttemptLike,
} from '../../api/_lib/learn-competence.ts';

function a(partial: Partial<AttemptLike>): AttemptLike {
  return {
    category: 'factual',
    cognitiveSkill: null,
    correct: true,
    mode: 'submit_all',
    ...partial,
  };
}

describe('aggregateCompetence', () => {
  it('aggregates per-dimension accuracy via the skill tag', () => {
    const profile = aggregateCompetence([
      a({ cognitiveSkill: 'statistical_reasoning', correct: true }),
      a({ cognitiveSkill: 'statistical_reasoning', correct: false }),
      a({ cognitiveSkill: 'critical_appraisal', correct: true }),
    ]);
    const stat = (d: string) =>
      profile.dimensions.find((x) => x.dimension === d)!;
    expect(stat('statistical_reasoning').accuracyPct).toBe(50);
    expect(stat('statistical_reasoning').sampleCount).toBe(2);
    expect(stat('critical_appraisal').accuracyPct).toBe(100);
  });

  it('falls back to category for untagged questions', () => {
    const profile = aggregateCompetence([
      a({ cognitiveSkill: null, category: 'factual', correct: true }),
      a({ cognitiveSkill: null, category: 'reasoned', correct: false }),
    ]);
    const stat = (d: string) =>
      profile.dimensions.find((x) => x.dimension === d)!;
    expect(stat('factual_knowledge').accuracyPct).toBe(100);
    expect(stat('clinical_reasoning').accuracyPct).toBe(0);
  });

  it('reports null accuracy for dimensions with no samples', () => {
    const profile = aggregateCompetence([
      a({ cognitiveSkill: 'factual_recall', correct: true }),
    ]);
    expect(
      profile.dimensions.find((x) => x.dimension === 'critical_appraisal')!
        .accuracyPct,
    ).toBeNull();
    expect(profile.retention.accuracyPct).toBeNull();
  });

  it('measures retention from review-mode attempts only', () => {
    const profile = aggregateCompetence([
      a({ mode: 'review', correct: true }),
      a({ mode: 'review', correct: false }),
      a({ mode: 'submit_all', correct: true }),
    ]);
    expect(profile.retention.sampleCount).toBe(2);
    expect(profile.retention.accuracyPct).toBe(50);
  });
});
