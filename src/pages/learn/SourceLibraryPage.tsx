import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GraduationCap } from 'lucide-react';
import {
  fetchLearningUnits,
  type LearningUnitListItem,
} from '@/lib/learnApi';
import { difficultyLabelKey } from '@/lib/learnContent';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { LearnSubNav } from '@/components/learn/LearnSubNav';

const ALL = '__all__';

export function SourceLibraryPage() {
  const { t } = useTranslation();
  const [units, setUnits] = useState<LearningUnitListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [difficulty, setDifficulty] = useState<string>(ALL);
  const [domain, setDomain] = useState<string>(ALL);

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

  const difficulties = useMemo(
    () => [...new Set(units.map((u) => u.difficulty))],
    [units],
  );
  const domains = useMemo(
    () => [...new Set(units.flatMap((u) => u.domains))].sort(),
    [units],
  );

  const filtered = units.filter(
    (u) =>
      (difficulty === ALL || u.difficulty === difficulty) &&
      (domain === ALL || u.domains.includes(domain)),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <LearnSubNav />
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <GraduationCap className="h-5 w-5 text-primary" />
          {t('learn.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('learn.subtitle')}
        </p>
      </div>

      {!loading && !hasError && units.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              {t('learn.filter.difficulty')}
            </span>
            <Select
              className="w-48"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              options={[
                { value: ALL, label: t('learn.filter.all') },
                ...difficulties.map((d) => ({
                  value: d,
                  label: t(difficultyLabelKey(d)),
                })),
              ]}
            />
          </label>
          {domains.length > 0 && (
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                {t('learn.filter.domain')}
              </span>
              <Select
                className="w-48"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                options={[
                  { value: ALL, label: t('learn.filter.all') },
                  ...domains.map((d) => ({ value: d, label: d })),
                ]}
              />
            </label>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : hasError ? (
        <p className="text-sm text-destructive">{t('learn.loadError')}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('learn.empty')}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((u) => (
            <li key={u.id}>
              <Link
                to={`/learn/unit/${u.id}`}
                className="block rounded-lg border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-medium leading-tight">{u.title}</h2>
                  <Badge variant="secondary" className="shrink-0">
                    {t(difficultyLabelKey(u.difficulty))}
                  </Badge>
                </div>
                {u.domains.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {u.domains.map((d) => (
                      <Badge key={d} variant="outline">
                        {d}
                      </Badge>
                    ))}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
