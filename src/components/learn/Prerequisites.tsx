import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { prerequisiteLevelLabelKey } from '@/lib/learnContent';
import type { LearningUnitPrerequisite } from '@/lib/learnApi';

/** §7.2 prerequisites: each concept with its level badge and a "why". */
export function Prerequisites({
  prerequisites,
}: {
  prerequisites: LearningUnitPrerequisite[];
}) {
  const { t } = useTranslation();
  if (prerequisites.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">
        {t('learn.prerequisites')}
      </h2>
      <ul className="space-y-2">
        {prerequisites.map((p, i) => (
          <li key={`${p.concept}-${i}`} className="rounded-md border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{p.concept}</span>
              <Badge variant="outline" className="shrink-0">
                {t(prerequisiteLevelLabelKey(p.level))}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.why}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
