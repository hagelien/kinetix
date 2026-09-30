import { useTranslation } from 'react-i18next';

/** §7.9 learning objectives for the unit. */
export function Objectives({ objectives }: { objectives: string[] }) {
  const { t } = useTranslation();
  if (objectives.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{t('learn.objectives')}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {objectives.map((o, i) => (
          <li key={i}>{o}</li>
        ))}
      </ul>
    </section>
  );
}
