import { useTranslation } from 'react-i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import type { BioEntityFunction } from '@/lib/bioEntities';

// Read-only summary of a proposed bio-entity create/update for the review
// queue. The payload carries the full desired change (create) or a partial
// patch (update); we render whichever fields the submitter set.

interface EntityFields {
  symbol?: string;
  name?: string;
  nameEn?: string | null;
  organism?: string | null;
  rank?: string | null;
  entityClass?: string | null;
  parentId?: number | null;
  functions?: BioEntityFunction[];
}

type ProposedBioEntity =
  | { op: 'create'; entity?: EntityFields }
  | { op: 'update'; patch?: EntityFields }
  | Record<string, never>;

export function BioEntityDiff({ edit }: { edit: PendingEditRow }) {
  const { t } = useTranslation();
  const value = (edit.proposedValue ?? {}) as ProposedBioEntity;
  const op = 'op' in value ? value.op : undefined;
  const fields: EntityFields =
    value.op === 'create'
      ? (value.entity ?? {})
      : value.op === 'update'
        ? (value.patch ?? {})
        : {};

  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, v: string | null | undefined) => {
    if (v != null && String(v).trim() !== '') {
      rows.push({ label, value: String(v) });
    }
  };
  push(t('entities.symbol'), fields.symbol);
  push(t('entities.nameNb'), fields.name);
  push(t('entities.nameEn'), fields.nameEn);
  push(t('entities.class'), fields.entityClass);
  if (fields.rank) push(t('entities.rank'), t(`bioEntity.ranks.${fields.rank}`));

  const functions = fields.functions ?? [];

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <div className="font-medium">
        {op === 'create'
          ? t('review.bioEntityDiff.create')
          : t('review.bioEntityDiff.update')}
      </div>
      {rows.length === 0 && functions.length === 0 ? (
        <p className="text-muted-foreground">{t('review.bioEntityDiff.empty')}</p>
      ) : (
        <>
          {rows.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {rows.map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="font-medium">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {functions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              <span className="text-muted-foreground">
                {t('entities.functions')}:
              </span>
              {functions.map((fn) => (
                <span
                  key={fn}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                >
                  {t(`bioEntity.functions.${fn}`)}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
