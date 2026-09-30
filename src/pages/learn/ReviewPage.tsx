import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { History, ArrowLeft, Stethoscope } from 'lucide-react';
import {
  fetchLearningUnit,
  fetchLearningUnits,
  fetchProgress,
  type LearningUnitDetail,
  type LearningUnitListItem,
  type UnitProgressItem,
} from '@/lib/learnApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LearnSubNav } from '@/components/learn/LearnSubNav';
import { Assessment } from '@/components/learn/Assessment';

const REVIEW_SAMPLE_SIZE = 5;

export function ReviewPage() {
  const { t } = useTranslation();
  const [due, setDue] = useState<UnitProgressItem[]>([]);
  const [units, setUnits] = useState<LearningUnitListItem[]>([]);
  const [cases, setCases] = useState<LearningUnitListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [active, setActive] = useState<LearningUnitDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchProgress(),
      fetchLearningUnits(),
      fetchLearningUnits({ kind: 'clinical_case' }),
    ])
      .then(([progress, list, caseList]) => {
        if (cancelled) return;
        const now = Date.now();
        setDue(
          progress.units.filter(
            (u) => u.nextReviewAt != null && Date.parse(u.nextReviewAt) <= now,
          ),
        );
        setUnits(list);
        setCases(caseList);
        setHasError(false);
      })
      .catch(() => {
        if (!cancelled) setHasError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const titleById = useMemo(
    () => new Map(units.map((u) => [u.id, u])),
    [units],
  );

  // A review samples a subset of the unit's questions.
  const sampledQuestions = active
    ? active.content.questions.slice(0, REVIEW_SAMPLE_SIZE)
    : [];

  function startReview(unitId: number) {
    fetchLearningUnit(unitId)
      .then((detail) => setActive(detail))
      .catch(() => undefined);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <LearnSubNav />
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <History className="h-5 w-5 text-primary" />
          {t('learn.review.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('learn.review.subtitle')}
        </p>
      </div>

      {active ? (
        <div>
          <button
            onClick={() => setActive(null)}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('learn.back')}
          </button>
          <h2 className="mb-3 text-lg font-semibold">{active.title}</h2>
          <Assessment
            questions={sampledQuestions}
            unitId={active.id}
            reviewMode
          />
        </div>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : hasError ? (
        <p className="text-sm text-destructive">{t('learn.loadError')}</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <Stethoscope className="h-4 w-4 text-primary" />
              {t('learn.review.casesTitle')}
            </h2>
            {cases.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('learn.review.casesEmpty')}
              </p>
            ) : (
              <ul className="space-y-2">
                {cases.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2 rounded-lg border bg-card p-3"
                  >
                    <span className="text-sm font-medium">{c.title}</span>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/learn/unit/${c.id}`}>
                        {t('learn.review.casesOpen')}
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <History className="h-4 w-4 text-primary" />
              {t('learn.review.dueTitle')}
            </h2>
            {due.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('learn.review.empty')}
              </p>
            ) : (
              <ul className="space-y-2">
                {due.map((u) => {
                  const meta = titleById.get(u.unitId);
                  return (
                    <li
                      key={u.unitId}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-card p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {t('learn.review.due')}
                        </Badge>
                        <span className="text-sm font-medium">
                          {meta?.title ?? `#${u.unitId}`}
                        </span>
                      </div>
                      <Button size="sm" onClick={() => startReview(u.unitId)}>
                        {t('learn.review.start')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
