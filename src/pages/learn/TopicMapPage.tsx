import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import {
  fetchLearningUnits,
  type LearningUnitListItem,
} from '@/lib/learnApi';
import { difficultyLabelKey, groupUnitsByDomain } from '@/lib/learnContent';
import { Badge } from '@/components/ui/badge';
import { LearnSubNav } from '@/components/learn/LearnSubNav';

export function TopicMapPage() {
  const { t } = useTranslation();
  const [units, setUnits] = useState<LearningUnitListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLearningUnits()
      .then((rows) => {
        if (cancelled) return;
        setUnits(rows);
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

  const groups = useMemo(
    () => groupUnitsByDomain(units, t('learn.uncategorized')),
    [units, t],
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <LearnSubNav />
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Network className="h-5 w-5 text-primary" />
          {t('learn.map.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('learn.map.subtitle')}
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : hasError ? (
        <p className="text-sm text-destructive">{t('learn.loadError')}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('learn.empty')}</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.domain}>
              <h2 className="mb-2 border-b pb-1 text-lg font-semibold">
                {group.domain}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {group.units.length}
                </span>
              </h2>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.units.map((u) => (
                  <li key={u.id}>
                    <Link
                      to={`/learn/unit/${u.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 transition-colors hover:border-primary/50 hover:bg-accent/40"
                    >
                      <span className="text-sm font-medium leading-tight">
                        {u.title}
                      </span>
                      <Badge variant="secondary" className="shrink-0">
                        {t(difficultyLabelKey(u.difficulty))}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
