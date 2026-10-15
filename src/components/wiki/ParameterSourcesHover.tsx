import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DRUG_PARAMETERS, type DrugParameterId } from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';
import { preferredDisplayUnit } from '@/lib/parameterUnits';
import { useDisplayUnits } from '@/components/ui/DrugUnitScope';
import { useCloseTimer } from '@/lib/useHoverGrace';
import { ROUTE_LABEL_KEYS, ROUTE_OPTIONS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';
import type { NumericRange } from '@/types';
import { ParameterForestPlot } from './ParameterForestPlot';

/**
 * How long the pointer must rest on a value before its preview opens. The
 * preview is large, so a pointer merely crossing the parameter box on its way
 * elsewhere must not flash one open per value it passes over.
 */
export const SOURCES_PREVIEW_OPEN_DELAY_MS = 300;

const VIEWPORT_MARGIN = 8;
const TARGET_GAP = 4;

const ROUTE_ORDER: readonly string[] = ROUTE_OPTIONS;

interface Props {
  parameter: DrugParameterId;
  /** The parameter's drug-level pooled summary, when it has one. */
  summary?: ParameterSummary;
  /** The parameter's per-route pools, keyed by route. */
  routeSummaries?: Record<string, ParameterSummary>;
  /** Source values across the drug-level and per-route pools. */
  entryCount: number;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
  /** Opens the full sources dialog. */
  onOpen: () => void;
  'data-testid'?: string;
  children: ReactNode;
}

/**
 * A source-value parameter's figure, as its own entry point to the source
 * values behind it.
 *
 * Resting the pointer on the figure floats a read-only preview of the source
 * values (the same forest plot the sources dialog draws) beside it, placed
 * against the viewport so the whole preview stays in view. Clicking the figure
 * opens the full sources dialog — the same one as the hover action — with the
 * per-source list and the discussion. The preview is a pointer convenience
 * only; keyboard users reach the same plot, and more, by activating the button.
 */
export function ParameterSourcesHover({
  parameter,
  summary,
  routeSummaries,
  entryCount,
  molecularWeight,
  bloodPlasmaRatio,
  onOpen,
  'data-testid': testId,
  children,
}: Props) {
  const { t } = useTranslation();
  const { longLabel } = useParameterLabels(DRUG_PARAMETERS[parameter]);
  const enabledUnits = useDisplayUnits();
  const previewId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const { scheduleClose, cancelClose } = useCloseTimer(() => setOpen(false));

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  useEffect(() => cancelOpen, [cancelOpen]);

  const onTriggerEnter = () => {
    cancelClose();
    if (open || openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setPosition(null);
      setOpen(true);
    }, SOURCES_PREVIEW_OPEN_DELAY_MS);
  };
  const onTriggerLeave = () => {
    cancelOpen();
    scheduleClose();
  };
  const close = () => {
    cancelOpen();
    cancelClose();
    setOpen(false);
  };

  // Placed against the viewport, preferring the space below the figure and
  // flipping above when that is the side with room. Both axes are clamped and
  // the height capped (scrolling inside), so the preview is never cut off by
  // the sidebar, a scrolling ancestor or the window edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const preview = previewRef.current;
      if (!trigger || !preview) return;
      const tr = trigger.getBoundingClientRect();
      const pr = preview.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const below = tr.bottom + TARGET_GAP;
      const above = tr.top - pr.height - TARGET_GAP;
      const preferred =
        below + pr.height <= viewportH - VIEWPORT_MARGIN || above < VIEWPORT_MARGIN
          ? below
          : above;
      const maxTop = Math.max(
        VIEWPORT_MARGIN,
        viewportH - pr.height - VIEWPORT_MARGIN,
      );
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - pr.width - VIEWPORT_MARGIN,
      );
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(tr.left, maxLeft)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(preferred, maxTop)),
        maxHeight: viewportH - 2 * VIEWPORT_MARGIN,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // The trigger's description is shared: a nested UnitTooltip adds its own id
  // to this button's `aria-describedby` imperatively. Owning the attribute
  // through a React prop would overwrite that id when the preview opens and
  // drop the attribute when it closes, so only the preview's own id token is
  // added and removed here, leaving any others in place.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const tokens = (trigger.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.includes(previewId)) {
      trigger.setAttribute(
        'aria-describedby',
        [...tokens, previewId].join(' '),
      );
    }
    return () => {
      const remaining = (trigger.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((token) => token && token !== previewId);
      if (remaining.length > 0) {
        trigger.setAttribute('aria-describedby', remaining.join(' '));
      } else {
        trigger.removeAttribute('aria-describedby');
      }
    };
  }, [open, previewId]);

  // Same order as the dialog, so oral leads and the plots do not reshuffle.
  const routeEntries = Object.entries(routeSummaries ?? {}).sort(
    ([a], [b]) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b),
  );

  const preview = open
    ? createPortal(
        <div
          ref={previewRef}
          id={previewId}
          data-testid="parameter-sources-preview"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="fixed z-50 w-[min(36rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          // Measured hidden on the first frame (position still null), so the
          // panel never flashes at the corner before it is placed.
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            maxHeight: position?.maxHeight,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold">
              {t('parameterEntries.dialogTitle', { parameter: longLabel })}
            </span>
            {entryCount > 0 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('parameterEntries.sources', { count: entryCount })}
              </span>
            ) : null}
          </div>
          {summary ? (
            <ParameterForestPlot
              summary={summary}
              parameter={parameter}
              displayUnit={preferredDisplayUnit(
                summary.unit,
                enabledUnits,
                molecularWeight,
              )}
              molecularWeight={molecularWeight}
              bloodPlasmaRatio={bloodPlasmaRatio}
            />
          ) : null}
          {routeEntries.map(([route, routeSummary]) => (
            <div key={route}>
              <div className="mt-2 text-xs font-medium text-muted-foreground">
                {t('parameterEntries.routeSection', {
                  route: t(ROUTE_LABEL_KEYS[route as RouteId] ?? route, {
                    defaultValue: route,
                  }),
                })}
              </div>
              <ParameterForestPlot
                summary={routeSummary}
                parameter={parameter}
                displayUnit={preferredDisplayUnit(
                  routeSummary.unit,
                  enabledUnits,
                  molecularWeight,
                )}
                molecularWeight={molecularWeight}
                bloodPlasmaRatio={bloodPlasmaRatio}
              />
            </div>
          ))}
          {!summary && routeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('parameterEntries.dialogEmpty')}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('parameterEntries.previewHint')}
          </p>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          close();
          onOpen();
        }}
        onMouseEnter={onTriggerEnter}
        onMouseLeave={onTriggerLeave}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) close();
        }}
        className="cursor-pointer text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
        data-testid={testId}
      >
        {children}
      </button>
      {preview}
    </>
  );
}
