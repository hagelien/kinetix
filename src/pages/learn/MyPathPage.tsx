import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';
import {
  fetchMyPath,
  fetchProgress,
  type LearnProgress,
  type Recommendation,
} from '@/lib/learnApi';
import { difficultyLabelKey } from '@/lib/learnContent';
import { Badge } from '@/components/ui/badge';
import { LearnSubNav } from '@/components/learn/LearnSubNav';
import { CompetenceProfile } from '@/components/learn/CompetenceProfile';

export function MyPathPage() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<LearnProgress | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchProgress(), fetchMyPath()])
      .then(([prog, recs]) => {
        if (cancelled) return;
        setProgress(prog);
        setRecommendations(recs);
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <LearnSubNav />
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Compass className="h-5 w-5 text-primary" />
          {t('learn.path.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('learn.path.subtitle')}
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : hasError || !progress ? (
        <p className="text-sm text-destructive">{t('learn.loadError')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <div>
            <h2 className="mb-3 text-lg font-semibold">
              {t('learn.path.recommendations')}
            </h2>
            {recommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('learn.path.empty')}
              </p>
            ) : (
              <ul className="space-y-3">
                {recommendations.map((r) => (
                  <li key={r.unitId}>
                    <Link
                      to={`/learn/unit/${r.unitId}`}
                      className="block rounded-lg border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium leading-tight">{r.title}</h3>
                        <Badge variant="secondary" className="shrink-0">
                          {t(difficultyLabelKey(r.difficulty))}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-primary">
                        {t(`learn.reason.${r.reasonCode}`)}
                      </p>
                      {r.prerequisiteWarning &&
                        r.prerequisiteWarning.length > 0 && (
                          <p className="mt-1 text-xs text-amber-600">
                            {t('learn.path.prerequisiteWarning', {
                              concepts: r.prerequisiteWarning.join(', '),
                            })}
                          </p>
                        )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-6">
            <CompetenceProfile profile={progress.competence} />
          </div>
        </div>
      )}
    </div>
  );
}
