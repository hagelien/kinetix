import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { refsStatementText } from '@/lib/refsStatementText';
import type {
  RefsDetectionReading,
  RefsRowMatch,
  RefsUrineDetectionPayload,
  RefsUrineDetectionRow,
} from '@/lib/refsDetectionTimes';

/**
 * Render an ISO date-only value as the calendar date it is.
 *
 * `new Date('2025-09-01')` is midnight UTC, and `toLocaleDateString()` then
 * renders it in the reader's zone — which west of UTC is the day before. That
 * is a controlled document's approval date printed wrong, and the whole point
 * of showing it is that a reader can match it against the document in their
 * hand. Reading the parts and formatting in UTC keeps the date the guideline
 * carries.
 */
export function formatCalendarDate(iso: string, language: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  const [, year, month, day] = parts;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  ).toLocaleDateString(language, { timeZone: 'UTC' });
}

interface Props {
  payload: RefsUrineDetectionPayload;
  /** Rows the selected substance is named in; empty when nothing is selected. */
  matches: RefsRowMatch[];
  /** Name of the selected substance, for the "not in the table" message. */
  substanceName: string | null;
  loading: boolean;
}

/**
 * Rettstoks's own urine detection times, for members of the Rettstoks group.
 *
 * Deliberately a section of its own, below the pooled windows and framed
 * differently: the pooled cards answer "what does the literature say", this one
 * answers "what does REFS state", and the two are not interchangeable. A band
 * here is what goes in a svarbrev; a band there is an aggregate of published
 * source values at cut-offs that are not REFS's. Merging them, or rendering
 * them in the same grid, would invite exactly the substitution the guideline
 * warns against — so the frame, the heading and the document line are all part
 * of the answer, not decoration around it.
 */
export function RefsDetectionSection({
  payload,
  matches,
  substanceName,
  loading,
}: Props) {
  const { t, i18n } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  const approvedFrom = useMemo(
    () => formatCalendarDate(payload.source.approvedFrom, i18n.language),
    [payload.source.approvedFrom, i18n.language],
  );

  return (
    <section
      data-testid="refs-detection-section"
      aria-labelledby="refs-detection-title"
      className="rounded-lg border-2 border-primary/40 bg-primary/[0.04] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3
            id="refs-detection-title"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <ShieldCheck className="h-4 w-4 text-primary" />
            {t('detection.refs.title')}
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            {t('detection.refs.intro')}
          </p>
        </div>
        <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {t('detection.refs.badge')}
        </span>
      </div>

      {loading && payload.rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : (
        <>
          {substanceName != null && matches.length === 0 && (
            <p
              data-testid="refs-detection-no-match"
              className="mt-3 text-xs text-muted-foreground"
            >
              {t('detection.refs.noMatch', { name: substanceName })}
            </p>
          )}

          {matches.length > 0 && (
            <div className="mt-3 space-y-3">
              {matches.map((match) => (
                <RefsRowCard
                  key={`${match.row.key}-${match.role}`}
                  match={match}
                />
              ))}
            </div>
          )}

          <div className="mt-4 border-t border-primary/20 pt-3">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              aria-expanded={showAll}
              onClick={() => setShowAll((open) => !open)}
            >
              {showAll
                ? t('detection.refs.hideTable')
                : t('detection.refs.showTable', { count: payload.rows.length })}
            </Button>

            {showAll && (
              <div className="mt-3">
                {payload.preamble && (
                  <p
                    lang="nb"
                    className="mb-2 max-w-3xl text-[11px] text-muted-foreground"
                  >
                    {payload.preamble}
                  </p>
                )}
                <RefsFullTable rows={payload.rows} />
              </div>
            )}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            {t('detection.refs.sourceLine', {
              title: payload.source.title,
              documentId: payload.source.documentId,
              version: payload.source.version,
              approvedFrom,
            })}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {payload.source.unit} · {payload.source.classification}
          </p>
        </>
      )}
    </section>
  );
}

/** One guideline row, as the reader's own substance appears in it. */
function RefsRowCard({ match }: { match: RefsRowMatch }) {
  const { t } = useTranslation();
  const { row, role, matchedName } = match;

  return (
    <div
      data-testid={`refs-row-${row.key}`}
      className="rounded-md border border-primary/25 bg-card p-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold">{row.parent}</span>
        {row.metabolites.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('detection.refs.metabolites', {
              names: row.metabolites.join(', '),
            })}
          </span>
        )}
      </div>

      {/* Why this row is on screen at all. Reaching a row through its
          metabolite column is the guideline's own cross-reference — the urine
          screen finds THC-syre, not THC — and hiding that would leave the
          reader wondering why they are looking at a different substance. */}
      {role === 'metabolite' && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('detection.refs.viaMetabolite', {
            metabolite: matchedName,
            parent: row.parent,
          })}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {row.readings.map((reading, index) => (
          <ReadingChip key={index} reading={reading} />
        ))}
      </div>

      {row.comment && (
        <p lang="nb" className="mt-2 text-xs text-muted-foreground">
          {row.comment}
        </p>
      )}
      {row.detail && (
        <p lang="nb" className="mt-2 text-xs">
          {row.detail}
        </p>
      )}
    </div>
  );
}

/**
 * One cell of the guideline's detection-time column.
 *
 * The scope label is only drawn when the row splits by it. On a row that
 * states one time for the pair, "moderstoff" would be a distinction the
 * guideline did not make.
 */
function ReadingChip({ reading }: { reading: RefsDetectionReading }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {reading.scope !== 'both' && (
        <span className="text-[10px] font-normal uppercase tracking-wide opacity-80">
          {t(`detection.refs.scope.${reading.scope}`)}
        </span>
      )}
      {refsStatementText(reading.statement, t)}
    </span>
  );
}

/** The whole guideline table, for a member who wants the overview. */
function RefsFullTable({ rows }: { rows: RefsUrineDetectionRow[] }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('detection.refs.column.parent')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('detection.refs.column.metabolites')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('detection.refs.column.time')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('detection.refs.column.comment')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-testid={`refs-table-row-${row.key}`}
              className="border-t border-border"
            >
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {row.parent}
              </th>
              <td className="px-3 py-2 text-muted-foreground">
                {row.metabolites.join(', ') || '—'}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {row.readings.map((reading, index) => (
                    <ReadingChip key={index} reading={reading} />
                  ))}
                </div>
              </td>
              <td lang="nb" className="px-3 py-2 text-muted-foreground">
                {row.comment ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RefsDetectionSection;
