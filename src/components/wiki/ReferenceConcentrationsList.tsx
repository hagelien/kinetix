import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchReferenceConcentrations,
  type ReferenceCitationSummary,
  type ReferenceConcentrationRow,
} from '@/lib/referenceConcentrationsApi';
import { referenceModulePath } from '@/lib/referencesApi';
import {
  REFERENCE_SCENARIOS,
  REFERENCE_SCENARIO_LABEL_KEYS,
  REFERENCE_MATRIX_LABEL_KEYS,
  type ReferenceScenario,
} from '@/lib/referenceConcentrations';
import { UnitTooltip } from '@/components/ui/UnitTooltip';

interface Props {
  drugId: number;
  /** Used by the magic unit-conversion tooltip on each value. */
  molecularWeight?: number | null;
}

function formatValueText(row: ReferenceConcentrationRow): string {
  if (row.low != null && row.high != null) {
    return `${row.low}–${row.high} ${row.unit}`;
  }
  if (row.low != null) return `≥ ${row.low} ${row.unit}`;
  if (row.high != null) return `≤ ${row.high} ${row.unit}`;
  return '—';
}

function formatMeta(
  row: ReferenceConcentrationRow,
  t: (key: string) => string,
): string {
  const parts = [t(REFERENCE_MATRIX_LABEL_KEYS[row.matrix])];
  if (row.n != null) parts.push(`n = ${row.n}`);
  return parts.join(' · ');
}

function citationLabel(
  citation: ReferenceCitationSummary,
  fallback: string | null,
): string {
  const title = citation.metadata?.title?.trim();
  if (title) return title;
  if (fallback) return fallback;
  return citation.identifier;
}

export function ReferenceConcentrationsList({
  drugId,
  molecularWeight,
}: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReferenceConcentrationRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReferenceConcentrations(drugId)
      .then((items) => {
        if (!cancelled) setRows(items);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [drugId]);

  const grouped = useMemo(() => {
    const map = new Map<ReferenceScenario, ReferenceConcentrationRow[]>();
    if (!rows) return map;
    for (const row of rows) {
      const list = map.get(row.scenario) ?? [];
      list.push(row);
      map.set(row.scenario, list);
    }
    return map;
  }, [rows]);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="mt-4 pt-3 border-t border-border">
      <h4 className="font-semibold text-sm mb-2">{t('referenceConc.title')}</h4>
      <dl className="space-y-2 text-sm">
        {REFERENCE_SCENARIOS.map((scenario) => {
          const items = grouped.get(scenario);
          if (!items || items.length === 0) return null;
          return (
            <div key={scenario}>
              <dt className="text-muted-foreground text-xs">
                {t(REFERENCE_SCENARIO_LABEL_KEYS[scenario])}
              </dt>
              <dd className="space-y-1">
                {items.map((row) => {
                  const label = row.citation
                    ? citationLabel(row.citation, row.comments)
                    : null;
                  return (
                    <div key={row.id} className="font-medium">
                      {row.low != null || row.high != null ? (
                        <UnitTooltip
                          low={row.low}
                          high={row.high}
                          unit={row.unit}
                          molecularWeight={molecularWeight}
                        >
                          {formatValueText(row)}
                        </UnitTooltip>
                      ) : (
                        <span>{formatValueText(row)}</span>
                      )}
                      <span className="ml-2 text-xs text-muted-foreground font-normal">
                        {formatMeta(row, t)}
                      </span>
                      {row.citation ? (
                        <div className="text-xs text-muted-foreground font-normal">
                          <a
                            href={referenceModulePath(row.citation.id)}
                            className="text-primary underline hover:no-underline break-words"
                          >
                            {label}
                          </a>
                        </div>
                      ) : (
                        row.comments && (
                          <div className="text-xs text-muted-foreground font-normal">
                            {row.comments}
                          </div>
                        )
                      )}
                      {/* Observation context (migration 0120) — facts about the
                          reading, distinct from `comments`'s curator commentary.
                          Shown independent of the citation link, like `comments`. */}
                      {row.observationContext && (
                        <div className="text-xs text-muted-foreground font-normal">
                          {row.observationContext}
                        </div>
                      )}
                    </div>
                  );
                })}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
