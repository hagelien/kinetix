import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { FlaskConical, PencilLine } from 'lucide-react';
import { UserBadge } from '@/components/ui/UserBadge';
import { getParameterLabelKey, getParameterSpec } from '@/lib/drugParameters';
import { getDrugDisplayName } from '@/lib/useDrugName';
import {
  fetchRecentChanges,
  type RecentChange,
} from '@/lib/recentChangesApi';

const FEED_LIMIT = 15;

function ChangeRow({ change }: { change: RecentChange }) {
  const { t, i18n } = useTranslation();
  const timestamp = new Date(change.createdAt).toLocaleString(i18n.language);
  const Icon = change.type === 'drug_parameter' ? FlaskConical : PencilLine;

  return (
    <li className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {change.type === 'drug_parameter' ? (
            <Trans
              i18nKey="recentChanges.drugParameterChange"
              values={{
                parameter: (() => {
                  const spec = getParameterSpec(change.parameter);
                  return spec
                    ? t(getParameterLabelKey(spec.id), {
                        defaultValue: spec.label,
                      })
                    : change.parameter;
                })(),
                drug: getDrugDisplayName(change.drug, i18n.language),
              }}
              components={{
                drugLink: (
                  <Link
                    to={
                      change.drug.id != null
                        ? `/wiki/drug/${change.drug.id}`
                        : `/wiki/${change.drug.slug}`
                    }
                    className="font-medium text-foreground hover:text-primary hover:underline"
                  />
                ),
              }}
            />
          ) : (
            <Trans
              i18nKey="recentChanges.wikiChange"
              values={{ page: change.page.title }}
              components={{
                pageLink: (
                  <Link
                    to={`/wiki/${change.page.slug}`}
                    className="font-medium text-foreground hover:text-primary hover:underline"
                  />
                ),
              }}
            />
          )}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
          <UserBadge user={change.author} />
          <span>&middot;</span>
          <span>{timestamp}</span>
        </p>
      </div>
    </li>
  );
}

export function RecentChangesFeed() {
  const { t } = useTranslation();
  const [changes, setChanges] = useState<RecentChange[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRecentChanges(FEED_LIMIT)
      .then((data) => {
        if (!cancelled) setChanges(data.changes);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t('recentChanges.title')}</h2>
      {failed && (
        <p className="text-sm text-muted-foreground">
          {t('recentChanges.error')}
        </p>
      )}
      {!failed && changes === null && (
        <p className="text-sm text-muted-foreground">
          {t('recentChanges.loading')}
        </p>
      )}
      {!failed && changes !== null && changes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('recentChanges.empty')}
        </p>
      )}
      {!failed && changes !== null && changes.length > 0 && (
        <ul>
          {changes.map((change) => (
            <ChangeRow key={`${change.type}-${change.id}`} change={change} />
          ))}
        </ul>
      )}
    </section>
  );
}
