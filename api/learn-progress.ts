/**
 * GET /api/learn-progress — the signed-in learner's Kinetix Learn state.
 *
 * Returns per-unit progress, the computed competence profile (spec §8), and a
 * count of units currently due for review.
 * Auth-required; competence is computed on read from the frozen attempt log.
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
import { aggregateCompetence } from './_lib/learn-competence.js';
import {
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

  const [attempts, progress] = await Promise.all([
    db
      .select({
        category: learningQuestionAttempts.category,
        cognitiveSkill: learningQuestionAttempts.cognitiveSkill,
        correct: learningQuestionAttempts.correct,
        mode: learningQuestionAttempts.mode,
      })
      .from(learningQuestionAttempts)
      .where(eq(learningQuestionAttempts.userId, auth.userId)),
    db
      .select({
        unitId: learningUnitProgress.unitId,
        attempts: learningUnitProgress.attempts,
        bestScorePct: learningUnitProgress.bestScorePct,
        lastScorePct: learningUnitProgress.lastScorePct,
        status: learningUnitProgress.status,
        nextReviewAt: learningUnitProgress.nextReviewAt,
      })
      .from(learningUnitProgress)
      .where(eq(learningUnitProgress.userId, auth.userId)),
  ]);

  const dueReviewCount = progress.filter(
    (p) => p.nextReviewAt !== null && p.nextReviewAt <= now,
  ).length;

  json(
    res,
    200,
    {
      units: progress.map((p) => ({
        unitId: p.unitId,
        attempts: p.attempts,
        bestScorePct: p.bestScorePct,
        lastScorePct: p.lastScorePct,
        status: p.status,
        nextReviewAt: p.nextReviewAt ? p.nextReviewAt.toISOString() : null,
      })),
      competence: aggregateCompetence(attempts),
      dueReviewCount,
    },
    { headers: noStoreHeaders() },
  );
});
