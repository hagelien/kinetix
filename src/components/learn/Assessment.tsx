import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  gradeAssessment,
  scoreQuestion,
  type LearningQuestion,
} from '@/lib/learnContent';
import { submitAttempt, type AttemptMode } from '@/lib/learnApi';

type Mode = 'submit_all' | 'one_at_a_time';

/**
 * §7.5–7.6 assessment runner. Supports both answering modes (answer-all then
 * submit, or one-at-a-time with immediate feedback), single-best (radio) and
 * select-all (checkbox) questions, and shows every option's explanation —
 * including wrong ones — after grading. Scoring is entirely client-side;
 * nothing is persisted (Phase B is stateless).
 */
export function Assessment({
  questions,
  unitId,
  reviewMode = false,
}: {
  questions: LearningQuestion[];
  /** When set, completed attempts are persisted for this unit. */
  unitId?: number;
  /** Force the persisted attempt mode to 'review' (Cases & Review). */
  reviewMode?: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('submit_all');
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  // Persist a completed attempt. Non-fatal: local feedback already shows, so a
  // failed save just flips a quiet indicator rather than blocking the learner.
  function persist(finalAnswers: Record<number, string[]>) {
    if (unitId == null) return;
    const attemptMode: AttemptMode = reviewMode ? 'review' : mode;
    setSaveState('saving');
    submitAttempt({ unitId, mode: attemptMode, answers: finalAnswers })
      .then(() => setSaveState('saved'))
      .catch(() => setSaveState('error'));
  }

  if (questions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('learn.assessment.empty')}
      </p>
    );
  }

  function reset(nextMode: Mode) {
    setMode(nextMode);
    setAnswers({});
    setSubmitted(false);
    setCurrent(0);
    setRevealed({});
    setSaveState('idle');
  }

  function toggleOption(qIndex: number, optId: string, format: string) {
    setAnswers((prev) => {
      const cur = prev[qIndex] ?? [];
      if (format === 'single_best') return { ...prev, [qIndex]: [optId] };
      return {
        ...prev,
        [qIndex]: cur.includes(optId)
          ? cur.filter((x) => x !== optId)
          : [...cur, optId],
      };
    });
  }

  const isRevealed = (i: number) =>
    mode === 'submit_all' ? submitted : !!revealed[i];

  const grade = gradeAssessment(questions, answers);
  const oneAtATimeDone =
    mode === 'one_at_a_time' &&
    current === questions.length - 1 &&
    !!revealed[current];
  const showScore = mode === 'submit_all' ? submitted : oneAtATimeDone;

  const visibleIndexes =
    mode === 'submit_all'
      ? questions.map((_, i) => i)
      : [current];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('learn.assessment.title')}</h2>
        <div className="flex gap-1.5" role="group" aria-label={t('learn.assessment.mode')}>
          <Button
            size="sm"
            variant={mode === 'submit_all' ? 'default' : 'outline'}
            onClick={() => reset('submit_all')}
          >
            {t('learn.assessment.modeSubmitAll')}
          </Button>
          <Button
            size="sm"
            variant={mode === 'one_at_a_time' ? 'default' : 'outline'}
            onClick={() => reset('one_at_a_time')}
          >
            {t('learn.assessment.modeOneAtATime')}
          </Button>
        </div>
      </div>

      {mode === 'one_at_a_time' && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t('learn.assessment.progress', {
            current: current + 1,
            total: questions.length,
          })}
        </p>
      )}

      <ol className="space-y-6">
        {visibleIndexes.map((i) => {
          const q = questions[i];
          if (!q) return null;
          const selected = answers[i] ?? [];
          const revealedNow = isRevealed(i);
          const result = scoreQuestion(q, selected);
          return (
            <li key={i} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{q.stem}</p>
                {revealedNow && (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${
                      result.correct ? 'text-emerald-600' : 'text-destructive'
                    }`}
                  >
                    {result.correct ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {result.correct
                      ? t('learn.assessment.correct')
                      : t('learn.assessment.incorrect')}
                  </span>
                )}
              </div>
              {q.format === 'select_all' && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('learn.assessment.selectAllHint')}
                </p>
              )}

              <ul className="mt-3 space-y-2">
                {q.options.map((opt) => {
                  const checked = selected.includes(opt.id);
                  return (
                    <li key={opt.id}>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type={
                            q.format === 'single_best' ? 'radio' : 'checkbox'
                          }
                          name={`q-${i}`}
                          checked={checked}
                          disabled={revealedNow}
                          onChange={() =>
                            toggleOption(i, opt.id, q.format)
                          }
                          className="mt-1"
                        />
                        <span
                          className={
                            revealedNow && opt.isCorrect
                              ? 'font-medium text-emerald-700'
                              : revealedNow && checked && !opt.isCorrect
                                ? 'text-destructive'
                                : ''
                          }
                        >
                          {opt.text}
                        </span>
                      </label>
                      {revealedNow && (
                        <p className="ml-6 mt-1 text-xs text-muted-foreground">
                          {opt.explanation}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {mode === 'submit_all' && !submitted && (
          <Button
            onClick={() => {
              setSubmitted(true);
              persist(answers);
            }}
          >
            {t('learn.assessment.submit')}
          </Button>
        )}
        {mode === 'one_at_a_time' && !revealed[current] && (
          <Button
            onClick={() => {
              setRevealed((prev) => ({ ...prev, [current]: true }));
              // The last reveal completes the one-at-a-time run — persist then.
              if (current === questions.length - 1) persist(answers);
            }}
          >
            {t('learn.assessment.check')}
          </Button>
        )}
        {mode === 'one_at_a_time' &&
          revealed[current] &&
          current < questions.length - 1 && (
            <Button onClick={() => setCurrent((c) => c + 1)}>
              {t('learn.assessment.next')}
            </Button>
          )}
        {showScore && (
          <>
            <Badge variant="secondary" className="text-sm">
              {t('learn.assessment.score', {
                correct: grade.correctCount,
                total: grade.total,
              })}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => reset(mode)}>
              {t('learn.assessment.restart')}
            </Button>
            {unitId != null && saveState === 'saved' && (
              <span className="text-xs text-emerald-600">
                {t('learn.assessment.saved')}
              </span>
            )}
            {unitId != null && saveState === 'error' && (
              <span className="text-xs text-destructive">
                {t('learn.assessment.saveError')}
              </span>
            )}
          </>
        )}
      </div>
    </section>
  );
}
