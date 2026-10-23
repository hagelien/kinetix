# Mobile UX baseline — M00

Date: 2026-10-23. Application baseline: `2c277bc` (`main`, including public
read-only routing PR #327). This PR changes the audit/test harness only. It is
the first package in the [implementation plan](../plans/2026-10-23-mobile-ux-implementation.md),
not completion of M01–M11 or approval to release a mobile redesign.

## Reproduce

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run build
npm run typecheck:e2e
PLAYWRIGHT_PREVIEW=1 npm run test:e2e:mobile -- --workers=1
PLAYWRIGHT_PREVIEW=1 npx playwright test e2e/mobile-baseline.spec.ts e2e/mobile-modeling-baseline.spec.ts --project=chromium --workers=1
# Run separately: fresh contexts, CPU/network throttling, five samples.
PLAYWRIGHT_PREVIEW=1 MOBILE_BENCHMARK=1 npx playwright test e2e/mobile-performance.spec.ts --project=mobile-chromium --workers=1 --output=performance-results
node scripts/summarize-mobile-audit.mjs test-results artifacts/mobile-audit-summary.json
```

The production-preview flag deliberately refuses to reuse a running dev server.
Tests create screenshots and raw JSON in their Playwright output directory;
the HTML reporter also attaches them. Preserve `test-results` before another
run or specify a distinct `--output`. The benchmark is opt-in and otherwise
explicitly skipped. The three original desktop projects remain configured;
new phone projects run only `mobile-*.spec.ts`.

All API requests are intercepted. Unknown endpoints fail the test; non-GET
requests are blocked and fail the read-only journey. The fixtures supply two
invented substances, aliases, source ranges, missing values, citations and
published monographs. The benchmark expands the catalog to 200 invented rows.
An identity-only ethanol lookup permits the existing scientific engine to run
the synthetic scenario; simulation output itself is **not mocked**. No real
case, laboratory record, account, token or production database is used.

## Evidence and interpretation

The [summary](2026-10-23-mobile-ux/summary.json) indexes viewport dimensions,
header/rail/content widths, visible controls, axe findings and loaded script
paths. Screenshots and the performance sample file live beside it.

Measurements are CSS pixels. A control below 44px is a design-audit signal,
not automatically a WCAG failure: WCAG target spacing/exceptions differ.
Center-hit obstruction measurements are diagnostic, not a complete interaction
test. Content may be clipped inside a scrolling pane even when document-level
horizontal overflow is zero. Axe runs without disabling contrast or target-size
rules, records incomplete/manual-review items, and does not certify conformance.

Final production run: **36/36 characterization tests passed** across desktop
Chromium 1280px, mobile Chromium 390px, narrow Chromium 320px and mobile WebKit
390px. The independent five-sample benchmark also passed. `npm run build`,
`npm run typecheck:e2e`, the summary script's ESLint check and `git diff --check`
passed. Existing full desktop suites, Firefox, physical devices and release CI
were not run. Sixty screen states were captured.

| Measurement | Desktop Chromium 1280px | Chromium 390px | Chromium 320px | WebKit 390px |
| --- | ---: | ---: | ---: | ---: |
| Home header height | 61px | 158px | 244px | 156px |
| Monograph header height | 92px | 195px | 195px | 194px |
| Default route pane width | 1000px | 110px | **40px** | 110px |
| Pane after manual rail collapse | 1252px | 362px | 292px | 362px |
| Document horizontal overflow | 0px | 0px | 0px | 0px |

The zero-overflow result does **not** mean the route is readable: at 320px only
40px remains beside the rail. Source inspection and calculation tests continue
after an explicit user collapse. Visual inspection also confirms the converter's
matrix controls and helpful tip can clip/cover each other at 320px, while the
modeling overlay toolbar clips even after collapsing the rail.

| Evidence | Screenshot |
| --- | --- |
| 320px catalog | [Catalog](2026-10-23-mobile-ux/mobile-narrow-catalog.png) |
| 320px default monograph | [Rail obstruction](2026-10-23-mobile-ux/mobile-narrow-monograph-default-rail.png) |
| 390px keyboard-opened search | [Search workaround](2026-10-23-mobile-ux/mobile-chromium-unified-search-keyboard-workaround.png) |
| 320px converter / basket | [Converter](2026-10-23-mobile-ux/mobile-narrow-converter.png) · [Basket](2026-10-23-mobile-ux/mobile-narrow-basket.png) |
| 320px source dialog | [Sources](2026-10-23-mobile-ux/mobile-narrow-parameter-sources.png) · [Detailed axe evidence](2026-10-23-mobile-ux/mobile-narrow-parameter-sources.json) |
| 390px two-curve chart | [Modeling](2026-10-23-mobile-ux/mobile-chromium-modeling-multiseries-collapsed-rail.png) |
| 320px comparison after collapse | [Comparison](2026-10-23-mobile-ux/mobile-narrow-comparison-collapsed-rail.png) |
| Norwegian at 200% text scale | [Text scaling](2026-10-23-mobile-ux/mobile-narrow-monograph-norwegian-text-200.png) |
| Desktop / WebKit reference | [Desktop](2026-10-23-mobile-ux/chromium-monograph-default-rail.png) · [WebKit](2026-10-23-mobile-ux/mobile-webkit-monograph-default-rail.png) |

Observed inherited axe findings include `color-contrast` in catalog/header,
`definition-list`/`dlitem` in monograph markup, `target-size` in parameter actions,
`scrollable-region-focusable` in comparison, and `nested-interactive` plus
`select-name` in modeling. These are unresolved accessibility work for M01–M09;
no rules were disabled to obtain passing test results. See the summary for
per-screen impacts/counts rather than adding duplicate node counts across pages.

Container setup note: Chromium used Playwright's headless shell. WebKit's native
libraries were extracted into a local runtime directory because system package
installation was unavailable; dependency-preflight detection was disabled after
a successful WebKit launch. Both actual browsers executed the tests. Normal CI
should install its supported dependencies with the command above; no repository
setting disables validation.

## Route and component inventory

Priority here is implementation priority for inherited behavior, not a finding
introduced by this test-only PR. P0/P1 release blockers remain blocking for the
mobile release; passing characterization tests does not waive them.

| Surface | Current behavior / reproduction | Required disposition |
| --- | --- | --- |
| Home/catalog | Open `/` at 320/390px. Dense full-table projection remains; columns scroll inside the table. No compact list. | M03: one-column discovery using the same catalog/filter identities. |
| Route shell | Open `/wiki/mobile-a/chemistry` from a fresh context. The rail reserves 280px at all widths. | **M01/P1:** compact shell must remove the persistent desktop rail while preserving the mounted route and stored desktop preferences. |
| Header/search | Below 640px `Header` hides the palette launcher. Keyboard Ctrl+K works as a test workaround. | **M02/P1:** visible touch launcher and accessible full-height search surface. |
| Unified search | Alias matching and canonical navigation work. Query resets when reopening; loading/errors can look like no results. Palette lacks semantic modal/focus trapping and a touch dismiss button. | **M02/M05/P1:** shared controller with explicit loading/error state, dismissal/focus restoration and retained context. |
| Monographs | Eight canonical tabs, bare parameter/fact links and refresh work. Default pane is cramped; collapse rail manually for reading/source inspection. | M04: URL-driven section picker. Preserve ranges, units, facts and citations; shared source dialog remains reachable. |
| Converter/basket | Floating panels stay bottom-right. Decimal comma computes using the existing converter. Converter has no vertical viewport bound and controls can be clipped; basket and converter can overlap. | **M06/P1:** shared mobile tools surface with bounded scrolling and keyboard-safe layout. |
| Modeling/chart | `/modeling` remains session-gated. Admin fixture restores an ethanol scenario; collapse rail to operate it. Two distinct curves/reference lines survive viewport changes unchanged. | M07/M08: mobile input workflow and explicit inspect/reset/fullscreen controls. Preserve current lazy Plotly import. |
| Comparison | Synthetic half-life ranges and unavailable toxic concentration remain distinct through nine widths. Tables scroll, but plots have unconditional minimum-width grids. | M09: measure containment after shell fix; preserve labels, units, missingness and source context. |
| Detection windows | Public route opens; shell limits the usable pane. Restricted laboratory guidance stays gated. | M09: mobile projection/contained tables, publication controls unchanged. |
| References | Public list opens with synthetic reference metadata; shell limits the usable pane. | M09/M05: readable list/detail and actual touch/focus inspection. |
| Methods / pattern / learning | Capability/group/publication gates remain. No blanket opening of GET routes. | Desktop-preferred P2 initially; audit eligible reader journeys in M09, retain authorization. |
| Entities | Public route already exists; rich target plots not runtime-audited here. | M09 follow-up: ligand grids, labels and diagrams. |
| Editors / review / admin / PDF workflows | No new presentation or permission changes. Editing on a narrow screen is not certified by M00. | M09 P2 inventory: safe form/diff access, draft preservation, accessible desktop-preferred fallback. |
| PWA | No manifest, worker or installation behavior added. | M10 after core UX stability; online-only science, no API/private-response caching. |

Source anchors: `src/components/drug-table/DrugTableShell.tsx`,
`src/components/Header.tsx`, `src/components/CommandPalette.tsx`,
`src/components/FloatingUnitConverter.tsx`, `src/components/FloatingBasket.tsx`,
`src/components/modeling/ModelingChart.tsx`, `src/pages/ComparisonPage.tsx`.
Existing touch-visible `.hover-actions` in `src/index.css` and source-value
dialog buttons are useful foundations; not all hover-associated content is
unreachable on touch.

## Contracts protected by the harness

- Anonymous catalog filtering and unified lookup by the diacritic-bearing alias
  `Søvnprøve A`, canonical monograph navigation, Back and runtime catalog query.
- All eight canonical monograph tabs. A **bare** `?param`/`?fact` link selects
  its tab; an explicit valid tab remains authoritative. Refresh preserves URLs.
- Source-value dialog opening through touch activation on phone profiles.
- Local converter `1,5 µmol/L → 0.3 mg/L` for the invented 200 g/mol fixture.
- Basket addition and comparison; restricted method links absent anonymously.
- Table contents and persisted collapsed state through 320, 360, 375, 390, 412,
  430, 768, 1024 and 1440px. Explicit rail collapse is a workaround, not a pass
  of the proposed compact shell.
- Real ethanol workbook output, two distinct Widmark traces, annotations and
  reference lines unchanged through portrait/landscape/desktop resizing.
- Norwegian copy with the app's text-scale variable set to 2. This is text
  scaling, not browser pinch zoom or a claim of successful 200% reflow.

Two annotated tests deliberately characterize the inherited hidden search and
280px rail. M01/M02 must replace those assertions with the desired behavior.
They use no expected-failure wrapper, so unexpected API calls, mutations or
application errors cannot be mistaken for an accepted failure.

## Performance methodology and provisional budgets

Five fresh storage/cookie contexts; HTTP cache disabled; one warm Chromium
process; production Vite assets served on localhost. Fixed 4× CPU slowdown,
150ms network latency, 1.6Mbit/s download and 750kbit/s upload. Mock API replies
have an explicit 150ms delay; their payload bandwidth and real server/database
latency are **not modeled**. Synthetic catalog size is 200. English locale,
light theme and reduced motion are fixed. Measurements include Playwright
action/assertion overhead, and are not real-user p75 estimates or Core Web Vitals.

Catalog startup, filter, keyboard palette opening, search results, selection to
monograph, tab transition and comparison are recorded separately. Supported
long-task/layout-shift observers and loaded JS resources are included. Scripted
scroll frame intervals characterize this harness only, not physical finger
scrolling or an Android device's actual frame rate. Nearest-rank p75 uses the
fourth ordered observation of five; inspect all raw samples before drawing a
performance conclusion.

The [five raw samples](2026-10-23-mobile-ux/performance-baseline.json) were
collected on Chromium 145.0.7632.6, Linux x64, Node 24.19.0, 390×844 CSS px.
Initial provisional review thresholds are `ceil(p75 × 1.2 + 100ms)`; the margin
allows noise in this small local sample. These deliberately identify regressions,
not acceptable final phone latency. Recalibrate on a stable runner and physical
Android before treating them as release gates.

| Interaction | Measured local p75 | Provisional review threshold |
| --- | ---: | ---: |
| Cold-context catalog ready | 4,332 ms | 5,299 ms |
| Catalog filter | 169 ms | 304 ms |
| Keyboard palette opening | 231 ms | 378 ms |
| Search result ready | 650 ms | 880 ms |
| Select result → monograph | 4,100 ms | 5,020 ms |
| Monograph tab transition | 249 ms | 399 ms |
| Comparison ready | 996 ms | 1,295 ms |

Scripted scroll intervals have a local p75 of 16.7ms; this is not a measured
touch latency. First-sample JS totals were 1,370,792 decoded / 383,568 transferred
bytes at home; 2,047,919 / 600,523 cumulative at monograph; 2,070,954 / 606,731
at comparison. These are resource-timing values for this preview server, not
the sum of all emitted build chunks. M01 must keep initial JS within a provisional
5% of the same fixture/locale baseline and must not load Plotly/editor chunks on
anonymous home. Benchmark desktop performance separately before claiming no
desktop performance regression. Startup and first monograph load are candidates
for profiling; this run does not identify network, parsing or render causality.

## Decisions for M01–M04

1. Keep the proposed four destinations: Drugs, Search, Tools, More. Resolve
   navigation visibility once for desktop and mobile, including the existing
   hidden-nav loading guard and real-admin/delegated-manager exceptions.
2. Use a URL-driven **Sections** picker on compact screens; retain desktop
   tabs. Keep explicit-tab precedence and bare parameter/fact deep links.
3. Keep search as a controlled overlay; preserve canonical result URLs. Avoid
   adding a second history stack or storing search terms in analytics.
4. Start compact drug rows with names/aliases and an explicit opening action.
   Do not introduce abbreviated PK summaries without a separate meaning review.
5. Repair the shell before deciding which comparisons need cards. Retain
   contained horizontal tables where a card would lose comparison context.
6. Prioritize monograph lookup, sources and converter; then existing modeling
   inputs and precise chart inspection. Keep scientific transformations shared.
7. PWA first release remains online-required for scientific facts. Static
   fallback catalog data is not a current database mirror.

These are engineering defaults for implementation, not validated preferences
from a physical-phone usability study.

## Remaining verification and release blockers

M00 does not test real Android/iOS keyboards, hardware Back, physical rotation,
screen readers or installed-app behavior. Emulator viewport changes approximate
space, not virtual keyboard occlusion. PK/KineLab and Monte Carlo uncertainty
bands need their own parity fixtures; ethanol coverage is not a whole-engine
certification. Role changes, sign-out, hidden-nav loading, all source/tooltips,
touch chart inspection, focus restoration and protected editing remain M01–M11
work. Local API mocks exercise frontend contracts, not server authorization.

M00 can be reviewed independently. Follow the plan's sequence with M01 responsive
shell, M02 unified search and M03 mobile catalog as separate reviewable PRs.
No application deployment or merge is performed by this work package.
