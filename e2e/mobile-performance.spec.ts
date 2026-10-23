import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { MOBILE_DRUGS, mockMobileApi } from "./mobile-fixtures";

const SAMPLE_COUNT = 5;
const CATALOG_SIZE = 200;
const PROFILE = {
  cpuSlowdown: 4,
  latencyMs: 150,
  downloadBitsPerSecond: 1_600_000,
  uploadBitsPerSecond: 750_000,
  mockApiDelayMs: 150,
};

type ObserverEntry = {
  startTime: number;
  duration: number;
  value?: number;
  hadRecentInput?: boolean;
};
type BrowserAudit = {
  supported: string[];
  longTasks: ObserverEntry[];
  layoutShifts: ObserverEntry[];
};

function p75(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.75) - 1]!;
}

async function nextPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function browserEvidence(page: Page) {
  return page.evaluate(() => {
    const audit = (window as unknown as { __mobilePerformance: BrowserAudit })
      .__mobilePerformance;
    const resources = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    return {
      observedAtMs: performance.now(),
      ...audit,
      paints: performance
        .getEntriesByType("paint")
        .map((entry) => entry.toJSON()),
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => entry.toJSON()),
      scripts: resources
        .filter((entry) => /\.js$/.test(new URL(entry.name).pathname))
        .map((entry) => ({
          path: new URL(entry.name).pathname,
          startTime: entry.startTime,
          duration: entry.duration,
          transferBytes: entry.transferSize,
          decodedBytes: entry.decodedBodySize,
        })),
    };
  });
}

test("M00 opt-in production performance baseline", async ({
  browser,
  browserName,
  baseURL,
  viewport,
  userAgent,
  deviceScaleFactor,
  isMobile,
  hasTouch,
}, testInfo) => {
  test.skip(
    process.env.MOBILE_BENCHMARK !== "1",
    "Opt in with MOBILE_BENCHMARK=1; timings are not CI pass/fail budgets.",
  );
  test.skip(
    browserName !== "chromium" ||
      !["mobile-chromium", "chromium"].includes(testInfo.project.name),
    "The fixed CDP performance profile is measured only on mobile-chromium and desktop chromium.",
  );
  expect(
    process.env.PLAYWRIGHT_PREVIEW,
    "Build first, then run with PLAYWRIGHT_PREVIEW=1. Development-server timings are invalid.",
  ).toBe("1");
  test.setTimeout(600_000);

  const samples: Array<{
    sample: number;
    timings: Record<string, number>;
    snapshots: Record<string, Awaited<ReturnType<typeof browserEvidence>>>;
    scriptedScroll: { startTop: number; endTop: number; intervals: number[] };
    apiRequestCount: number;
  }> = [];
  for (let sample = 1; sample <= SAMPLE_COUNT; sample++) {
    // The browser process stays warm; storage, cookies and HTTP cache do not.
    const context = await browser.newContext({
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      serviceWorkers: "block",
      reducedMotion: "reduce",
      colorScheme: "light",
      locale: "en-US",
    });
    try {
      const page = await context.newPage();
      const api = await mockMobileApi(page, { catalogSize: CATALOG_SIZE });
      // Intercepted responses do not represent production DB/server latency.
      // Apply an explicit, repeatable delay; API payload throughput is unmodeled.
      await page.route("**/api/**", async (route) => {
        await new Promise((resolve) =>
          setTimeout(resolve, PROFILE.mockApiDelayMs),
        );
        await route.fallback();
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addInitScript((drugs) => {
        localStorage.setItem("kinetix-lang", "en");
        localStorage.setItem(
          "kinetix.basket",
          JSON.stringify({
            state: {
              items: drugs.map((drug) => ({
                drugId: drug.id,
                drugName: drug.names.en,
                pubchemCid: null,
                addedAt: 1792742400000,
              })),
              comparisonParameterIds: ["halfLife"],
              comparisonTargetIds: [],
              referenceDrugId: drugs[0]!.id,
            },
            version: 0,
          }),
        );
        const audit: BrowserAudit = {
          supported: [...PerformanceObserver.supportedEntryTypes],
          longTasks: [],
          layoutShifts: [],
        };
        (
          window as unknown as { __mobilePerformance: BrowserAudit }
        ).__mobilePerformance = audit;
        for (const type of ["longtask", "layout-shift"]) {
          if (!audit.supported.includes(type)) continue;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const value = entry as PerformanceEntry & {
                value?: number;
                hadRecentInput?: boolean;
              };
              const record = {
                startTime: value.startTime,
                duration: value.duration,
                value: value.value,
                hadRecentInput: value.hadRecentInput,
              };
              (type === "longtask" ? audit.longTasks : audit.layoutShifts).push(
                record,
              );
            }
          }).observe({ type, buffered: true });
        }
      }, MOBILE_DRUGS);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Emulation.setCPUThrottlingRate", {
        rate: PROFILE.cpuSlowdown,
      });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: PROFILE.latencyMs,
        downloadThroughput: PROFILE.downloadBitsPerSecond / 8,
        uploadThroughput: PROFILE.uploadBitsPerSecond / 8,
      });

      const timings: Record<string, number> = {};
      const snapshots: Record<
        string,
        Awaited<ReturnType<typeof browserEvidence>>
      > = {};
      let start = performance.now();
      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 90_000 });
      const table = page.getByRole("region", {
        name: "Drug Table & Unit Conversion",
      });
      await expect(table.locator("tbody tr")).toHaveCount(CATALOG_SIZE, {
        timeout: 60_000,
      });
      await expect(table.locator("tbody tr").first()).toBeVisible();
      await nextPaint(page);
      timings.catalogReadyMs = performance.now() - start;
      snapshots.catalog = await browserEvidence(page);

      start = performance.now();
      await page.getByPlaceholder(/Filter drugs/).fill("Søvnprøve A");
      await expect(table.locator("tbody tr")).toHaveCount(1);
      await expect(table.locator("tbody tr")).toContainText("Mobiltest A");
      await nextPaint(page);
      timings.filterMs = performance.now() - start;
      await page.getByPlaceholder(/Filter drugs/).fill("");
      await expect(table.locator("tbody tr")).toHaveCount(CATALOG_SIZE);

      const scroll = await table
        .locator("table")
        .evaluate(async (tableElement) => {
          let scroller = tableElement.parentElement;
          while (
            scroller &&
            !(
              scroller.scrollHeight > scroller.clientHeight &&
              /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
            )
          ) {
            scroller = scroller.parentElement;
          }
          if (!scroller)
            throw new Error(
              "Large-catalog fixture has no vertical scroll container.",
            );
          const target = scroller;
          const startTop = target.scrollTop;
          const intervals: number[] = [];
          let previous: number | null = null;
          await new Promise<void>((resolve) => {
            const frame = (now: number) => {
              if (previous !== null) intervals.push(now - previous);
              previous = now;
              target.scrollTop += 80;
              if (intervals.length < 60) requestAnimationFrame(frame);
              else resolve();
            };
            requestAnimationFrame(frame);
          });
          const endTop = target.scrollTop;
          target.scrollTop = startTop;
          return { startTop, endTop, intervals };
        });
      expect(scroll.endTop).toBeGreaterThan(scroll.startTop);
      timings.scriptedScrollRafP75Ms = p75(scroll.intervals);

      start = performance.now();
      await page.keyboard.press("Control+k");
      const search = page.getByPlaceholder(
        "Search drugs, wiki pages, references...",
      );
      await expect(search).toBeFocused();
      await nextPaint(page);
      timings.paletteOpenMs = performance.now() - start;
      start = performance.now();
      await search.fill("Søvnprøve A");
      const hit = page.getByRole("button", {
        name: /Mobiltest A.*Søvnprøve A/i,
      });
      await expect(hit).toBeVisible();
      await nextPaint(page);
      timings.searchResultsMs = performance.now() - start;

      start = performance.now();
      await hit.click();
      await expect(page).toHaveURL(/\/wiki\/mobile-a\/chemistry$/, {
        timeout: 60_000,
      });
      await expect(page.getByTestId("monograph-tab-nav")).toBeVisible();
      await expect(page.locator("main")).toContainText("Syntetisk monografi");
      await nextPaint(page);
      timings.searchToMonographMs = performance.now() - start;
      snapshots.monograph = await browserEvidence(page);

      // The baseline rail is unusable on compact screens; take the explicit
      // user recovery action outside the tab/comparison timing windows.
      await page
        .getByRole("button", { name: "Collapse drug table", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Open drug table sidebar",
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await page.locator("aside").first().boundingBox())?.width,
        )
        .toBe(28);
      const pk = page
        .getByTestId("monograph-tab-nav")
        .locator('a[href="/wiki/mobile-a/pharmacokinetics"]');
      start = performance.now();
      await pk.click();
      await expect(pk).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByTestId("parameter-value-sources-halfLife"),
      ).toContainText("2–4");
      await nextPaint(page);
      timings.tabTransitionMs = performance.now() - start;

      await page.getByRole("button", { name: "Open drug basket" }).click();
      const compare = page
        .getByRole("dialog", { name: "Drug basket", exact: true })
        .getByRole("link", { name: "Compare", exact: true });
      start = performance.now();
      await compare.click();
      await expect(page).toHaveURL(/\/comparison$/);
      await expect(page.locator("main table").first()).toContainText("2–4", {
        timeout: 60_000,
      });
      await expect(page.locator("main table").first()).toContainText(
        /Mobiltest B/i,
      );
      await nextPaint(page);
      timings.comparisonReadyMs = performance.now() - start;
      snapshots.comparison = await browserEvidence(page);

      expect(api.unhandled).toEqual([]);
      expect(api.mutations).toEqual([]);
      expect(pageErrors).toEqual([]);
      samples.push({
        sample,
        timings,
        snapshots,
        scriptedScroll: scroll,
        apiRequestCount: api.requests.length,
      });
    } finally {
      await context.close();
    }
  }

  const result = {
    kind: "kinetix-mobile-baseline-v1",
    project: testInfo.project.name,
    build: "production-preview",
    browser: browser.version(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    profile: PROFILE,
    sampleCount: SAMPLE_COUNT,
    catalogSize: CATALOG_SIZE,
    methodology: {
      contexts:
        "Fresh storage/cookies per sample; warm browser process, HTTP cache disabled, service workers blocked.",
      network:
        "CDP profile on static assets; intercepted APIs have an explicit 150ms delay. API payload bandwidth and production server/DB time are not modeled.",
      interaction:
        "Wall-clock automation actions to asserted content plus two animation frames; includes Playwright overhead. Mobile search uses inherited Ctrl+K workaround.",
      scrolling:
        "60 scripted requestAnimationFrame scroll intervals, not a touch-gesture latency metric.",
      observers:
        "Raw longtask and layout-shift entries when supported. Layout-shift values are not a computed CLS score.",
      statistics:
        "p75 nearest rank (ceil(n*0.75)); five samples establish a local baseline, not field p75.",
    },
    p75Ms: Object.fromEntries(
      Object.keys(samples[0]!.timings).map((key) => [
        key,
        p75(samples.map((sample) => sample.timings[key]!)),
      ]),
    ),
    samples,
  };
  const path = testInfo.outputPath("performance-baseline.json");
  await writeFile(path, JSON.stringify(result, null, 2) + "\n");
  await testInfo.attach("performance-baseline.json", {
    path,
    contentType: "application/json",
  });
});
