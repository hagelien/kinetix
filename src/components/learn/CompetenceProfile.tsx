import { useTranslation } from 'react-i18next';
import type { CompetenceProfile as Profile } from '@/lib/learnApi';

function Bar({
  labelKey,
  accuracyPct,
  sampleCount,
}: {
  labelKey: string;
  accuracyPct: number | null;
  sampleCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{t(labelKey)}</span>
        <span className="text-muted-foreground">
          {accuracyPct === null
            ? t('learn.competence.notMeasured')
            : `${accuracyPct}% · ${t('learn.competence.samples', { count: sampleCount })}`}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${accuracyPct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** Per-dimension accuracy bars + retention (spec §8). */
export function CompetenceProfile({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-lg font-semibold">
        {t('learn.competence.title')}
      </h2>
      <div className="space-y-3">
        {profile.dimensions.map((d) => (
          <Bar
            key={d.dimension}
            labelKey={`learn.dimension.${d.dimension}`}
            accuracyPct={d.accuracyPct}
            sampleCount={d.sampleCount}
          />
        ))}
        <Bar
          labelKey="learn.dimension.retention"
          accuracyPct={profile.retention.accuracyPct}
          sampleCount={profile.retention.sampleCount}
        />
      </div>
    </section>
  );
}
