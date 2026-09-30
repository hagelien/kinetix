/**
 * Pure, framework-free helpers for the Kinetix Learn learner UI: difficulty /
 * prerequisite-level label keys, source link-out resolution, and client-side
 * assessment scoring. Kept dependency-free so it's trivially unit-testable and
 * reusable by both the unit renderer and the assessment runner.
 *
 * The difficulty/prerequisite-level lists mirror api/_lib/schemas.ts
 * (LEARNING_DIFFICULTIES / PREREQUISITE_LEVELS) — keep them in sync.
 */

export const LEARNING_DIFFICULTIES = [
  'foundational',
  'intermediate_lis',
  'advanced_lis',
  'board',
  'senior',
  'research',
] as const;

export type LearningDifficulty = (typeof LEARNING_DIFFICULTIES)[number];

export const PREREQUISITE_LEVELS = [
  'essential',
  'helpful',
  'advanced_adjacent',
  'optional_context',
] as const;

export type PrerequisiteLevel = (typeof PREREQUISITE_LEVELS)[number];

export type QuestionFormat = 'single_best' | 'select_all';

export type QuestionCategory = 'factual' | 'reasoned';

// Mirrors COGNITIVE_SKILLS in api/_lib/schemas.ts (Phase C).
export const COGNITIVE_SKILLS = [
  'factual_recall',
  'critical_appraisal',
  'statistical_reasoning',
  'clinical_reasoning',
  'mechanistic',
] as const;

export type CognitiveSkill = (typeof COGNITIVE_SKILLS)[number];

// The six competence dimensions (spec §8). The first four are measured from
// question accuracy; retention is derived from spaced-review performance and
// preference is a declared user setting — both handled outside the per-question
// mapping below.
export const COMPETENCE_DIMENSIONS = [
  'factual_knowledge',
  'critical_appraisal',
  'statistical_reasoning',
  'clinical_reasoning',
  'retention',
  'preference',
] as const;

export type CompetenceDimension = (typeof COMPETENCE_DIMENSIONS)[number];

/** The accuracy-measured skill dimensions (excludes retention/preference). */
export type SkillDimension = Extract<
  CompetenceDimension,
  | 'factual_knowledge'
  | 'critical_appraisal'
  | 'statistical_reasoning'
  | 'clinical_reasoning'
>;

export interface LearningQuestionOption {
  id: string;
  text: string;
  isCorrect: boolean;
  explanation: string;
}

export interface LearningQuestion {
  stem: string;
  format: QuestionFormat;
  category: QuestionCategory;
  options: LearningQuestionOption[];
  difficulty: LearningDifficulty;
  concepts: string[];
  sourceSupport: string;
  cognitiveSkill?: CognitiveSkill;
}

/**
 * Map a question to the skill dimension it measures. Prefers the explicit
 * cognitiveSkill tag (mechanistic folds into clinical reasoning); when absent,
 * falls back to the question category — 'factual' → factual knowledge,
 * 'reasoned' → clinical reasoning as the generic reasoned bucket.
 */
export function cognitiveSkillToDimension(
  skill: CognitiveSkill | null | undefined,
  category: QuestionCategory,
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

/** i18n key for a difficulty value, e.g. `learn.difficulty.foundational`. */
export function difficultyLabelKey(difficulty: string): string {
  return `learn.difficulty.${difficulty}`;
}

/**
 * Sort rank for a difficulty, following the curriculum order in
 * LEARNING_DIFFICULTIES (foundational → research). Unknown values sort last.
 */
export function difficultyRank(difficulty: string): number {
  const i = LEARNING_DIFFICULTIES.indexOf(difficulty as LearningDifficulty);
  return i === -1 ? LEARNING_DIFFICULTIES.length : i;
}

export interface DomainGroup<T> {
  domain: string;
  units: T[];
}

/**
 * Group learning units by domain for the Topic Map. A unit appears under each
 * of its domains; units with none fall under `uncategorized`. Domains are
 * sorted alphabetically and units within a domain by difficulty rank.
 */
export function groupUnitsByDomain<
  T extends { domains: string[]; difficulty: string },
>(units: readonly T[], uncategorized: string): DomainGroup<T>[] {
  const byDomain = new Map<string, T[]>();
  for (const unit of units) {
    const keys = unit.domains.length > 0 ? unit.domains : [uncategorized];
    for (const key of keys) {
      const list = byDomain.get(key) ?? [];
      list.push(unit);
      byDomain.set(key, list);
    }
  }
  return [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, list]) => ({
      domain,
      units: [...list].sort(
        (x, y) => difficultyRank(x.difficulty) - difficultyRank(y.difficulty),
      ),
    }));
}

/** i18n key for a prerequisite level, e.g. `learn.prereq.essential`. */
export function prerequisiteLevelLabelKey(level: string): string {
  return `learn.prereq.${level}`;
}

export function safeHttpUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a citation's external link-out URL from its type + identifier.
 * Mirrors the server helper in api/learning-units.ts so the source card can
 * fall back gracefully if the API omits `source.url`. Never a PDF/full-text URL.
 */
export function sourceLinkOutUrl(
  type: string,
  identifier: string,
): string | null {
  const id = identifier.trim();
  if (!id) return null;
  switch (type) {
    case 'doi':
      return `https://doi.org/${id}`;
    case 'pmid':
      return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
    case 'url':
      return safeHttpUrl(id);
    default:
      return null;
  }
}

export interface QuestionScore {
  correct: boolean;
  correctIds: string[];
}

/**
 * Score a single question against the learner's selected option ids.
 * - single_best: correct iff exactly the one correct option is selected.
 * - select_all: correct iff the selected set equals the correct set exactly
 *   (partial credit is not awarded).
 */
export function scoreQuestion(
  question: LearningQuestion,
  selectedIds: readonly string[],
): QuestionScore {
  const correctIds = question.options
    .filter((o) => o.isCorrect)
    .map((o) => o.id);
  const selected = new Set(selectedIds);
  const correct =
    selected.size === correctIds.length &&
    correctIds.every((id) => selected.has(id));
  return { correct, correctIds };
}

export interface AssessmentGrade {
  correctCount: number;
  total: number;
  perQuestion: QuestionScore[];
}

/**
 * Grade a whole assessment. `answers` is keyed by question index; a missing
 * entry is treated as no selection (incorrect). Scoring is display-only —
 * nothing is persisted (Phase B is stateless).
 */
export function gradeAssessment(
  questions: readonly LearningQuestion[],
  answers: Readonly<Record<number, readonly string[]>>,
): AssessmentGrade {
  const perQuestion = questions.map((q, i) =>
    scoreQuestion(q, answers[i] ?? []),
  );
  return {
    correctCount: perQuestion.filter((s) => s.correct).length,
    total: questions.length,
    perQuestion,
  };
}
