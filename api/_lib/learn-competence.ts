/**
 * Competence aggregation for Kinetix Learn (Phase C).
 *
 * Pure and DB-free: turns a flat list of question attempts into a per-dimension
 * accuracy profile (spec §8). The four skill dimensions are measured from
 * question accuracy via the cognitive-skill tag (falling back to category for
 * legacy questions); retention is measured from spaced-review (mode='review')
 * recall. Preference is a declared user setting and is attached by the caller.
 *
 * The skill→dimension map mirrors src/lib/learnContent.ts `cognitiveSkillToDimension`
 * (duplicated intentionally — api/ cannot import from src/).
 */

export type SkillDimension =
  | 'factual_knowledge'
  | 'critical_appraisal'
  | 'statistical_reasoning'
  | 'clinical_reasoning';

export const SKILL_DIMENSIONS: readonly SkillDimension[] = [
  'factual_knowledge',
  'critical_appraisal',
  'statistical_reasoning',
  'clinical_reasoning',
];

export interface DimensionStat {
  dimension: SkillDimension;
  /** Rounded accuracy 0–100, or null when no attempts have measured it yet. */
  accuracyPct: number | null;
  sampleCount: number;
}

export interface CompetenceProfile {
  dimensions: DimensionStat[];
  retention: { accuracyPct: number | null; sampleCount: number };
}

export interface AttemptLike {
  category: string;
  cognitiveSkill: string | null;
  correct: boolean;
  mode: string;
}

export function skillToDimension(
  skill: string | null,
  category: string,
): SkillDimension {
  switch (skill) {
    case 'factual_recall':
      return 'factual_knowledge';
    case 'critical_appraisal':
      return 'critical_appraisal';
    case 'statistical_reasoning':
      return 'statistical_reasoning';
    case 'clinical_reasoning':
    case 'mechanistic':
      return 'clinical_reasoning';
    default:
      return category === 'factual'
        ? 'factual_knowledge'
        : 'clinical_reasoning';
  }
}

function pct(correct: number, total: number): number | null {
  return total === 0 ? null : Math.round((100 * correct) / total);
}

export function aggregateCompetence(
  attempts: readonly AttemptLike[],
): CompetenceProfile {
  const tally = new Map<SkillDimension, { correct: number; total: number }>();
  for (const d of SKILL_DIMENSIONS) tally.set(d, { correct: 0, total: 0 });

  let reviewCorrect = 0;
  let reviewTotal = 0;

  for (const a of attempts) {
    const entry = tally.get(skillToDimension(a.cognitiveSkill, a.category))!;
    entry.total += 1;
    if (a.correct) entry.correct += 1;
    if (a.mode === 'review') {
      reviewTotal += 1;
      if (a.correct) reviewCorrect += 1;
    }
  }

  return {
    dimensions: SKILL_DIMENSIONS.map((dimension) => {
      const e = tally.get(dimension)!;
      return {
        dimension,
        accuracyPct: pct(e.correct, e.total),
        sampleCount: e.total,
      };
    }),
    retention: {
      accuracyPct: pct(reviewCorrect, reviewTotal),
      sampleCount: reviewTotal,
    },
  };
}
