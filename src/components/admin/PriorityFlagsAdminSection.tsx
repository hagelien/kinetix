import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  cancelPriorityFlag,
  fetchPriorityFlags,
  updatePriorityFlag,
  type PriorityFlagRow,
} from '@/lib/parameterPriorityFlagsApi';
import { UserBadge } from '@/components/ui/UserBadge';

export function PriorityFlagsAdminSection() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PriorityFlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchPriorityFlags({ status: 'active' })
      .then((data) => {
        setRows(data.flags);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleResolve(id: number) {
    try {
      await updatePriorityFlag(id, { status: 'resolved' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCancel(id: number) {
    try {
      await cancelPriorityFlag(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('review.flagsTitle')}</h2>
      <p className="text-sm text-muted-foreground mb-4">{t('review.flagsDescription')}</p>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('review.flagsLoading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('review.flagsEmpty')}</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t('review.flagDrug')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('review.flagParameter')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('review.flagNote')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('review.flagFlaggedBy')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('review.flagCreatedAt')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="px-4 py-3">{row.drugName ?? `#${row.drugId}`}</td>
                  <td className="px-4 py-3">
                    {row.parameter ?? (
                      <span className="text-muted-foreground italic">
                        {t('review.flagAnyParameter')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground max-w-md">
                    {row.note ?? ''}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserBadge user={row.flaggedByUser ?? null} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={() => handleResolve(row.id)}>
                        {t('review.flagResolve')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleCancel(row.id)}>
                        {t('review.flagCancel')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
