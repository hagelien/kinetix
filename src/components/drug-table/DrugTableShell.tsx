import { Suspense, lazy, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { ChevronsLeft } from "lucide-react";
import { useDrugStore } from "@/stores/drugStore";
import { DrugTableCollapsedHandle } from "./DrugTableCollapsedHandle";

interface DrugTableShellProps {
  children: ReactNode;
}

const DrugTable = lazy(() =>
  import("@/components/DrugTable").then((module) => ({
    default: module.DrugTable,
  })),
);
const DrugTableSidebar = lazy(() =>
  import("./DrugTableSidebar").then((module) => ({
    default: module.DrugTableSidebar,
  })),
);

const SIDEBAR_WIDTH_PX = 280;
const COLLAPSED_WIDTH_PX = 28;

/**
 * Layout shell that hosts the global, app-level drug table around the
 * route content (#298).
 *
 * Three view states share the same flex row:
 *
 * - **full** — drug table fills the entire viewport (overlaying the route
 *   content via `position: fixed`). The route still mounts behind, so any
 *   page-local state is preserved when the user collapses back.
 * - **sidebar** — narrow left rail (~280px) with the route content beside
 *   it. Each child owns its own `overflow-y-auto`, so scrolling the rail
 *   never moves the route content (and vice versa).
 * - **collapsed** — slim left handle. Clicking it re-opens the sidebar.
 *
 * The outer wrapper bounds the height to `100dvh - --app-header-h` and uses
 * `overflow: hidden` so the only scrollers are the children. Width is
 * animated with a Tailwind transition; no motion library is added.
 */
export function DrugTableShell({ children }: DrugTableShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const tableView = useDrugStore((s) => s.tableView);
  const setTableView = useDrugStore((s) => s.setTableView);
  const previousPathnameRef = useRef<string | null>(null);
  const effectiveTableView =
    location.pathname !== "/" &&
    tableView === "full" &&
    previousPathnameRef.current !== location.pathname
      ? "sidebar"
      : tableView;

  const railWidth =
    effectiveTableView === "collapsed" ? COLLAPSED_WIDTH_PX : SIDEBAR_WIDTH_PX;

  // Landing (`/`) renders its own self-scrolling pane (the welcome
  // placeholder owns an `overflow-y-auto` container). When the wrapper also
  // allows `overflow-y-auto`, even one pixel of height drift makes the
  // wrapper win — the whole panel scrolls as a unit and the inner pane can
  // no longer scroll independently (#312). Pin the wrapper to
  // `overflow-hidden` whenever the route is itself a self-scrolling pane.
  const ownsScroll = location.pathname === "/";

  // The full-table overlay covers the route content. With `tableView`
  // persisted, navigating from `/` (or refreshing while on a different
  // route) would otherwise leave the user staring at the drug table on
  // top of `/simulator`, `/login`, etc. with no obvious affordance to
  // see the page they asked for (#299 review).
  //
  // Drop to `sidebar` whenever the pathname becomes a non-landing route
  // while the table is `full`. Reads tableView via getState() and only
  // depends on `pathname` so manually expanding to full while ON a
  // non-landing route does NOT auto-collapse you back.
  useEffect(() => {
    if (
      location.pathname !== "/" &&
      useDrugStore.getState().tableView === "full"
    ) {
      useDrugStore.getState().setTableView("sidebar");
    }
    previousPathnameRef.current = location.pathname;
  }, [location.pathname]);

  // The route content stays mounted under the full-mode overlay so any
  // page-local state survives toggling. Without `inert`, keyboard and
  // screen-reader users on routes with focusable controls (login,
  // simulator, wiki edit, etc.) could tab through controls visually
  // covered by the overlay before reaching the visible drug table
  // (#299 review). `inert` removes the subtree from both focus and a11y
  // trees. React 18 doesn't recognize it as a JSX prop, so set it on
  // the DOM node directly.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (effectiveTableView === "full") {
      el.setAttribute("inert", "");
    } else {
      el.removeAttribute("inert");
    }
  }, [effectiveTableView]);

  // `flex-1` would set `flex-basis: 0` and let the wrapper grow to its
  // children's intrinsic height (the unvirtualized drug list is ~6700px).
  // In a `flex-col` parent that wins over an explicit `height`, so without
  // this fix the page scrolled the entire app vertically and any centered
  // route content (e.g. /login) ended up far below the fold (#372).
  return (
    <div className="flex flex-row min-h-0 h-[calc(100dvh-var(--app-header-h,57px))] overflow-hidden">
      <aside
        // The rail keeps a stable 280px slot during `full` so the route
        // content underneath doesn't jitter horizontally when the user
        // toggles between full and sidebar. The sidebar's controls are
        // intentionally not mounted in `full` view: `aria-hidden` on its
        // own does NOT make descendants unfocusable, so keyboard users
        // could otherwise tab into controls covered by the overlay before
        // reaching the visible full table (#299 review).
        style={{
          width: effectiveTableView === "full" ? SIDEBAR_WIDTH_PX : railWidth,
        }}
        className="shrink-0 border-r border-border bg-card transition-[width] duration-300 ease-in-out overflow-hidden"
      >
        {effectiveTableView === "sidebar" && (
          <Suspense fallback={null}>
            <DrugTableSidebar />
          </Suspense>
        )}
        {effectiveTableView === "collapsed" && <DrugTableCollapsedHandle />}
      </aside>

      {/* Default behavior is to auto-scroll vertically: most routes (Wiki,
          Simulator, Admin, …) render flow content and just want to scroll
          when they overflow. Routes that need to own their scroll —
          most importantly the landing page (#298) — set their own
          `h-full overflow-hidden` and nest scrollers inside;
          when they fill the column exactly, the column's auto-scroll never
          activates. */}
      <div
        ref={contentRef}
        className={`flex-1 min-w-0 min-h-0 flex flex-col ${ownsScroll ? "overflow-hidden" : "overflow-y-auto"}`}
      >
        {children}
      </div>

      {effectiveTableView === "full" && (
        <div
          className="fixed left-0 right-0 z-40 bg-background"
          style={{
            top: "var(--app-header-h, 57px)",
            bottom: 0,
          }}
          role="region"
          aria-label={t("drugTable.title")}
        >
          <button
            type="button"
            onClick={() => setTableView("sidebar")}
            aria-label={t("drugTable.collapseToSidebar")}
            title={t("drugTable.collapseToSidebar")}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-50 flex items-center justify-center h-12 w-6 rounded-r-md bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground border border-l-0 border-border"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
          <div className="h-full overflow-hidden">
            <Suspense fallback={null}>
              <DrugTable fullScreen />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
