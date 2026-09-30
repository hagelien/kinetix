import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, SlidersHorizontal, X } from 'lucide-react';
import { loadJSON, persist } from '@/lib/storage';
import { useOverlayLayer } from '@/lib/overlayStack';
import { DrugMonographSidebar } from './DrugMonographSidebar';
import type { OrderedReference } from '@/lib/useDrugBibliography';

interface MonographParameterPanelProps {
  drugCid: number;
  sharedReferences?: OrderedReference[] | null;
  /**
   * When true there isn't room to sit the parameter box beside the article,
   * so it renders as a pop-in/out slide-over that floats over the monograph.
   * When false it renders as an in-flow sticky rail. The decision is made by
   * the parent from the *measured* space available to the monograph (not the
   * raw window width), so it adapts to any size, zoom, resolution, and to the
   * global drug-table's own expand/collapse state.
   */
  floating: boolean;
}

const PANEL_OPEN_STORAGE_KEY = 'kinetix.monographSidebar.panelOpen';

/**
 * Hosts the drug monograph parameter box. When there's room it renders the
 * familiar sticky right rail. When there isn't (a half-window and narrower)
 * it mirrors the global drug table's pop-in/out behaviour: a slim right-edge
 * handle toggles a slide-over panel that floats over the monograph content
 * instead of pushing the prose down the page (#298 parity).
 *
 * The sidebar is mounted once and reveals/hides via a CSS transform, so its
 * data fetches don't re-run when the panel opens and closes.
 */
export function MonographParameterPanel({
  drugCid,
  sharedReferences,
  floating,
}: MonographParameterPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(() =>
    loadJSON<boolean>(PANEL_OPEN_STORAGE_KEY, false),
  );

  useEffect(() => {
    persist(PANEL_OPEN_STORAGE_KEY, open);
  }, [open]);

  // The slide-over is itself an overlay layer, so it takes its turn in the
  // Escape stack: every parameter dialog opens from inside this panel, and
  // without this one Escape would close the dialog AND collapse the whole rail
  // out from under the user.
  //
  // Keyed on `open` alone, deliberately NOT on `floating`. The stack orders
  // layers by when they registered, so re-registering moves this panel to the
  // top — above a dialog that is still open. `floating` is a *measurement*: it
  // flips whenever a resize or zoom crosses the layout threshold, which would
  // re-register the rail mid-dialog and hand it an Escape meant for the dialog.
  // `open` only changes when the user opens or closes the panel, which is the
  // event that should actually reorder the stack. The rail therefore stays
  // registered while inline too — harmless, since the handler below is inert
  // unless `floating`, and it keeps this panel underneath anything opened from
  // inside it. (Ancestry can't be used instead: the dialogs portal to
  // document.body, so they are not DOM descendants of this aside.)
  const isTopOverlay = useOverlayLayer(open);

  // Close the floating panel on Escape, matching common slide-over behaviour.
  useEffect(() => {
    if (!floating || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopOverlay()) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floating, open, isTopOverlay]);

  // As an inline rail the box is always part of the flow; as a floating panel
  // only reveal it when the user pops it open. When hidden off-canvas the
  // panel stays in the DOM (to keep its fetched state), so mark it `inert`
  // to keep its controls out of the focus and accessibility trees.
  const expanded = !floating || open;
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    if (expanded) {
      el.removeAttribute('inert');
    } else {
      el.setAttribute('inert', '');
    }
  }, [expanded]);

  const asideClassName = floating
    ? `fixed right-0 top-[var(--app-header-h,57px)] bottom-0 z-50 w-[min(20rem,90vw)] overflow-y-auto border-l border-border bg-card p-4 shadow-xl transition-transform duration-300 ease-in-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`
    : 'w-80 shrink-0 sticky top-6 self-start';

  return (
    <>
      {/* Right-edge handle — only while floating and closed. Clicking it
          pops the parameter box in. */}
      {floating && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('sidebar.openParameters')}
          title={t('sidebar.openParameters')}
          className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center justify-center gap-2 rounded-l-md border border-r-0 border-border bg-muted px-1.5 py-3 text-muted-foreground shadow-md hover:bg-muted/80 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      )}

      {/* Backdrop behind the floating panel; clicking it pops the box out. */}
      {floating && open && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        ref={asideRef}
        aria-label={t('sidebar.parametersTitle')}
        className={asideClassName}
      >
        {/* Panel header with a close affordance — floating layout only. */}
        {floating && (
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">
              {t('sidebar.parametersTitle')}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('sidebar.closeParameters')}
              title={t('sidebar.closeParameters')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <DrugMonographSidebar
          drugCid={drugCid}
          sharedReferences={sharedReferences}
        />
      </aside>
    </>
  );
}
