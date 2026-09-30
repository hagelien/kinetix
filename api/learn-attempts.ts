/**
 * POST /api/learn-attempts — persist a graded Kinetix Learn assessment attempt.
 *
 * Auth-required for admins and `kinetix-learn` group members. The body carries
 * the unit id, the answer mode, and the selected option ids per question index;
 * the server loads the published unit and GRADES AUTHORITATIVELY (the client is
 * never trusted for correctness). It appends one frozen-tag row per answered
 * question to learning_question_attempts and upserts the per-(user, unit) rollup
 * in learning_unit_progress, advancing the SM-2 review schedule.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { requireKinetixLearnAccess } from './_lib/learn-access.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  learnAttemptSchema,
  type LearningUnitContent,
} from './_lib/schemas.js';
import { gradeUnitAttempt } from './_lib/learn-grading.js';
import { scheduleNextReview } from './_lib/learn-scheduler.js';
import {
  learningUnits,
  learningQuestionAttempts,
  learningUnitProgress,
} from '../db/schema.js';

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }
  assertSameOrigin(req);

  const auth = await requireKinetixLearnAccess(req, res);
  if (!auth) return;

  const parsed = await parseAndValidate(req, learnAttemptSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { unitId, mode, answers } = parsed.data;

  const db = getDb();
  const [unit] = await db
    .select({ content: learningUnits.content })
    .from(learningUnits)
    .where(
      and(eq(learningUnits.id, unitId), eq(learningUnits.status, 'published')),
    )
    .limit(1);
  if (!unit) {
    error(res, 404, 'Learning unit not found');
    return;
  }

  // Normalize the numeric-string keys to a number-indexed record for grading.
  const numericAnswers: Record<number, string[]> = {};
  for (const [key, value] of Object.entries(answers)) {
    numericAnswers[Number(key)] = value;
  }

  const content = unit.content as LearningUnitContent;
  const graded = gradeUnitAttempt(content, numericAnswers);
  if (graded.perQuestion.length === 0) {
    error(res, 400, 'No gradable answers', 'learn_no_answers');
    return;
  }

  // Append the frozen-tag attempt log rows.
  await db.insert(learningQuestionAttempts).values(
    graded.perQuestion.map((q) => ({
      userId: auth.userId,
      unitId,
      questionIndex: q.questionIndex,
      category: q.category,
      cognitiveSkill: q.cognitiveSkill,
      difficulty: q.difficulty,
      concepts: q.concepts,
      correct: q.correct,
      selectedOptionIds: q.selectedOptionIds,
      mode,
    })),
  );

  // Roll up progress + advance the review schedule. A "full" attempt (all
  // questions answered) is what can confer mastery.
  const totalQuestions = content.questions?.length ?? 0;
  const fullAttempt =
    totalQuestions > 0 && graded.perQuestion.length === totalQuestions;

  const [prev] = await db
    .select({
      attempts: learningUnitProgress.attempts,
      bestScorePct: learningUnitProgress.bestScorePct,
      status: learningUnitProgress.status,
      reviewReps: learningUnitProgress.reviewReps,
      reviewEase: learningUnitProgress.reviewEase,
      reviewIntervalDays: learningUnitProgress.reviewIntervalDays,
    })
    .from(learningUnitProgress)
    .where(
      and(
        eq(learningUnitProgress.userId, auth.userId),
        eq(learningUnitProgress.unitId, unitId),
      ),
    )
    .limit(1);

  const now = new Date();
  const bestScorePct = Math.max(prev?.bestScorePct ?? 0, graded.scorePct);
  const status =
    prev?.status === 'mastered'
      ? 'mastered'
      : fullAttempt && graded.scorePct >= 90
        ? 'mastered'
        : bestScorePct >= 50
          ? 'completed'
          : 'in_progress';
  const schedule = scheduleNextReview(
    {
      reps: prev?.reviewReps ?? 0,
      easeX100: prev?.reviewEase ?? 250,
      intervalDays: prev?.reviewIntervalDays ?? 0,
    },
    graded.scorePct,
    now,
  );

  const row = {
    userId: auth.userId,
    unitId,
    attempts: (prev?.attempts ?? 0) + 1,
    bestScorePct,
    lastScorePct: graded.scorePct,
    status,
    reviewReps: schedule.reps,
    reviewEase: schedule.easeX100,
    reviewIntervalDays: schedule.intervalDays,
    nextReviewAt: schedule.nextReviewAt,
    lastAttemptAt: now,
    updatedAt: now,
  };

  await db
    .insert(learningUnitProgress)
    .values(row)
    .onConflictDoUpdate({
      target: [learningUnitProgress.userId, learningUnitProgress.unitId],
      set: {
        attempts: row.attempts,
        bestScorePct: row.bestScorePct,
        lastScorePct: row.lastScorePct,
        status: row.status,
        reviewReps: row.reviewReps,
        reviewEase: row.reviewEase,
        reviewIntervalDays: row.reviewIntervalDays,
        nextReviewAt: row.nextReviewAt,
        lastAttemptAt: row.lastAttemptAt,
        updatedAt: row.updatedAt,
      },
    });

  json(
    res,
    200,
    {
      scorePct: graded.scorePct,
      status,
      nextReviewAt: schedule.nextReviewAt.toISOString(),
      perQuestion: graded.perQuestion.map((q) => ({
        questionIndex: q.questionIndex,
        correct: q.correct,
      })),
    },
    { headers: noStoreHeaders() },
  );
});
