/**
 * Read-only API client for the Kinetix Learn learner UI. Wraps
 * GET /api/learning-units (published content, no auth) following the
 * fetch + decode + throw-on-!ok idiom used across src/lib/drugApi.ts.
 */
import type {
  LearningDifficulty,
  LearningQuestion,
  PrerequisiteLevel,
} from '@/lib/learnContent';

/** Bibliographic metadata surfaced for the source card (citations.metadata). */
export interface LearningSourceMetadata {
  title?: string;
  authors?: string | string[];
  journal?: string;
  year?: number | string;
  volume?: string;
  pages?: string;
}

/** Link-out source block — identifiers + resolved URL, never a PDF/full text. */
export interface LearningUnitSource {
  citationId: number;
  type: string;
  identifier: string;
  url: string | null;
  metadata: LearningSourceMetadata | null;
}

export interface LearningUnitPrerequisite {
  concept: string;
  level: PrerequisiteLevel;
  why: string;
}

/** A learning_units row is one of these two kinds (see schemas.ts). */
export type LearningUnitKind = 'unit' | 'clinical_case';

/** Mirrors api/_lib/schemas.ts learningUnitContentSchema. */
export interface LearningUnitContent {
  sourceCard: {
    whyItMatters: string;
    sourceStatus: string[];
    estimatedReadingMinutes: number;
  };
  prerequisites: LearningUnitPrerequisite[];
  preReadingPrompts: string[];
  objectives: string[];
  questions: LearningQuestion[];
}

/** A Kinetix cross-link from a case to an existing monograph / wiki page. */
export interface ClinicalCaseCrossLink {
  label: string;
  slug?: string;
  kind?: string;
}

/** Mirrors api/_lib/schemas.ts clinicalCaseContentSchema (Phase D, §5.4). */
export interface ClinicalCaseContent {
  safetyNotice: string;
  scenario: string;
  prerequisites: LearningUnitPrerequisite[];
  objectives: string[];
  questions: LearningQuestion[];
  /** Optional Kinetix cross-links to existing monographs / wiki pages. */
  crossLinks?: ClinicalCaseCrossLink[];
}

export interface LearningUnitListItem {
  id: number;
  slug: string;
  title: string;
  difficulty: LearningDifficulty;
  domains: string[];
  kind: LearningUnitKind;
}

export interface LearningUnitDetail extends LearningUnitListItem {
  // Shape depends on `kind`: LearningUnitContent for 'unit',
  // ClinicalCaseContent for 'clinical_case'. Narrow on `kind` before use.
  content: LearningUnitContent | ClinicalCaseContent;
  source: LearningUnitSource | null;
}

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Request failed with status ${res.status}`);
  }
  if (!res.ok) {
    const err = new Error(
      (data.error as string) ?? `Request failed with status ${res.status}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * List published learning units (no content payload). Defaults to `kind:'unit'`
 * server-side; pass `kind:'clinical_case'` to list the Cases area's cases.
 */
export async function fetchLearningUnits(params?: {
  citationId?: number;
  kind?: LearningUnitKind;
}): Promise<LearningUnitListItem[]> {
  const sp = new URLSearchParams();
  if (params?.citationId) sp.set('citationId', String(params.citationId));
  if (params?.kind) sp.set('kind', params.kind);
  const qs = sp.toString();
  const { units } = await apiFetch<{ units: LearningUnitListItem[] }>(
    `/api/learning-units${qs ? `?${qs}` : ''}`,
  );
  return units;
}

/** Fetch one published unit by id, with content + link-out source block. */
export async function fetchLearningUnit(
  id: number,
): Promise<LearningUnitDetail> {
  return apiFetch<LearningUnitDetail>(`/api/learning-units?id=${id}`);
}

// ─── Phase C: learner state (auth-required) ─────────────────────────────────

export type AttemptMode = 'submit_all' | 'one_at_a_time' | 'review';

export interface AttemptResult {
  scorePct: number;
  status: 'in_progress' | 'completed' | 'mastered';
  nextReviewAt: string | null;
  perQuestion: Array<{ questionIndex: number; correct: boolean }>;
}

async function apiSend<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Request failed with status ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(
      (data.error as string) ?? `Request failed with status ${res.status}`,
    );
  }
  return data as T;
}

/** Persist a graded assessment attempt; the server re-grades authoritatively. */
export async function submitAttempt(input: {
  unitId: number;
  mode: AttemptMode;
  answers: Record<number, string[]>;
}): Promise<AttemptResult> {
  return apiSend<AttemptResult>('/api/learn-attempts', 'POST', input);
}

export type SkillDimension =
  | 'factual_knowledge'
  | 'critical_appraisal'
  | 'statistical_reasoning'
  | 'clinical_reasoning';

export interface CompetenceProfile {
  dimensions: Array<{
    dimension: SkillDimension;
    accuracyPct: number | null;
    sampleCount: number;
  }>;
  retention: { accuracyPct: number | null; sampleCount: number };
}

export interface UnitProgressItem {
  unitId: number;
  attempts: number;
  bestScorePct: number;
  lastScorePct: number;
  status: 'in_progress' | 'completed' | 'mastered';
  nextReviewAt: string | null;
}

export interface LearnProgress {
  units: UnitProgressItem[];
  competence: CompetenceProfile;
  dueReviewCount: number;
}

export async function fetchProgress(): Promise<LearnProgress> {
  return apiFetch<LearnProgress>('/api/learn-progress');
}

export type RecommendationReason =
  | 'due_review'
  | 'targets_weakness'
  | 'next_step'
  | 'recommended';

export interface Recommendation {
  unitId: number;
  title: string;
  difficulty: string;
  domains: string[];
  reasonCode: RecommendationReason;
  prerequisiteWarning?: string[];
}

export async function fetchMyPath(): Promise<Recommendation[]> {
  const { recommendations } = await apiFetch<{
    recommendations: Recommendation[];
  }>('/api/learn-my-path');
  return recommendations;
}
