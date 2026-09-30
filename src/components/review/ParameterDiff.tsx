import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatRange,
  representativeValue,
  showFractionAsPercent,
  type FractionDisplay,
} from '@/lib/rangeUtils';
import {
  formatReference,
  referenceModulePath,
  type ReferenceRow,
} from '@/lib/referenceApi';
import type { NumericRange } from '@/types';
import { getParameterSpec } from '@/lib/drugParameters';
import { isConcentrationParameterId } from '@/lib/unitTooltip';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { useFractionDisplay } from '@/stores/appStore';

interface ParameterDiffProps {
  parameter?: string | null;
  currentValue: unknown;
  proposedValue: unknown;
  referenceId?: number | null;
  reference?: ReferenceRow | null;
  references?: ReferenceRow[];
  /**
   * References attached to the parameter's current (latest-applied) revision.
   * Compared against the proposed references so the diff can flag a
   * references-only change and mark added/removed citations (#857).
   */
  currentReferences?: ReferenceRow[];
  currentReferenceIds?: number[];
  /** Target drug's molecular weight, enabling molar↔mass conversion tooltips. */
  molecularWeight?: number | null;
}

/** How a reference row relates to the proposed vs. current reference sets. */
type ReferenceState = 'added' | 'removed' | 'unchanged';

function formatForDiff(
  parameter: string | null | undefined,
  value: unknown,
  fractionDisplay: FractionDisplay,
): string {
  if (value === null || value === undefined) return '';
  let asPercent = false;
  if (parameter) {
    const spec = getParameterSpec(parameter);
    if (spec) {
      // PK params still use formatRange so the showNote=false behaviour is
      // preserved; metadata kinds delegate to the registry's format helper.
      // `list` (e.g. aliases) must be included here too (#1311): its stored
      // value is a string array, not a NumericRange, so falling through to
      // formatRange below silently produced '' for both live and proposed —
      // the diff card looked entirely blank even though a real value was
      // proposed.
      if (spec.kind === 'text' || spec.kind === 'number' || spec.kind === 'list') {
        return spec.format(value);
      }
      asPercent = showFractionAsPercent(spec.kind, fractionDisplay);
    }
  }
  return formatRange(value as NumericRange | null, {
    showNote: false,
    asPercent,
  });
}

/**
 * Render a single diff value. Concentration-valued range parameters are
 * wrapped in `UnitTooltip` so a reviewer can hover the value and read it in
 * every enabled unit — the same magic-conversion affordance the monograph
 * sidebar offers. Falls back to plain formatted text otherwise.
 */
function renderDiffValue(
  parameter: string | null | undefined,
  value: unknown,
  molecularWeight: number | null | undefined,
  fractionDisplay: FractionDisplay,
): ReactNode {
  const formatted = formatForDiff(parameter, value, fractionDisplay) || '—';
  if (
    !isConcentrationParameterId(parameter) ||
    value === null ||
    typeof value !== 'object'
  ) {
    return formatted;
  }
  const range = value as NumericRange;
  // The stored unit wins (a range may carry a non-canonical unit); fall back
  // to the parameter's canonical unit so the tooltip still knows the kind.
  // isConcentrationParameterId already guaranteed a range-kind spec.
  const spec = getParameterSpec(parameter ?? '');
  const unit =
    range.unit ??
    (spec && spec.kind === 'range' ? spec.canonicalUnit : undefined);
  return (
    <UnitTooltip
      value={representativeValue(range)}
      low={typeof range.min === 'number' ? range.min : null}
      high={typeof range.max === 'number' ? range.max : null}
      unit={unit}
      molecularWeight={molecularWeight ?? null}
    >
      {formatted}
    </UnitTooltip>
  );
}

export function ParameterDiff({
  parameter,
  currentValue,
  proposedValue,
  referenceId,
  reference,
  references,
  currentReferences,
  currentReferenceIds,
  molecularWeight,
}: ParameterDiffProps) {
  const { t } = useTranslation();
  const fractionDisplay = useFractionDisplay();

  const proposedRefs =
    references && references.length > 0
      ? references
      : reference
        ? [reference]
        : [];

  const proposedIds = new Set(proposedRefs.map((r) => r.id));
  const currentIds = new Set(currentReferenceIds ?? []);
  const addedIds = new Set(
    proposedRefs.map((r) => r.id).filter((id) => !currentIds.has(id)),
  );
  const removedIds = (currentReferenceIds ?? []).filter(
    (id) => !proposedIds.has(id),
  );
  const referencesChanged = addedIds.size > 0 || removedIds.length > 0;
  const valueUnchanged =
    formatForDiff(parameter, currentValue, fractionDisplay) ===
    formatForDiff(parameter, proposedValue, fractionDisplay);
  // The case #857 targets: the value is untouched and only the citations moved.
  // Add/remove highlighting is scoped to this case — when the value itself
  // changes, the value diff is the headline and the reference list renders
  // plainly, exactly as before.
  const referencesOnlyChange = valueUnchanged && referencesChanged;

  // Resolve every reference row we might display (proposed + removed-current).
  const refById = new Map<number, ReferenceRow>();
  for (const r of currentReferences ?? []) refById.set(r.id, r);
  for (const r of proposedRefs) refById.set(r.id, r);

  // Proposed references first (marked added when new to a references-only
  // change), then any current reference the proposal drops (struck through).
  const displayRefs: Array<{ row: ReferenceRow; state: ReferenceState }> = [];
  for (const r of proposedRefs) {
    displayRefs.push({
      row: r,
      state: referencesOnlyChange && addedIds.has(r.id) ? 'added' : 'unchanged',
    });
  }
  if (referencesOnlyChange) {
    for (const id of removedIds) {
      const row = refById.get(id);
      if (row) displayRefs.push({ row, state: 'removed' });
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      {referencesOnlyChange ? (
        <div className="space-y-1.5">
          <span className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {t('review.referencesChanged')}
          </span>
          <div className="text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('review.valueUnchanged')}:{' '}
            </span>
            <span className="font-medium">
              {renderDiffValue(
                parameter,
                currentValue,
                molecularWeight,
                fractionDisplay,
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              {t('review.live')}
            </div>
            <div className="text-sm font-medium">
              {renderDiffValue(
                parameter,
                currentValue,
                molecularWeight,
                fractionDisplay,
              )}
            </div>
          </div>

          <div className="hidden text-xs text-muted-foreground sm:block">→</div>

          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              {t('review.proposed')}
            </div>
            <div className="text-sm font-medium">
              {renderDiffValue(
                parameter,
                proposedValue,
                molecularWeight,
                fractionDisplay,
              )}
            </div>
          </div>
        </div>
      )}

      {displayRefs.length > 0 ? (
        <div className="mt-2 space-y-1 rounded border border-border bg-background/50 px-2 py-1.5 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">
            {displayRefs.length === 1
              ? t('review.citation')
              : t('review.citations')}
            :
          </div>
          <ol className="list-decimal space-y-0.5 pl-4">
            {displayRefs.map(({ row, state }) => (
              <li
                key={`${state}-${row.id}`}
                className={
                  state === 'removed'
                    ? 'text-muted-foreground line-through decoration-rose-500/70'
                    : undefined
                }
              >
                <ReferenceLink refRow={row} />
                {state === 'added' ? (
                  <ReferenceStateTag
                    label={t('review.referenceAdded')}
                    className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  />
                ) : state === 'removed' ? (
                  <ReferenceStateTag
                    label={t('review.referenceRemoved')}
                    className="bg-rose-500/15 text-rose-700 dark:text-rose-300"
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : referenceId ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('review.citationAttached', { id: referenceId })}
        </p>
      ) : null}
    </div>
  );
}

function ReferenceStateTag({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide no-underline ${className}`}
    >
      {label}
    </span>
  );
}

function ReferenceLink({ refRow }: { refRow: ReferenceRow }) {
  const label = formatReference(refRow);

  return (
    <a
      href={referenceModulePath(refRow.id)}
      className="text-primary underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {label}
    </a>
  );
}
