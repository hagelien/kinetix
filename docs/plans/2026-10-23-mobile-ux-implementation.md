# Kinetix mobile UX: implementation specification

**Status:** Proposed implementation design (documentation only)  
**Date:** 2026-10-23  
**Target repository:** `hagelien/kinetix`, default branch `main`  
**Primary delivery:** Responsive React web application followed by an installable Progressive Web App (PWA)  
**Native Android:** Explicitly deferred unless future requirements justify a native bridge  
**Scientific/API/database changes:** None required for the initial mobile UX rollout

## 1. Executive decision

Build a **purpose-designed mobile interface on top of the current React 18 / TypeScript / Vite / Tailwind codebase**, not a parallel Android app. Share domain logic, routing, authentication, scientific computation, database/API contracts, permissions, internationalization and persistent user preferences. Use different presentation and interaction patterns for mobile where the desktop interface is intrinsically unsuitable.

This is **not** a mandate to make every desktop tool look identical on a phone. Optimize the primary reading and lookup journeys first; keep advanced tools reachable, complete and scientifically faithful, with explicit full-screen views where necessary.

Adopt a **mobile-first experience, desktop-preserving implementation**:
- Mobile: search-led, one task per screen, bottom navigation, touch-first controls, progressive disclosure.
- Tablet: adaptive content density without relying on an always-visible narrow desktop sidebar.
- Desktop: retain the existing high-density table, multi-column monographs, keyboard-oriented command palette and advanced workspaces.

Introduce PWA installation only after the mobile shell and core journeys are satisfactory. Installation alone does not fix the UX.

## 2. Goals, non-goals and invariants

### 2.1 User goals

1. From opening Kinetix on a phone, find a substance and reach a relevant monograph section without navigating a desktop-sized table.
2. Read PK/PD, analytical and forensic data clearly, including **units, ranges, qualifiers, citations, evidence strength and important uncertainty**, without accidental loss of information.
3. Convert concentrations and reach related compounds/metabolites with minimal steps.
4. Review a graph or comparison on mobile using explicitly touch-supported interactions.
5. Resume the same substance, tab, relevant search context or modeling case across viewport changes and links.
6. Install Kinetix on Android as an app-like experience, without creating a second scientific codebase.

### 2.2 Engineering goals

- Preserve desktop behavior by default and avoid wholesale component rewrites.
- Reuse existing access controls, data loaders, monograph tab URLs, conversions and models.
- Keep mobile layout decisions separate from pharmacological computation.
- Add repeatable, automated mobile E2E and accessibility coverage.
- Deliver incremental, reviewable PRs with independently useful outcomes and rollback options.

### 2.3 Non-goals

- A new Kotlin/Jetpack Compose application or a React Native rewrite.
- Changing calculations, models, parameter aggregation, precision policy, scientific sources or reporting limits as part of a layout redesign.
- Changing Neon schemas, Vercel API semantics, user roles or permission grants.
- Guaranteeing fully offline access to clinical/forensic reference data.
- Mirroring all desktop admin/editor workflows in the first mobile release.
- Using CSS to hide important interpretation qualifications, missing-data notices, contradictory evidence or citations.
- Changing public versus authenticated routes merely to accommodate mobile navigation.

### 2.4 Hard invariants

**SCI-01 Scientific parity.** Given identical inputs, the displayed numerical quantities, underlying unrounded values, units, uncertainty bands, source references, model versions and results are unchanged. Mobile-specific formatting must not obscure meaningful distinctions or replace non-results with plausible values.

**SCI-02 Provenance.** Citations, reference identifiers, data qualifiers and verification badges stay accessible via keyboard and touch. If a view initially collapses detail, an obvious labeled action reveals it.

**SCI-03 Authorization.** Mobile discovery surfaces respect the same role/capability gates as desktop. Route/API permission enforcement remains authoritative; UI visibility is not a security boundary.

**SCI-04 Deep links.** Existing `/wiki/:slug/:tab`, `?param=...`, `?fact=...`, `?view=...`, `/modeling?mode=...`, `/detection-times?drug=...` and legacy modeling redirects continue to resolve.

**SCI-05 Desktop regression safety.** Desktop table, keyboard shortcuts, monograph tabs, graphs, comparison, floating tools and moderator workflows remain available and retain established behavior.

**SCI-06 Browser refresh and viewport changes.** Switching portrait/landscape, resizing or rotating does not discard unsaved work, active selections or route parameters. A mobile user who opens a desktop-size viewport does not corrupt the persisted desktop table state.

## 3. Audited starting point (as of 2026-10-23)

The following are code observations, not measurements from a live phone usability study:

| Area | Current implementation | Mobile implication |
|---|---|---|
| Stack | `package.json`, `vite.config.ts`: React 18, Vite, Tailwind, Zustand, React Router | Reuse current frontend and APIs |
| App shell | `src/components/RootLayout.tsx` composes `Header`, `DrugTableShell`, `Outlet`, floating basket/converter | Main refactor boundary |
| Drug navigation | `src/components/drug-table/DrugTableShell.tsx` maintains `full`, `sidebar` (~280px) and `collapsed` (28px), fixed viewport height | Desktop rail unsuitable as the primary mobile navigation |
| Header | `src/components/Header.tsx` contains wrapping nav, role-dependent links, settings, notifications, drug context, eight tab links | Needs a separate, compact mobile presentation |
| Search | `src/components/CommandPalette.tsx` already searches drugs, wiki, methods and references, but the header hides its launcher on small screens | Reuse search behavior, expose a mobile launcher |
| Drug table | `src/components/DrugTable.tsx` is a dense, configurable table; `src/components/drug-table/` also contains shared search/sidebar pieces | Mobile list should be a new projection of existing data, not a second catalog |
| Monographs | `src/pages/wiki/WikiPage.tsx` and `src/lib/monographTabs.ts` use eight bookmarkable topic tabs | Preserve canonical URLs and mapped prose/parameter sections |
| Monograph data | `src/components/wiki/DrugMonographSidebar.tsx` already uses a single column below `md` for some groups | Incrementally refine row and action presentation |
| Floating actions | `src/components/FloatingBasket.tsx` and `src/components/FloatingUnitConverter.tsx` are fixed at bottom-right | Conflict with a mobile bottom nav and virtual keyboard |
| Visualization | `src/components/modeling/ModelingChart.tsx` uses responsive Plotly with hover-oriented labels/toolbar | Needs explicit inspect, pan/zoom, reset and full-screen behavior |
| Tables | Comparison, detection times, postmortem and other surfaces use wide/scrollable tables | Preserve columns and source labels through purposeful mobile alternatives |
| Tests | `playwright.config.ts` has desktop Chromium, Firefox and WebKit projects | Add mobile device projects and cross-viewport regression tests |
| Current mobile accommodations | Tailwind breakpoints, touch-visible `hover-actions` in `src/index.css`, clipped/scrollable math and some dialogs | Preserve these fixes; do not falsely claim there is no responsive support |
| PWA | No root web app manifest or service-worker registration was found in the inspected files | Plan installability and caching separately |

Important domain detail: `data/components.ts` is an offline/seed fallback and **not an automatically current mirror of database facts**; see `AGENTS.md`. The mobile/PWA strategy must not present it as a guaranteed up-to-date authoritative clinical reference.

## 4. Experience architecture and information hierarchy

### 4.1 Viewport tiers

Use these initial design bands, subject to visual validation; **break on available space and actual content**, not on Android device detection:
- **Compact mobile:** below 768 CSS px. Dedicated mobile shell; no persistent 280px rail.
- **Intermediate/tablet:** 768–1023 CSS px. One- or two-column content when it fits; optional collapsible drug panel; keep touch controls where the pointer is coarse.
- **Wide/desktop:** 1024 CSS px and above. Preserve the desktop shell and dense tools.

Test 320, 360, 375/390, 412/430, 768, 1024 and 1440 CSS px, with tall/short screens, landscape, 200% text zoom, physical and on-screen keyboards. Keep `prefers-reduced-motion` and coarse-pointer detection independent of viewport width.

The mobile shell should use CSS-safe-area insets (`env(safe-area-inset-*)`), `100dvh` where appropriate, logical layout spacing, and natural page scrolling unless a tool clearly requires an isolated scroller. Do not disable user zoom.

### 4.2 Top-level navigation

**Compact header:**
- Back/navigation affordance when meaningful, contextual title or current substance, a prominent search trigger, and access to account/notifications through contextual controls.
- Do not render the full desktop row of links or duplicate eight monograph tabs at the top.
- Prefer one stable header height over multi-row wrapping.

**Bottom navigation (proposed four destinations):**
1. **Drugs:** drug discovery and recent/selected substance context; route `/` and existing drug-monograph links.
2. **Search:** full-screen unified search across permitted content.
3. **Tools:** concentration converter, basket/comparison, relevant modeling/detection tools as permitted.
4. **More:** references, methods, wiki index, preferences, review/admin and remaining feature links, filtered by the same capability/visibility policy as desktop.

Do not put a permission-gated route in a permanent bottom slot for anonymous visitors. It is acceptable for Tools/More to surface only permitted actions. Search is an overlay/view and need not create a new canonical route unless deep linking to queries is explicitly wanted.

Use a single source of truth for menu metadata and capability predicates. `NAV_ITEM_DEFS` in `src/lib/navItems.ts` is a starting point, but `Header` currently adds separate special logic. Extract a shared **resolved navigation model** that both desktop and mobile consume, preserving admin visibility exceptions and loading behavior when hidden-navigation settings have not resolved. Server-side gates remain unchanged.

### 4.3 Screen transitions

- Drug selection from mobile list: navigate directly to the canonical monograph page (or numeric drug preview fallback) and preserve the current search query when returning.
- Browser back: return to search/list with prior query and scroll where practical.
- Monograph section changes: update the canonical tab URL; keep the current substance.
- Opening and closing an overlay: restore focus to the launcher and do not create an accidental extra browser-history entry.
- Bottom navigation: respect native browser back/forward and React Router; no parallel navigation history implementation.
- Desktop ↔ mobile resize: derive shell from current viewport without rewriting stored `tableView` to `sidebar` or `collapsed`.

## 5. Shared frontend architecture

### 5.1 Suggested component boundaries

These are proposed names, not claims that the files already exist:

| Component/module | Responsibility |
|---|---|
| `src/components/layout/ResponsiveAppShell.tsx` | Chooses layout projection while preserving route outlet and shared stores |
| `src/components/layout/MobileHeader.tsx` | Compact title, search launcher, contextual actions |
| `src/components/layout/MobileBottomNav.tsx` | Fixed/sticky navigation with safe-area support |
| `src/components/layout/MobileMoreMenu.tsx` | Permission-filtered secondary routes |
| `src/components/search/useUnifiedSearch.ts` | Shared search orchestration extracted from CommandPalette, preserving ranking, results, permissions |
| `src/components/search/MobileSearchView.tsx` | Full-screen keyboard/touch-first search presentation |
| `src/components/drug-table/MobileDrugList.tsx` | Compact catalog list with no table-column assumptions |
| `src/components/wiki/MobileMonographSections.tsx` | URL-driven topic/section picker |
| `src/components/ui/MobileSheet.tsx` | Accessible sheet using existing overlay/focus infrastructure |
| `src/lib/responsive.ts` or hook | Breakpoint and pointer capabilities; no hard-coded UA detection |
| `e2e/mobile-*.spec.ts` | Mobile UX end-to-end tests |

Avoid adding all components before they are needed; implement an incremental adaptation of `RootLayout` / `DrugTableShell` first.

### 5.2 Component and state rules

- Existing stores remain authoritative for substance, user preferences, comparison basket and modeling cases.
- Do **not** duplicate medical/scientific data in new mobile-specific stores or create a separate mobile conversion function.
- Keep mobile transient UI state (open sheet, visible search results, section-picker state) local where possible.
- Explicitly separate desktop table display state from mobile shell state. `tableView` is persisted by `src/stores/drugStore.ts` and must not be toggled merely because a viewport crossed a breakpoint.
- Mount only one active global navigation and one active modal/search focus trap; avoid hidden duplicates in the focus/accessible tree.
- Deep-link handling and canonical URL resolution remain within React Router and existing helpers.
- Preserve persisted locale/theme/unit preferences; avoid unrequested preference migrations.
- All user-visible new strings need Norwegian and English translations.

### 5.3 UI primitives

Prefer shared, accessible primitives rather than one-off bottom sheets and touch callbacks in every screen:
- ≥44×44 CSS px primary touch targets, or equivalent comfortable hit areas without overlapping controls.
- Clearly visible focus indicator, labels, dismiss/back action, focus restoration.
- Dialog/sheet trapping only when modal, inert background, Escape support and overlay-stack coordination.
- Keyboard-aware layout; sheet content remains reachable when Android/iOS soft keyboard is open.
- Forms use `inputMode="decimal"` with locale-aware parsing when appropriate, not a numeric widget that silently normalizes precision or rejects decimal commas.
- Do not rely on hover for essential metadata, edits, citations, tooltips or source inspection.
- Use current theme tokens and respect high text scaling, reduced motion, light/dark mode.
- Wide code, formulas and scientific tables scroll in their own intentional region, never by making the whole app horizontally scroll.

## 6. Functional specification by surface

### M01. Mobile app shell and navigation (P0)

**Behavior**
- On compact viewports, show a compact header, one primary scrollable content area and bottom navigation outside content flow.
- Hide, not merely overlay, the desktop drug sidebar/handle and expansive top nav from focus/accessibility where not appropriate.
- Maintain safe padding below page content and above soft keyboard, including landscape/notches.
- Include clear active tab, labels, deep-link entry, logged-out/login entry, loading states and sign-out in More/account.
- Avoid floating controls obscuring body text, submission actions or bottom-nav items.
- Notification and review entry points stay accessible to permitted users without dominating the shell.

**Acceptance**
- At 320px wide the top-level shell has no unintended horizontal scroll; all primary controls remain reachable.
- Browser back, direct link, refresh, resize and sign-in/out work without stale nav items or overlapping focus traps.
- Desktop at ≥1024px retains the current rail/full/collapsed behaviors.

### M02. Unified search and mobile substance discovery (P0)

**Behavior**
- Tapping Search opens a full-height search surface with focused input, dismiss affordance and visible loading/empty/error states.
- Reuse existing `CommandPalette` search semantics and backend APIs for permitted drug, method, reference and wiki hits.
- Keep domain-specific affordances: generic and alternative names, aliases, method code matching where permitted, ranked results, results subtitles and direct navigation.
- Avoid leaking privileged wiki/method/reference results to users without access.
- Show a clear distinction between a drug entity, a wiki topic, a reference and a method.
- Support paste, diacritics, keyboard submit, touch selection, cancellation of stale requests and no-result recovery.
- Preserve recent selection/search context locally only if privacy requirements and product design allow. Do not store clinical searches in analytics by default.

**Acceptance**
- A signed-out user can search and select a permitted drug; restricted results are not exposed.
- Searching a drug name/alias and selecting a result opens the correct page with a functioning Back path.
- Rapid changes to a query never show stale results as the latest answer; results are operable by touch and keyboard.
- Existing desktop Ctrl/Cmd+K behavior and ranking are regression-tested.

### M03. Mobile drug list (P0)

**Behavior**
- Replace the dense desktop table with a virtualizable, one-column search/list of substances on compact screens.
- Each row presents name, secondary identifier where available, and at most a small number of user-relevant summary facts.
- A tap opens the full canonical monograph; contextual actions can add a drug to comparison or launch a tool where permitted.
- Preserve search/sort/filter and analytical-method matching rather than implementing a second incomplete dataset.
- Keep the full configurable table available on larger screens. On mobile, offer an explicit full-table/landscape view only when it is genuinely useful.
- If list size warrants virtualization, preserve screen-reader semantics, scroll restoration and stable row heights.

**Acceptance**
- Large catalogs remain responsive on mid-range Android hardware.
- The mobile list shares the same relevant search/filter results and canonical drug identities as desktop.
- No hidden desktop column silently becomes inaccessible; advanced data is reachable via monograph or explicit full-table mode.

### M04. Drug monographs and evidence navigation (P0)

**Behavior**
- Keep the eight existing sections from `MONOGRAPH_TAB_IDS`, their content mapping and URLs. Replace the crowded mobile horizontal header tab row with a compact **Sections** picker; consider a short horizontal subnav only if usability testing demonstrates it performs better.
- Monograph title, selected section, source/verification indicators and primary facts should be immediately legible.
- Use one-column fact blocks on small screens and established two/three-column layouts where space permits.
- Reveal detailed source records, measurement context, alternative units, interpretation notes and discussions via explicitly labeled actions.
- Preserve original units and precision policy; an abbreviated card must not imply a falsely precise single value when the source is a range or dependent on matrix/route.
- Deep links to a fact, parameter, discussion, history or revision must open the correct section and target even when the related controls are in a mobile sheet.
- Preserve anchored location on tab changes where appropriate; do not inadvertently jump to an unrelated scroll position.
- Keep editorial information separate from the main reading action hierarchy without hiding it from authorized users.

**Acceptance**
- All eight sections are reachable and bookmarks resolve identically on mobile and desktop.
- `?param=` and `?fact=` links resolve to the intended information, even after refresh.
- Users can inspect references and change units without hovering or losing the original figure.
- No source references, ranges or qualifiers are removed by mobile-only content transformations.

### M05. Touch-safe interactive scientific details (P0/P1)

**Behavior**
- Audit `UnitTooltip`, `ReferenceHover`, `ReferenceRefsTooltip`, `ParameterSourcesHover`, `DrugNameCell`, metadata edit/history controls and all `group-hover` / pointer-specific cases.
- For touch, tap opens an anchored popover or bottom sheet with explicit close and accessible heading; tap targets and focus states are large enough.
- Reuse existing `ModalOverlay` / overlay stack rather than hand-rolling independent focus handling.
- Avoid double action activation when a tooltip sits inside a clickable row.
- Choose a reliable mobile action menu for compact per-parameter edit/history/discussion/source commands; permission gates remain intact.

**Acceptance**
- Every essential desktop hover-only action has a discoverable, tested mobile equivalent.
- A touch user can access references, unit conversions, history/discussion and permitted edit controls.
- Sheets remain usable over the virtual keyboard and do not steal focus from a higher-priority overlay.

### M06. Unit converter, basket and comparison (P1)

**Behavior**
- Move `FloatingUnitConverter` and `FloatingBasket` into Tools or a contextual action on compact screens; keep desktop floating controls unchanged.
- Use full-width/sheet presentation with immediate entry and clear source/target units.
- Preserve shared conversion utilities and molecular-weight requirements for mass-to-molar conversions; unsupported conversions should explain why they cannot be performed.
- Comparison: use horizontally bounded comparison or per-parameter stacked cards, with an explicit selection of substances and parameters.
- Preserve numeric scale, null/missing values, and qualitative warnings. Never truncate to a leading value with the range or source discarded.

**Acceptance**
- The bottom navigation never collides with fixed converter/basket buttons.
- Existing converter parity/unit tests remain unchanged and green.
- Three or more compared substances are still accessible on mobile; no silent data loss when adapting a wide table.

### M07. Modeling / BAC / KineLab / pattern analysis (P1)

**Behavior**
- Preserve a single shared modeling implementation, routes, algorithmic assumptions and reproducibility manifests.
- Make workflow steps mobile-friendly: **setup → inputs/events → results/graph → assumptions/details**, without imposing this order as an irreversible wizard.
- Inputs should remain editable after a run; selected drugs, cases, unit settings, parameter overrides and event timelines survive navigation and rotation.
- Arrange form fields vertically, keep labels attached, provide logical next actions and guard against keyboard-covered submit controls.
- Rendering modes and scientific warning states must match desktop: not-supported, missing-source, non-convergence, failure and uncertainty remain explicit.
- Focus first on basic viewing and existing-case adjustments; complex multi-event editing can receive an enhanced full-screen workspace after the core release.

**Acceptance**
- Identical modeling inputs produce the same numerical results and provenance on desktop and mobile.
- User can open an existing case, edit it, run it and inspect assumptions from a compact phone.
- The controls and graph remain usable with an open keyboard and after orientation changes.
- Scientific parity/invariant tests are required for any refactor that touches data flow, even if no computation change is intended.

### M08. Scientific charts and data inspection (P1)

**Behavior**
- Extend `ModelingChart` / applicable Plotly surfaces with clear tap-based point inspection, legend control, zoom/reset and an explicit full-screen graph option.
- Use touch gestures without hijacking vertical page scroll; consider opt-in pan/zoom inside the chart and a stable full-screen detail workspace.
- Keep axes, units, uncertainty intervals, reference lines, matrix identities and warnings visible or accessible. Do not reduce plotted series for aesthetics without labeling the change.
- Consider a selected-point details sheet or small tabular inspection view so precise quantities remain readable without hover.
- Respect device rotation, dynamic viewport changes, color contrast, reduced motion and performance limits. Plotly should reflow using actual container dimensions.

**Acceptance**
- Tap produces the correct series/time/concentration and relevant units/uncertainty information.
- Zoom/reset and legend controls work on mobile without breaking page scrolling.
- The graph's scientific payload remains consistent across viewport sizes; screenshot/functional tests cover multi-series and reference-band cases.

### M09. Wide data tables, references and specialist modules (P1/P2)

Prioritize `ComparisonPage`, `DetectionTimesPage`, `DrugPmConcentrations`, references and methods; then audit pattern profiles, bioentity dashboards, wiki editing, review queue, PDF workflow and admin surfaces.

**Behavior**
- Provide a primary compact projection of data when possible; otherwise contained horizontal table scrolling with an obvious cue, sticky key columns when viable and an optional focused/landscape table view.
- For scientific comparisons, retain labels, assay species/matrix, measurement basis, data qualification, and per-source citations.
- Don't transform missing or incomparable measurements into empty-looking equivalent cells.
- For editing/review, maintain safe form submission, side-by-side diff access and unsaved-change safeguards. P2 surfaces may remain desktop-preferred temporarily, but must have a clear in-app explanation and no broken/obscured controls.

**Acceptance**
- A phone user can reach every functional route without severe clipping or unusable navigation.
- The prioritized read-side tables can be inspected without whole-document horizontal overflow.
- Editors/admins are not silently sent to destructive or ambiguous controls on narrow screens.

## 7. PWA specification (after core mobile UX)

### 7.1 Installability (P1 following M01–M04)

- Add a standards-compliant web manifest, appropriate icons, standalone display, theme/background colors and an install entry point or install guidance.
- Implement Vite-compatible service worker functionality (for example, through a maintained Vite PWA integration) without weakening `index.html` Content Security Policy.
- Test direct deep linking and navigation in standalone Android display mode, including handling of auth redirects, expired sessions and external references.
- Show an app-update prompt at an appropriate time; do not silently reload and destroy a draft or unsaved model case.
- Ensure service-worker scope, app URL and staging/production environments are correctly isolated.
- A native wrapper / Trusted Web Activity is a **later decision**, not part of this spec's initial deliverable.

### 7.2 Offline and cache safety (P1/P2)

**First release:** online-required for scientific data. Cache only safe fingerprinted/static assets and optional application shell resources, with a clear offline or stale-data state.

- Never serve an authenticated API response, verification state, review queue, private draft, or user-specific record from a shared cache.
- Treat API responses and dynamically updated scientific database facts as network-first / network-only unless an explicit, separately reviewed offline contract exists.
- Avoid a cache of `data/components.ts` being presented as a current mirror of the database.
- Version client caches carefully. On deploy, ensure old HTML or a stale chunk cannot permanently strand a user; account for existing `installChunkReloadHandler` behavior.
- If future read-only offline reference access is approved: require explicit dataset version, retrieval timestamp, provenance, freshness policy, visible stale labeling and a deliberate refresh path.
- Test installed-app updates while a form is dirty, session expiry, no network, returning online and a stale service worker.

**PWA acceptance:** installable in supported Android Chrome, deep links work in standalone mode, no unauthorized/private API caching, updates are recoverable, offline conditions never silently pass stale scientific facts off as current.

## 8. Accessibility, performance, privacy and quality budgets

### 8.1 Accessibility (release gate)

- Aim for WCAG 2.2 AA for new/refactored experiences, documenting any inherited exception.
- Keyboard and screen-reader navigation, landmarks/headings, visible focus, labeled icon buttons, appropriate live-status messaging.
- Minimum comfortable touch targets, reflow at narrow widths and 200% text sizing without loss of function.
- Preserve enough contrast in data visualization and never rely on color alone to distinguish evidence status, drug series or warnings.
- Honor reduced motion and maintain correct focus/scroll locking with sheets, popovers, overlays and browser back.

### 8.2 Performance

Set **measured baseline before budgets**. Collect repeatable local/CI timings with fixed fixtures and network profiles for:
- cold startup; search first interaction; search-to-drug detail navigation; tab transition;
- large catalog list scroll; comparison render; graph interaction; mid-range Android-like CPU throttling;
- route-level downloaded JS and long main-thread tasks.

Initial release goals:
- No material regression to desktop bundle/initial route startup due to mobile-only functionality.
- Load Plotly, editor and advanced tool code lazily; do not pull their chunks into anonymous mobile home.
- No visually blocking layout shift of the header/bottom nav on initial rendering.
- Prefer immediate response to input; measured long tasks and list-scroll jank should be tracked and addressed before rollout.
- Define numerical p75 budgets **after baseline**, record them in the audit PR, and use matching fixtures/devices for before/after comparisons.

### 8.3 Privacy and safe telemetry

Do not introduce analytics that collect substance search strings, modeled doses, laboratory concentrations, case narratives, auth tokens or scientific record contents by default.

If monitoring is needed, prefer coarse, privacy-reviewed interaction milestones (such as successful navigation, errors and performance) without parameter values or identifiable patient/case metadata. Production error logs and traces must follow the existing security requirements.

### 8.4 Internationalization and copy

- All new accessible names, button labels, error/loading/offline messages and section labels have Norwegian and English localization.
- Maintain medically correct symbols (µ, units, ranges, less-than and greater-than qualifiers); no visual abbreviations that change meaning.
- Test Norwegian decimal comma entry and English decimal point entry in converters/model inputs where supported by current parsers.

## 9. Verification strategy

### 9.1 Automated test platform

Extend `playwright.config.ts` rather than replacing desktop coverage:
- Mobile Chromium emulating Pixel-class Android at ~390×844 and a narrow ~320px width.
- Mobile WebKit iPhone-class profile as a cross-browser touch compatibility guard, even though Android is the initial priority.
- Existing desktop Chromium, Firefox and WebKit remain.
- Test portrait/landscape, keyboard appearance, auth states, deep links, accessible focus and pointer/touch interactions.
- Use representative fixed/test data and mocked endpoints where necessary; no real patient or protected clinical records.
- Keep screenshot snapshots stable (fonts, clocks, data, viewport and reduced-motion settings).

### 9.2 Required scenario matrix

| ID | Scenario | Required assertion |
|---|---|---|
| T01 | Signed-out compact viewport starts at `/` | Search/drug discovery works; gated destinations not revealed |
| T02 | Search by generic/alternative name | Correct result and canonical drug route |
| T03 | Search result selected, browser Back | Query and sensible selection/scroll context restored |
| T04 | Mobile monograph section picker | All eight canonical tab routes reachable; active state matches URL |
| T05 | Direct `?param=` / `?fact=` link | Correct section and target, including after refresh |
| T06 | Tap a source/reference/unit | Accessible detail, correct conversion/original data, dismiss/focus restore |
| T07 | Basket and converter on 320px phone | No overlap with nav, keyboard or content; all actions reachable |
| T08 | Same modeling case on mobile and desktop | Same results/units/model identity/assumptions |
| T09 | Touch a multiseries chart | Correct point, value, label, reference line and reset behavior |
| T10 | Comparison/detection/postmortem wide data | No page-wide overflow; missingness, units and citations available |
| T11 | Resize mobile → desktop → mobile | URL and input state preserved; desktop persisted table mode not overwritten |
| T12 | Role changes/sign-out/hidden-nav loading | UI permissions and API access consistent, no transient privileged links |
| T13 | Modal and keyboard sequence | No trapped/hidden controls, focus returns, no inaccessible backdrop actions |
| T14 | Install PWA; navigate directly to detail | Standalone mode preserves routes and auth redirects |
| T15 | PWA offline, update and dirty form | No stale claims, no private API cache, no silent draft loss |
| T16 | Desktop regression suite | Existing table, sidebar, command palette, tabs and floating tools remain functional |

### 9.3 Static/unit/integration checks

For every scoped PR, run targeted typecheck, lint and unit/component tests for changed components, plus relevant Playwright journeys. Run scientific parity/modeling invariants for PRs affecting modeling/view-data plumbing. Run broader verification and PWA smoke tests at release readiness rather than needlessly during every small PR.

Use `AGENTS.md` bounded coding-agent workflow: one scoped implementation pass, focused checks, commit/push once, ready-for-review PR, report status; respect GitHub CI and `codex-gate`. Do not self-merge or self-deploy.

## 10. Implementation roadmap / PR work packages

This sequence is deliberately incremental. PR identifiers below are **planned work-package labels**, not existing GitHub PR numbers.

| Work package | Priority | Scope / expected files | Dependency | Exit condition |
|---|---|---|---|---|
| **PR-M00 Audit & baseline** | P0 | Mobile screenshots, route/component inventory, usability flows, Playwright mobile profiles, baseline measures and accessibility findings | None | Reproducible current-state report and initial failing/characterization tests |
| **PR-M01 Responsive shell** | P0 | `RootLayout`, `DrugTableShell`, new mobile header/bottom nav, viewport/safe-area CSS; shared route visibility | M00 | 320px shell usable; desktop rail/keyboard behavior unchanged |
| **PR-M02 Unified mobile search** | P0 | Refactor `CommandPalette` search logic into shared controller, mobile search view, loading/error states | M01 | Permission-safe and touch-safe search; desktop Ctrl/Cmd+K parity |
| **PR-M03 Mobile drug catalog** | P0 | `MobileDrugList` sharing catalog/filter identity, method gating, list/search restore | M02 | Find/select drug without desktop table; desktop full table unchanged |
| **PR-M04 Monograph navigation/readability** | P0 | `WikiPage`/`WikiLayout`, monograph section picker, metadata and parameter rendering | M01–M03 | Eight deep-linkable tabs; no lost sources, context or units |
| **PR-M05 Shared touch details** | P0/P1 | Tooltip, reference, metadata, source, edit/history actions; shared mobile sheet | M01, can overlap M04 if files owned separately | Essential hover-only functions accessible by tap |
| **PR-M06 Mobile tools** | P1 | Floating basket/converter alternate mobile presentation; comparison entry points | M01, M05 | Converter and basket reachable without overlays |
| **PR-M07 Modeling inputs/workflow** | P1 | Simulator/modeling input layout, results navigation, case persistence, keyboard awareness | M01, M05 | Existing case operable on mobile with identical output |
| **PR-M08 Graph interaction** | P1 | `ModelingChart` and other high-use scientific plots, inspect/fullscreen/reset | M07 | Readable, touch-operable multi-series graphs |
| **PR-M09 Secondary tables & routes** | P1/P2 | Comparison, detection, PM distributions, references, methods, then review/edit/admin audit | M04–M08 as applicable | Priority read routes accessible; secondary routes have explicit disposition |
| **PR-M10 Installable PWA** | P1 | Manifest, icons, service worker, update/offline messaging, CSP and integration tests | M01–M04 stable | Android standalone install works safely |
| **PR-M11 Hardening & release** | P0 gate | Combined mobile/desktop E2E, accessibility, performance, privacy/security and regression review | Prior packages | All release gates met; deliberate staged rollout |

Recommended scheduling: **M00 → M01 → M02 → M03 → M04/M05** for the first useful mobile release; M06–M09 complete high-value scientific workflows; M10 can proceed once the core shell is stable; M11 gates general release.

### 10.1 Parallel agent ownership

Parallelize **independent research and test fixture work first**. After shell decisions are locked, assign separate code ownership: navigation/search, monographs/touch details, modeling/charts and PWA/tests. Do not have multiple agents edit `RootLayout`, `Header`, `DrugTableShell`, `src/index.css` or shared routing simultaneously.

Require explicit handoff contracts:
- which shared UI primitives exist;
- exact breakpoint policy and navigation registry;
- URL and state contracts;
- file ownership;
- test fixtures and exit criteria;
- known P0/P1 findings requiring a separate bounded follow-up.

A broad task may be coordinated in ChatGPT Work, but each coding PR remains a distinct, reviewable unit consistent with repository policy.

## 11. Rollout and risk register

### 11.1 Release plan

1. **Internal evaluation:** screenshots/device emulation and direct testing on mid-range Android. Use read-only flows first, then converter and modeling.
2. **Feature-gated or cohort release:** mobile-specific presentation can have a UI rollout switch; it must not weaken server permissions. A query flag or local developer override may help testing, but should not become the default user configuration.
3. **Public mobile default:** after critical tasks and desktop regression checks, enable the shell for supported compact viewports.
4. **PWA rollout:** separately verify service-worker updates and standalone mode; do not couple installation to a risky UI change.
5. **Post-release observation:** assess task completion, visible usability complaints, crash/error rates and scientific parity issues; disable mobile shell if severe regressions occur.

### 11.2 Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Mobile shell overwrites persisted desktop `tableView` | High | Derive presentation from media queries; add resize/reload regression |
| Hidden hover action is unreachable on touch | High | Touch audit and explicit sheet/action controls |
| Abbreviated display changes scientific meaning | Critical | Shared data transforms, preserve source/qualifier/unit, parity tests |
| Permissions leak through a mobile menu or search | Critical | Central shared authorization/visibility resolution and role-matrix E2E |
| PWA caches outdated clinical/reference data | Critical | No private/API/scientific offline caching by default; visible offline state |
| Plotly gesture steals page scroll or hides bands | High | Full-screen inspect mode, real touch tests and data equivalence checks |
| Keyboard obscures converter/modeling submit button | High | Dynamic viewport/safe-area testing, sheet scroll/resize |
| Large refactor breaks desktop use | High | Small PRs, desktop characterization tests, owned shared files |
| Service-worker update strands old assets/loses draft | High | Versioned caches, update notification, unsaved-state gating |
| Agent parallel work creates conflicting primitives | Medium | Freeze shell contracts and assign non-overlapping file ownership |

## 12. Definition of done

The overall mobile UX initiative is complete when:

1. A 320–430px phone user can search/select a substance, open all eight monograph sections and inspect sources, without a forced desktop sidebar or unintended page-wide horizontal scrolling.
2. Compact navigation, browser history, direct links, authenticated/anonymous states and settings work consistently.
3. Converter, basket/comparison and the main modeling workflows are usable by touch; scientific outputs and provenance match desktop for identical inputs.
4. Important data ranges, missingness, units, evidence status, uncertainties and references remain accessible and semantically unchanged.
5. P0/P1 hover-only accessibility failures have been eliminated; accessibility checks cover keyboard, touch, screen reader, contrast and text scaling.
6. Mobile Chromium/WebKit E2E and existing desktop tests pass against the **current PR head**; release checks include scientific parity where relevant.
7. No critical permissions, API caching, client-side private-data storage or stale-science risks remain open.
8. Android PWA installation and update behavior are verified if the PWA work package is included in the release.
9. Any intentionally desktop-preferred P2 administrative/editorial surface is inventoried, accessible by some reasonable fallback, and tracked as explicit follow-up debt.
10. Deployment is performed through established repository review/release controls, not as an automatic side effect of creating this specification.

## 13. Decisions to validate in PR-M00

These do not block drafting or the first exploration, but should be recorded before locking the visual design:

- Whether the bottom bar needs four destinations (**Drugs, Search, Tools, More**) or three plus a prominent floating Search action.
- Whether a monograph **Sections** picker or a shorter scrolling tab bar performs better on actual phones.
- Whether search is a standalone route or a controlled global overlay, while retaining canonical result destinations.
- Whether compact drug rows need any summary PK values before a monograph is opened, and which ones are safe/useful.
- How aggressively comparison tables switch to cards versus explicit scrollable/full-screen tables.
- Which modeling and editorial tasks are frequent enough on a phone to justify first-release optimization.
- The user-facing offline policy: online-only scientific reference is the safe starting recommendation.

## 14. Suggested first implementation instruction

> Implement **PR-M00** only. Audit the current mobile UX using Playwright mobile profiles and record reproducible screenshots and accessibility findings for drugs/search, monographs, converter/basket, modeling/chart and comparison. Establish a concise route-by-route issue inventory and benchmark baseline. Do not modify scientific computation, API/DB schemas, the production PWA configuration or desktop information architecture. Commit the audit and mobile test harness to a review-ready PR. Apply the bounded workflow in AGENTS.md and report current-head checks and unresolved blockers.

Once M00 is reviewed, implement M01–M03 as separate PRs. Avoid instructing a coding agent to implement the entire roadmap as one massive commit.
