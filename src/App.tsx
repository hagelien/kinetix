import { useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import { RecentChangesFeed } from '@/components/RecentChangesFeed';

/** Where account requests go; set per deployment (`VITE_CONTACT_EMAIL`). */
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL?.trim() || null;

/**
 * Landing route (`/`) inside the global drug-table shell. The per-drug
 * "half monograph" panel (the in-page monograph preview with an "Open full
 * page" button) has been removed: picking a drug from the table now
 * navigates straight to its full wiki monograph (`/wiki/:slug`). The drug
 * list itself is hosted by `DrugTableShell` and is available on every
 * route, so besides the welcome placeholder the landing route renders a
 * feed of the most recent accepted drug-parameter and wiki edits (#1263).
 */
export default function App() {
  const { t } = useTranslation();

  return (
    <main className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full min-h-0 overflow-y-auto px-6 py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <BookOpen className="h-7 w-7 text-primary shrink-0" />
            <h1 className="text-2xl font-bold">{t('landing.welcomeTitle')}</h1>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('landing.welcomeIntro')}
          </p>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              {t('landing.featuresTitle')}
            </h2>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>{t('landing.featureBrowse')}</li>
              <li>{t('landing.featureSimulate')}</li>
              <li>{t('landing.featureBackcalc')}</li>
              <li>{t('landing.featureLab')}</li>
            </ul>
          </section>

          <section className="space-y-2 border border-border rounded-lg p-4 bg-muted/30">
            <h2 className="text-sm font-semibold">{t('landing.accessTitle')}</h2>
            <p className="text-sm text-muted-foreground">
              {CONTACT_EMAIL ? (
                <>
                  {t('landing.accessBody')}{' '}
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="text-primary hover:underline"
                  >
                    {CONTACT_EMAIL}
                  </a>
                  .
                </>
              ) : (
                t('landing.accessBodyNoContact')
              )}
            </p>
          </section>

          <p className="text-xs text-muted-foreground italic">
            {t('landing.accessHint')}
          </p>

          <RecentChangesFeed />
        </div>
      </div>
    </main>
  );
}
