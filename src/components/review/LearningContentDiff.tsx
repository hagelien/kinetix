import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Prerequisites } from '@/components/learn/Prerequisites';
import { Objectives } from '@/components/learn/Objectives';
import { CaseCrossLinks } from '@/components/learn/CaseCrossLinks';
import { difficultyLabelKey, type LearningQuestion } from '@/lib/learnContent';
import type {
  ClinicalCaseContent,
  LearningUnitContent,
} from '@/lib/learnApi';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

interface LearningContentDiffProps {
  edit: PendingEditRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function InvalidPayload() {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {t('review.learningContent.invalidContent', {
        defaultValue: 'Could not render this content.',
      })}
    </div>
  );
}

/**
 * The reviewer's answer-key view of an assessment. Unlike the learner-facing
 * `Assessment`, this is a static preview: every correct option is highlighted
 * and every option's explanation is shown, so a moderator can judge the
 * question quality before approving. Collapsed by default (cases carry 6–80
 * questions) so the card stays scannable.
 */
function QuestionsAnswerKey({ questions }: { questions: LearningQuestion[] }) {
  const { t } = useTranslation();
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return (
    <details className="rounded-md border border-border bg-background">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        {t('review.learningContent.questionCount', {
          count: questions.length,
          defaultValue: '{{count}} assessment questions',
        })}
      </summary>
      <ol className="space-y-4 border-t border-border p-3">
        {questions.map((q, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-xs font-semibold text-muted-foreground">
              {i + 1}.
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-sm font-medium">{q.stem}</p>
              {q.format === 'select_all' ? (
                <p className="text-xs text-muted-foreground">
                  {t('learn.assessment.selectAllHint')}
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {(q.options ?? []).map((opt) => (
                  <li key={opt.id} className="flex items-start gap-1.5">
                    {opt.isCorrect ? (
                      <CheckCircle2
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                        aria-hidden
                      />
                    ) : (
                      <span className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 space-y-0.5 text-sm">
                      <span
                        className={
                          opt.isCorrect
                            ? 'font-medium text-emerald-700 dark:text-emerald-300'
                            : ''
                        }
                      >
                        {opt.text}
                      </span>
                      {opt.explanation ? (
                        <p className="text-xs text-muted-foreground">
                          {opt.explanation}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {q.sourceSupport ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold">
                    {t('review.learningContent.sourceSupport', {
                      defaultValue: 'Source support',
                    })}
                    :
                  </span>{' '}
                  {q.sourceSupport}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * Review-queue body for `learning_unit` and `clinical_case` edits. Both create
 * a `learning_units` row (there is no prior version to diff against), so this
 * previews the proposed content the way it will read once published — the same
 * approach `PaperReviewDiff` takes. Without it these edits fell through to the
 * generic `WikiDiff`, which found no text in the JSON payload and rendered an
 * "Unknown target / no text changes" card (see PendingEditCard).
 */
export function LearningContentDiff({ edit }: LearningContentDiffProps) {
  const { t } = useTranslation();
  const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
  const difficulty =
    typeof meta.difficulty === 'string' ? meta.difficulty : null;
  const value = edit.proposedValue;

  if (!isRecord(value)) return <InvalidPayload />;

  if (edit.editType === 'clinical_case') {
    const content = value as unknown as ClinicalCaseContent;
    return (
      <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3">
        {typeof content.safetyNotice === 'string' && content.safetyNotice ? (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide">
                {t('learn.case.safetyNoticeLabel')}
              </p>
              <p className="mt-0.5 font-medium">{content.safetyNotice}</p>
            </div>
          </div>
        ) : null}

        {typeof content.scenario === 'string' && content.scenario ? (
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('learn.case.scenario')}
              </p>
              {difficulty ? (
                <Badge variant="secondary" className="shrink-0">
                  {t(difficultyLabelKey(difficulty))}
                </Badge>
              ) : null}
            </div>
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {content.scenario}
            </p>
          </div>
        ) : null}

        <Prerequisites prerequisites={content.prerequisites ?? []} />
        <Objectives objectives={content.objectives ?? []} />
        <CaseCrossLinks crossLinks={content.crossLinks} />
        <QuestionsAnswerKey questions={content.questions ?? []} />
      </div>
    );
  }

  // learning_unit
  const content = value as unknown as LearningUnitContent;
  const card = content.sourceCard;
  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3">
      {difficulty ? (
        <Badge variant="secondary">{t(difficultyLabelKey(difficulty))}</Badge>
      ) : null}

      {card && typeof card.whyItMatters === 'string' && card.whyItMatters ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('learn.sourceCard.whyItMatters')}
          </p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">
            {card.whyItMatters}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {Array.isArray(card.sourceStatus)
              ? card.sourceStatus.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {s}
                  </Badge>
                ))
              : null}
            {typeof card.estimatedReadingMinutes === 'number' ? (
              <span className="text-xs text-muted-foreground">
                {t('learn.readingMinutes', {
                  count: card.estimatedReadingMinutes,
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <Prerequisites prerequisites={content.prerequisites ?? []} />

      {Array.isArray(content.preReadingPrompts) &&
      content.preReadingPrompts.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">
            {t('learn.preReading')}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {content.preReadingPrompts.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <Objectives objectives={content.objectives ?? []} />
      <QuestionsAnswerKey questions={content.questions ?? []} />
    </div>
  );
}
