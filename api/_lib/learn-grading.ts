/**
 * Authoritative server-side grading for Kinetix Learn assessment attempts.
 *
 * The client is never trusted for correctness or pedagogical tags — those are
 * recomputed here from the stored unit content. The per-question result carries
 * the question's tags (category, cognitiveSkill, difficulty, concepts) so the
 * caller can FREEZE them onto the attempt log, keeping competence aggregates
 * correct even if the unit is later edited.
 *
 * The single-best / select-all scoring rule mirrors src/lib/learnContent.ts
 * `scoreQuestion` (duplicated intentionally — api/ cannot import from src/).
 */
import type { LearningUnitContent } from './schemas.js';

export interface GradedQuestion {
  questionIndex: number;
  correct: boolean;
  category: string;
  cognitiveSkill: string | null;
  difficulty: string;
  concepts: string[];
  selectedOptionIds: string[];
}

export interface GradedAttempt {
  scorePct: number;
  perQuestion: GradedQuestion[];
}

/** True iff the selected option-id set exactly equals the correct set. */
function isExactMatch(
  correctIds: readonly string[],
  selectedIds: readonly string[],
): boolean {
  const selected = new Set(selectedIds);
  return (
    selected.size === correctIds.length &&
    correctIds.every((id) => selected.has(id))
  );
}

/**
 * Grade the answered subset of a unit's questions. `answers` is keyed by
 * question index; entries whose index is out of range are ignored. `scorePct`
 * is over the answered (and in-range) questions only — review mode may sample a
 * subset — and is 0 when nothing valid was answered.
 */
export function gradeUnitAttempt(
  content: LearningUnitContent,
  answers: Readonly<Record<number, readonly string[]>>,
): GradedAttempt {
  const questions = content.questions ?? [];
  const perQuestion: GradedQuestion[] = [];

  for (const [key, selectedRaw] of Object.entries(answers)) {
    const questionIndex = Number(key);
    const question = questions[questionIndex];
    if (!question) continue;

    const selectedOptionIds = [...(selectedRaw ?? [])];
    const correctIds = question.options
      .filter((o) => o.isCorrect)
      .map((o) => o.id);

    perQuestion.push({
      questionIndex,
      correct: isExactMatch(correctIds, selectedOptionIds),
      category: question.category,
      cognitiveSkill: question.cognitiveSkill ?? null,
      difficulty: question.difficulty,
      concepts: question.concepts ?? [],
      selectedOptionIds,
    });
  }

  const answered = perQuestion.length;
  const correctCount = perQuestion.filter((q) => q.correct).length;
  const scorePct = answered === 0 ? 0 : Math.round((100 * correctCount) / answered);

  return { scorePct, perQuestion };
}
