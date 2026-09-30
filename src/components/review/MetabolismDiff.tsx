import { useTranslation } from 'react-i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import {
  eliminationRouteKindKey,
  formatFractionRangePercent,
  toFractionRange,
  type EliminationRouteKind,
  type MetabolismFractionRange,
} from '@/lib/metabolism';

// Proposed fractions may arrive as the new { min, median, max } range or, for
// pending edits queued before ranges existed, a bare 0–1 number.
type ProposedFraction =
  | MetabolismFractionRange
  | { min?: number | null; median?: number | null; max?: number | null }
  | number
  | null;

// Read-only summary of a proposed metabolism box for the review queue. The
// payload is full-replace, so we render the complete desired state rather
// than a field-by-field diff.

interface ProposedRoute {
  kind?: EliminationRouteKind;
  enzymeId?: number | null;
  label?: string | null;
  fraction?: ProposedFraction;
  note?: string | null;
}

interface ProposedMetabolite {
  metaboliteName?: string;
  conversionFraction?: ProposedFraction;
  activity?: string;
}

interface ProposedPrecursor {
  precursorName?: string;
  precursorDrugId?: number;
  conversionFraction?: ProposedFraction;
  activity?: string;
}

interface ProposedMetabolism {
  profile?: {
    evidenceNote?: string | null;
  };
  routes?: ProposedRoute[];
  metabolites?: ProposedMetabolite[];
  precursors?: ProposedPrecursor[];
}

function pct(value: ProposedFraction | undefined): string | null {
  return formatFractionRangePercent(toFractionRange(value ?? null));
}

export function MetabolismDiff({ edit }: { edit: PendingEditRow }) {
  const { t } = useTranslation();
  const value = (edit.proposedValue ?? {}) as ProposedMetabolism;
  const profile = value.profile ?? {};
  const routes = value.routes ?? [];
  const metabolites = value.metabolites ?? [];
  const precursors = value.precursors ?? [];

  const hasAnything =
    routes.length > 0 ||
    Boolean(profile.evidenceNote && profile.evidenceNote.trim()) ||
    metabolites.length > 0 ||
    precursors.length > 0;

  function activityLabel(activity: string | undefined): string {
    if (activity === 'active') return t('sidebar.metabolismActive');
    if (activity === 'inactive') return t('sidebar.metabolismInactive');
    return t('sidebar.metabolismUnknownActivity');
  }

  function routeName(route: ProposedRoute): string {
    const kind = route.kind ?? 'enzyme';
    if (route.label && route.label.trim()) return route.label.trim();
    return t(`metabolismRoute.${eliminationRouteKindKey(kind)}`);
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <div className="font-medium">{t('review.metabolismDiff.proposed')}</div>
      {!hasAnything ? (
        <p className="text-muted-foreground">{t('review.metabolismDiff.empty')}</p>
      ) : (
        <dl className="space-y-2">
          {routes.length > 0 ? (
            <div>
              <dt className="text-muted-foreground">
                {t('review.metabolismDiff.routes')}
              </dt>
              <dd>
                <ul className="space-y-0.5">
                  {routes.map((r, i) => (
                    <li key={i} className="font-medium">
                      {routeName(r)}
                      <span className="font-normal text-muted-foreground">
                        {pct(r.fraction) ? ` ${pct(r.fraction)}` : ''}
                        {r.kind && r.kind !== 'enzyme'
                          ? ''
                          : ` · ${t(`metabolismRoute.${eliminationRouteKindKey(r.kind ?? 'enzyme')}`)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {metabolites.length > 0 ? (
            <div>
              <dt className="text-muted-foreground">
                {t('review.metabolismDiff.metabolites')}
              </dt>
              <dd>
                <ul className="space-y-0.5">
                  {metabolites.map((m, i) => (
                    <li key={i} className="font-medium">
                      {m.metaboliteName}
                      <span className="font-normal text-muted-foreground">
                        {pct(m.conversionFraction)
                          ? ` ${pct(m.conversionFraction)}`
                          : ''}{' '}
                        · {activityLabel(m.activity)}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {precursors.length > 0 ? (
            <div>
              <dt className="text-muted-foreground">
                {t('review.metabolismDiff.precursors')}
              </dt>
              <dd>
                <ul className="space-y-0.5">
                  {precursors.map((p, i) => (
                    <li key={i} className="font-medium">
                      {p.precursorName ?? `#${p.precursorDrugId}`}
                      <span className="font-normal text-muted-foreground">
                        {pct(p.conversionFraction)
                          ? ` ${pct(p.conversionFraction)}`
                          : ''}{' '}
                        · {activityLabel(p.activity)}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {profile.evidenceNote && profile.evidenceNote.trim() ? (
            <div>
              <dt className="text-muted-foreground">
                {t('review.metabolismDiff.note')}
              </dt>
              <dd className="font-medium">{profile.evidenceNote}</dd>
            </div>
          ) : null}
        </dl>
      )}
    </div>
  );
}
