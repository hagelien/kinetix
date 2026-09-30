import { useTranslation } from 'react-i18next';

/** §7.3 pre-reading prompts: questions to hold in mind while reading. */
export function PreReadingGuide({ prompts }: { prompts: string[] }) {
  const { t } = useTranslation();
  if (prompts.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{t('learn.preReading')}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {prompts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </section>
  );
}
