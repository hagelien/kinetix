/**
 * Transparent My Path recommendation engine for Kinetix Learn (Phase C, spec §8).
 *
 * Pure and deterministic — no ML. Each candidate unit is scored by a small set
 * of named, inspectable factors and tagged with the dominant reason code (the
 * FE renders it via i18n). Prerequisite gaps annotate a soft warning but never
 * exclude a unit (spec §5.2: no hard locks). Mastered units drop out of the
 * "next" pool unless they are due for spaced review.
 */
import { LEARNING_DIFFICULTIES, type LearningUnitContent } from './schemas.js';
import { skillToDimension, type SkillDimension } from './learn-competence.js';

// Scoring weights, highest priority first (see reasonCode resolution below).
const W_DUE_REVIEW = 1000;
const W_WEAKNESS = 100;
const W_NEXT_STEP = 50;
const W_AT_OR_BELOW_LEVEL = 10;
const PREREQ_GAP_PENALTY = 5;

export type ReasonCode =
  | 'due_review'
  | 'targets_weakness'
  | 'next_step'
  | 'recommended';

export interface RankUnit {
  id: number;
  difficulty: string;
  domains: string[];
  essentialPrereqConcepts: string[];
  dominantDimension: SkillDimension | null;
}

export interface UnitProgress {
  status: string;
  nextReviewAt: Date | null;
  bestScorePct: number;
}

export interface RankParams {
  units: readonly RankUnit[];
  progressByUnit: Map<number, UnitProgress>;
  evidencedConcepts: ReadonlySet<string>;
  weakestDimension: SkillDimension | null;
  demonstratedRank: number;
  now: Date;
}

export interface Recommendation {
  unitId: number;
  score: number;
  reasonCode: ReasonCode;
  prerequisiteWarning?: string[];
}

export function difficultyRank(difficulty: string): number {
  const i = (LEARNING_DIFFICULTIES as readonly string[]).indexOf(difficulty);
  return i === -1 ? LEARNING_DIFFICULTIES.length : i;
}

/**
 * Extract the ranking-relevant summary from a unit's content: its essential
 * prerequisite concepts and the dimension its questions predominantly test.
 */
export function summarizeUnitForRanking(content: LearningUnitContent): {
  essentialPrereqConcepts: string[];
  dominantDimension: SkillDimension | null;
} {
  const essentialPrereqConcepts = (content.prerequisites ?? [])
    .filter((p) => p.level === 'essential')
    .map((p) => p.concept);

  const counts = new Map<SkillDimension, number>();
  for (const q of content.questions ?? []) {
    const dim = skillToDimension(q.cognitiveSkill ?? null, q.category);
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }
  let dominantDimension: SkillDimension | null = null;
  let best = 0;
  for (const [dim, n] of counts) {
    if (n > best) {
      best = n;
      dominantDimension = dim;
    }
  }
  return { essentialPrereqConcepts, dominantDimension };
}

export function rankRecommendations(p: RankParams): Recommendation[] {
  const rankById = new Map(p.units.map((u) => [u.id, difficultyRank(u.difficulty)]));
  const recs: Recommendation[] = [];

  for (const u of p.units) {
    const prog = p.progressByUnit.get(u.id);
    const due = !!prog?.nextReviewAt && prog.nextReviewAt <= p.now;
    // Mastered units leave the "next" pool unless they're due for review.
    if (prog?.status === 'mastered' && !due) continue;

    let score = 0;
    let reasonCode: ReasonCode = 'recommended';

    if (due) {
      score += W_DUE_REVIEW;
      reasonCode = 'due_review';
    }

    if (
      !due &&
      u.dominantDimension &&
      p.weakestDimension &&
      u.dominantDimension === p.weakestDimension
    ) {
      score += W_WEAKNESS;
      if (reasonCode === 'recommended') reasonCode = 'targets_weakness';
    }

    const rank = difficultyRank(u.difficulty);
    if (rank === p.demonstratedRank + 1) {
      score += W_NEXT_STEP;
      if (reasonCode === 'recommended') reasonCode = 'next_step';
    } else if (rank <= p.demonstratedRank) {
      score += W_AT_OR_BELOW_LEVEL;
    }

    const unmet = u.essentialPrereqConcepts.filter(
      (c) => !p.evidencedConcepts.has(c),
    );
    let prerequisiteWarning: string[] | undefined;
    if (unmet.length > 0) {
      score -= PREREQ_GAP_PENALTY;
      prerequisiteWarning = unmet;
    }

    recs.push({
      unitId: u.id,
      score,
      reasonCode,
      ...(prerequisiteWarning ? { prerequisiteWarning } : {}),
    });
  }

  recs.sort(
    (a, b) =>
      b.score - a.score ||
      (rankById.get(a.unitId) ?? 0) - (rankById.get(b.unitId) ?? 0) ||
      a.unitId - b.unitId,
  );
  return recs;
}
