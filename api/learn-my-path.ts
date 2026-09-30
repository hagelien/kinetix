/**
 * GET /api/learn-my-path — transparent "study next" recommendations (spec §8).
 *
 * Auth-required. Composes the learner's progress, evidenced concepts, weakest
 * competence dimension, and demonstrated difficulty, then ranks the published
 * units with `rankRecommendations`. Each result carries a reason code (rendered
 * by the FE via i18n) and an optional soft prerequisite warning.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { requireKinetixLearnAccess } from './_lib/learn-access.js';
import {
  aggregateCompetence,
  type SkillDimension,
} from './_lib/learn-competence.js';
import {
  rankRecommendations,
  summarizeUnitForRanking,
  difficultyRank,
  type RankUnit,
  type UnitProgress,
} from './_lib/learn-my-path.js';
import type { LearningUnitContent } from './_lib/schemas.js';
import {
  learningUnits,
  learningQuestionAttempts,
  learningUnitProgress,
} from '../db/schema.js';

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const auth = await requireKinetixLearnAccess(req, res);
  if (!auth) return;

  const db = getDb();
  const now = new Date();

  const [unitRows, attempts, progressRows] = await Promise.all([
    db
      .select({
        id: learningUnits.id,
        title: learningUnits.title,
        difficulty: learningUnits.difficulty,
        domains: learningUnits.domains,
        content: learningUnits.content,
      })
      .from(learningUnits)
      .where(eq(learningUnits.status, 'published'))
      .limit(500),
    db
      .select({
        category: learningQuestionAttempts.category,
        cognitiveSkill: learningQuestionAttempts.cognitiveSkill,
        correct: learningQuestionAttempts.correct,
        mode: learningQuestionAttempts.mode,
        concepts: learningQuestionAttempts.concepts,
      })
      .from(learningQuestionAttempts)
      .where(eq(learningQuestionAttempts.userId, auth.userId)),
    db
      .select({
        unitId: learningUnitProgress.unitId,
        status: learningUnitProgress.status,
        bestScorePct: learningUnitProgress.bestScorePct,
        nextReviewAt: learningUnitProgress.nextReviewAt,
      })
      .from(learningUnitProgress)
      .where(eq(learningUnitProgress.userId, auth.userId)),
  ]);

  // Build the ranking inputs.
  const unitMeta = new Map(
    unitRows.map((u) => [
      u.id,
      { title: u.title, difficulty: u.difficulty, domains: u.domains ?? [] },
    ]),
  );

  const rankUnits: RankUnit[] = unitRows.map((u) => {
    const summary = summarizeUnitForRanking(u.content as LearningUnitContent);
    return {
      id: u.id,
      difficulty: u.difficulty,
      domains: u.domains ?? [],
      essentialPrereqConcepts: summary.essentialPrereqConcepts,
      dominantDimension: summary.dominantDimension,
    };
  });

  const progressByUnit = new Map<number, UnitProgress>(
    progressRows.map((p) => [
      p.unitId,
      {
        status: p.status,
        bestScorePct: p.bestScorePct,
        nextReviewAt: p.nextReviewAt ?? null,
      },
    ]),
  );

  // Concepts the learner has demonstrated (from correctly-answered questions).
  const evidencedConcepts = new Set<string>();
  for (const a of attempts) {
    if (a.correct) for (const c of a.concepts ?? []) evidencedConcepts.add(c);
  }

  // Weakest sampled skill dimension (lowest accuracy with ≥1 sample).
  const competence = aggregateCompetence(attempts);
  let weakestDimension: SkillDimension | null = null;
  let worst = Infinity;
  for (const d of competence.dimensions) {
    if (d.accuracyPct !== null && d.accuracyPct < worst) {
      worst = d.accuracyPct;
      weakestDimension = d.dimension;
    }
  }

  // Highest difficulty rank the learner has completed or mastered.
  let demonstratedRank = 0;
  for (const p of progressRows) {
    if (p.status === 'completed' || p.status === 'mastered') {
      const meta = unitMeta.get(p.unitId);
      if (meta) {
        demonstratedRank = Math.max(
          demonstratedRank,
          difficultyRank(meta.difficulty),
        );
      }
    }
  }

  const ranked = rankRecommendations({
    units: rankUnits,
    progressByUnit,
    evidencedConcepts,
    weakestDimension,
    demonstratedRank,
    now,
  });

  json(
    res,
    200,
    {
      recommendations: ranked.map((r) => {
        const meta = unitMeta.get(r.unitId);
        return {
          unitId: r.unitId,
          title: meta?.title ?? '',
          difficulty: meta?.difficulty ?? '',
          domains: meta?.domains ?? [],
          reasonCode: r.reasonCode,
          ...(r.prerequisiteWarning
            ? { prerequisiteWarning: r.prerequisiteWarning }
            : {}),
        };
      }),
    },
    { headers: noStoreHeaders() },
  );
});
