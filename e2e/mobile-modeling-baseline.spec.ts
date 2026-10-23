import { expect, test, type Page } from "@playwright/test";
import { captureAudit } from "./mobile-audit";
import { mockMobileApi } from "./mobile-fixtures";
import { preferEnglish } from "./helpers";

// Synthetic inputs, never a saved clinical case. Exercise the public legacy
// deep-link codec and the actual Widmark/workbook engines, without injecting
// simulator state or replacing calculation results with fixtures.
const SCENARIO = {
  v: 1,
  referenceTime: "22:00",
  intakes: [
    { id: "mobile-drink-1", timeHour: 0, ethanolGrams: 28 },
    { id: "mobile-drink-2", timeHour: 1.5, ethanolGrams: 14 },
  ],
  person: {
    weightKg: 80,
    biologicalSex: "male",
    eliminationRateGdlPerHour: 0.016,
  },
  workbook: {
    drinkStopTime: 22 / 24,
    eventTime: 21 / 24,
    sampleTime: 23 / 24,
    detectedPromille: 1.42,
    secondSampleTime: null,
    secondSamplePromille: 0,
    eliminationMin: 0.1,
    eliminationLikely: 0.15,
    absorptionMinHours: 3,
    absorptionLikelyHours: 1,
    drinksMl: [330, 0, 0, 0, 0, 0],
    drinksAbvPercent: [4.5, 0, 0, 0, 0, 0],
    firstPassMinPercent: 10,
    firstPassLikelyPercent: 20,
    weightKg: 80,
    widmarkR: 0.7,
    sexMale01: 1,
    heightCm: 180,
    ageYears: 35,
  },
};

/** Capture scientific data, omitting viewport-dependent dimensions and UUIDs. */
async function scientificPlot(page: Page) {
  return page
    .locator(".js-plotly-plot")
    .first()
    .evaluate((element) => {
      type Trace = {
        name?: string;
        x?: number[];
        y?: number[];
        mode?: string;
        fill?: string;
        hovertemplate?: string;
        yaxis?: string;
      };
      const plot = element as HTMLElement & {
        data: Trace[];
        layout: {
          shapes?: unknown[];
          annotations?: unknown[];
          xaxis?: { title?: unknown };
          yaxis?: { title?: unknown };
        };
      };
      return {
        traces: plot.data.map(
          ({ name, x, y, mode, fill, hovertemplate, yaxis }) => ({
            name,
            x,
            y,
            mode,
            fill,
            hovertemplate,
            yaxis,
          }),
        ),
        shapes: plot.layout.shapes,
        annotations: plot.layout.annotations,
        xTitle: plot.layout.xaxis?.title,
        yTitle: plot.layout.yaxis?.title,
      };
    });
}

test("M00 modeling: scenario inputs and multiseries scientific payload survive viewport changes", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = await mockMobileApi(page, { role: "admin" });
  await preferEnglish(page);
  const hash = Buffer.from(JSON.stringify(SCENARIO)).toString("base64url");
  await page.goto(`/modeling?mode=ethanol#scenario=${hash}`);
  await expect(page.getByTestId("workbook-backcalc-panel")).toBeAttached();
  await expect(page.getByLabel(/Detected promille/).first()).toHaveValue(
    "1.42",
  );
  await expect(page).toHaveURL(new RegExp(`/modeling#scenario=${hash}$`));
  const canonicalUrl = page.url();
  const initialViewport = page.viewportSize()!;

  // Preserve the default 280px rail in the first screenshot. Explicitly
  // collapse it afterwards, using the same recovery action a phone user has.
  // This workaround is reported as baseline debt, not a mobile acceptance pass.
  await captureAudit(page, testInfo, "modeling-default-rail");
  await page
    .getByRole("button", { name: "Collapse drug table", exact: true })
    .click();
  const detected = page.getByLabel(/Detected promille/).first();
  const outputs = page.getByTestId("workbook-outputs").first();
  const originalOutputs = (await outputs.textContent())!;
  await detected.fill("1.8");
  await expect(outputs).not.toHaveText(originalOutputs);
  const editedOutputs = (await outputs.textContent())!;
  const wattsonOutputs = (await page
    .getByTestId("workbook-outputs-wattson")
    .first()
    .textContent())!;

  // Duplicate through the real UI: two actual curves plus legal reference
  // lines, rather than a screenshot of an empty Plotly container.
  await page
    .getByTitle("Duplicate for scenario comparison", { exact: true })
    .click();
  await expect(page.getByLabel("Engine", { exact: true })).toHaveCount(2);
  // These inherited Field controls currently have visible, unassociated
  // labels. The placeholder is the available selector until M07 fixes them.
  await page.getByPlaceholder("70", { exact: true }).nth(1).fill("65");
  await page
    .getByRole("button", { name: "Run Simulation", exact: true })
    .click();
  await expect(
    page.locator(".js-plotly-plot .scatterlayer .trace").first(),
  ).toBeAttached();
  await expect
    .poll(
      async () =>
        (await scientificPlot(page)).traces.filter(
          (trace) => trace.mode === "lines" && !trace.fill,
        ).length,
    )
    .toBe(2);
  const before = await scientificPlot(page);
  expect(
    before.traces.filter((trace) => trace.mode === "lines" && !trace.fill),
  ).toHaveLength(2);
  const curves = before.traces.filter(
    (trace) => trace.mode === "lines" && !trace.fill,
  );
  expect(curves[0]?.y).not.toEqual(curves[1]?.y);
  expect(before.traces[0]?.y?.some((value) => value > 0)).toBe(true);
  expect(before.shapes?.length).toBeGreaterThan(0);
  expect(before.annotations?.length).toBeGreaterThan(0);

  await page.getByRole("figure").first().scrollIntoViewIfNeeded();
  await captureAudit(page, testInfo, "modeling-multiseries-collapsed-rail");

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
    initialViewport,
  ]) {
    await page.setViewportSize(viewport);
    await expect(detected).toHaveValue("1.8");
    await expect(
      page.getByPlaceholder("70", { exact: true }).nth(1),
    ).toHaveValue("65");
    await expect(outputs).toHaveText(editedOutputs);
    await expect(
      page.getByTestId("workbook-outputs-wattson").first(),
    ).toHaveText(wattsonOutputs);
    await expect(page).toHaveURL(canonicalUrl);
    await expect.poll(() => scientificPlot(page)).toEqual(before);
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("kinetix.drugTable")!).state
            .tableView,
      ),
    ).toBe("collapsed");
  }

  await testInfo.attach("modeling-scientific-payload", {
    body: JSON.stringify(before, null, 2),
    contentType: "application/json",
  });
  expect(
    api.unhandled,
    "Every API response must come from a declared fixture",
  ).toEqual([]);
  expect(
    api.mutations,
    "Local modeling must not save the synthetic case",
  ).toEqual([]);
});
