import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ClinicalCaseCrossLink } from '@/lib/learnApi';

/**
 * Optional Kinetix cross-links for a clinical case (§5.4): drugs / targets /
 * enzymes / concepts / guidelines the case touches. Links with a `slug` deep-link
 * to the wiki page; label-only entries render as plain chips. Renders nothing
 * when the case declares no cross-links, so it is safe to always mount.
 */
export function CaseCrossLinks({
  crossLinks,
}: {
  crossLinks?: ClinicalCaseCrossLink[];
}) {
  const { t } = useTranslation();
  if (!crossLinks || crossLinks.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">
        {t('learn.case.crossLinks', { defaultValue: 'Kinetix links' })}
      </h2>
      <ul className="flex flex-wrap gap-2 text-sm">
        {crossLinks.map((link, i) => (
          <li key={i}>
            {link.slug ? (
              <Link
                to={`/wiki/${link.slug}`}
                className="inline-block rounded-md border border-border bg-card px-2.5 py-1 text-primary hover:bg-muted/40"
              >
                {link.label}
              </Link>
            ) : (
              <span className="inline-block rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground">
                {link.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
