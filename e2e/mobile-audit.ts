import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export async function activate(page: Page, locator: Locator) {
  if (await page.evaluate(() => navigator.maxTouchPoints > 0))
    await locator.tap();
  else await locator.click();
}

/** Evidence, not a release gate: inherited violations are recorded without
 * disabling rules or making an audit pass imply WCAG conformance. */
export async function captureAudit(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  await page.evaluate(() => document.fonts.ready);
  // Let sidebar width transitions finish before measuring. A screenshot alone
  // disables animations too late: its preceding metrics could capture mid-frame.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const metrics = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return {
        x,
        y,
        width,
        height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    };
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [role="button"]',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          !el.closest("[inert]") &&
          r.right > 0 &&
          r.left < innerWidth &&
          r.bottom > 0 &&
          r.top < innerHeight
        );
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const center = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          tag: el.tagName.toLowerCase(),
          name: (
            el.getAttribute("aria-label") ||
            el.textContent ||
            el.getAttribute("placeholder") ||
            ""
          )
            .trim()
            .slice(0, 100),
          ...rect(el),
          below44: r.width < 44 || r.height < 44,
          centerObscured: !center || !(el === center || el.contains(center)),
        };
      });
    const scripts = performance
      .getEntriesByType("resource")
      .filter((entry) =>
        /\.(?:js|tsx?)(?:\?|$)/.test(new URL(entry.name).pathname),
      )
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return {
          path: new URL(resource.name).pathname,
          transferBytes: resource.transferSize,
          decodedBytes: resource.decodedBodySize,
        };
      });
    const rail = document.querySelector("aside");
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
      visualViewport: window.visualViewport && {
        width: visualViewport!.width,
        height: visualViewport!.height,
        scale: visualViewport!.scale,
      },
      pageWidth: document.documentElement.scrollWidth,
      header: rect(document.querySelector("header")),
      rail: rect(rail),
      routePane: rect(rail?.nextElementSibling ?? null),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(rect),
      tables: [...document.querySelectorAll("table")].map(rect),
      targets,
      timing: {
        navigation: performance
          .getEntriesByType("navigation")
          .map((e) => e.toJSON()),
        paints: performance.getEntriesByType("paint").map((e) => e.toJSON()),
      },
      scripts,
    };
  });
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach(`${name}.png`, {
    path: screenshot,
    contentType: "image/png",
  });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const result = {
    surface: name,
    route: new URL(page.url()).pathname + new URL(page.url()).search,
    project: testInfo.project.name,
    buildMode:
      process.env.PLAYWRIGHT_PREVIEW === "1"
        ? "production-preview"
        : "development",
    browser: page.context().browser()?.version(),
    metrics,
    accessibility: {
      engine: axe.testEngine,
      violations: axe.violations.map(
        ({ id, impact, help, helpUrl, nodes }) => ({
          id,
          impact,
          help,
          helpUrl,
          nodes: nodes.map(({ target, failureSummary }) => ({
            target,
            failureSummary,
          })),
        }),
      ),
      incomplete: axe.incomplete.map(({ id, nodes }) => ({
        id,
        nodeCount: nodes.length,
      })),
    },
  };
  const jsonPath = testInfo.outputPath(`${name}.json`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + "\n");
  await testInfo.attach(`${name}.json`, {
    path: jsonPath,
    contentType: "application/json",
  });
  return result;
}
