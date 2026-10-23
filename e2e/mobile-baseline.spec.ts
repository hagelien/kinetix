import { expect, test as base } from "@playwright/test";
import { activate, captureAudit } from "./mobile-audit";
import { mockMobileApi, MOBILE_DRUGS } from "./mobile-fixtures";
import { preferEnglish } from "./helpers";

const TABS = [
  "chemistry",
  "pharmacodynamics",
  "pharmacokinetics",
  "metabolism",
  "dose_exposure",
  "interpretive_concentrations",
  "analytics_detection",
  "postmortem",
];

const test = base.extend<{ api: Awaited<ReturnType<typeof mockMobileApi>> }>({
  api: [
    async ({ page }, use) => {
      await preferEnglish(page);
      const api = await mockMobileApi(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use(api);
      expect(
        api.unhandled,
        "Declare every API fixture; never fall back to production",
      ).toEqual([]);
      expect(api.mutations, "These are read-only journeys").toEqual([]);
      expect(errors, "No uncaught application errors").toEqual([]);
    },
    { auto: true },
  ],
});

test("M00 discovery and keyboard search keep anonymous routes public", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const table = page.getByRole("region", {
    name: "Drug Table & Unit Conversion",
  });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  for (const path of ["/methods", "/modeling/pattern", "/admin"]) {
    await expect(page.locator(`header a[href="${path}"]`)).toHaveCount(0);
  }
  await captureAudit(page, testInfo, "catalog");
  await page.getByPlaceholder(/Filter drugs/).fill("Søvnprøve A");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Mobiltest A");

  // Current touch launcher is hidden below 640px. Keep the desktop shortcut
  // contract exercised; this is deliberately NOT a successful touch-search claim.
  await page.keyboard.press("Control+k");
  const search = page.getByPlaceholder(
    "Search drugs, wiki pages, references...",
  );
  await expect(search).toBeFocused();
  await search.fill("Søvnprøve A");
  const hit = page.getByRole("button", { name: /Mobiltest A.*Søvnprøve A/i });
  await expect(hit).toBeVisible();
  await captureAudit(page, testInfo, "unified-search-keyboard-workaround");
  await activate(page, hit);
  await expect(page).toHaveURL(/\/wiki\/mobile-a\/chemistry$/);
  await expect(page.getByTestId("monograph-tab-nav")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByPlaceholder(/Filter drugs/)).toHaveValue(
    "Søvnprøve A",
  );
});

test("M00 monograph deep links and all eight canonical sections", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/wiki/mobile-a/chemistry");
  const tabs = page.getByTestId("monograph-tab-nav");
  await expect(tabs.getByRole("link")).toHaveCount(8);
  await captureAudit(page, testInfo, "monograph-default-rail");
  // Explicit user recovery, recorded separately from default-route usability.
  await page
    .getByRole("button", { name: "Collapse drug table", exact: true })
    .click();
  for (const tab of TABS) {
    const link = tabs.locator(`a[href="/wiki/mobile-a/${tab}"]`);
    await activate(page, link);
    await expect(page).toHaveURL(new RegExp(`/wiki/mobile-a/${tab}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  await page.goto("/wiki/mobile-a?param=halfLife");
  await expect(page).toHaveURL(
    /\/wiki\/mobile-a\/pharmacokinetics\?param=halfLife$/,
  );
  await page.reload();
  await expect(page).toHaveURL(/pharmacokinetics\?param=halfLife$/);
  await expect(
    page.getByTestId("parameter-value-sources-halfLife"),
  ).toBeAttached();
  await captureAudit(page, testInfo, "monograph-parameter-deeplink");
  await activate(page, page.getByTestId("parameter-value-sources-halfLife"));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("2");
  await captureAudit(page, testInfo, "parameter-sources");
  await page.goto("/wiki/mobile-a?fact=mobile-pk");
  await expect(page).toHaveURL(/\/pharmacokinetics\?fact=mobile-pk$/);
  await expect(
    page.locator('.monograph-fact[data-fact-id="mobile-pk"]'),
  ).toBeVisible();
});

test("M00 converter decimal comma and basket on a short viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/wiki/mobile-a/chemistry");
  await expect(page.getByTestId("monograph-tab-nav")).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse drug table", exact: true })
    .click();
  await activate(
    page,
    page.getByRole("button", { name: "Open unit converter" }),
  );
  const converter = page.getByRole("dialog", {
    name: "Unit converter",
    exact: true,
  });
  const from = converter.getByLabel("From concentration");
  const to = converter.getByLabel("To concentration");
  await from.fill("1,5");
  await expect(to).toHaveValue("0.3");
  await captureAudit(page, testInfo, "converter");
  // A reduced viewport approximates available space only, not an OS keyboard.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: 390 });
  await expect(from).toHaveValue("1,5");
  await expect(to).toHaveValue("0.3");
  await captureAudit(page, testInfo, "converter-short-viewport");
  await page.setViewportSize(viewport);
  await page.getByRole("button", { name: "Close unit converter" }).click();
  await activate(page, page.getByRole("button", { name: "Open drug basket" }));
  const basket = page.getByRole("dialog", { name: "Drug basket", exact: true });
  await basket.getByPlaceholder("Search drugs to add…").fill("Mobiltest A");
  await activate(page, basket.getByRole("button", { name: /Mobiltest A/i }));
  await expect(
    basket.getByRole("button", { name: /Remove Mobiltest A/i }),
  ).toBeVisible();
  await expect(
    basket.getByRole("link", { name: "Methods", exact: true }),
  ).toHaveCount(0);
  await captureAudit(page, testInfo, "basket");
  await basket.getByRole("link", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/\/comparison$/);
});

// These characterize existing defects; replace with the desired assertions in
// M01/M02. Do not use test.fail: it would also swallow fixture-safety failures.
test("M00 known gap: unified search launcher is hidden on phones", async ({
  page,
  isMobile,
}) => {
  test.info().annotations.push({
    type: "known-mobile-gap",
    description: "M02: visible touch search launcher required",
  });
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Drug Table & Unit Conversion" }),
  ).toBeVisible();
  const launcher = page
    .locator("header")
    .getByRole("button", { name: /^Search/ });
  if (isMobile) await expect(launcher).toBeHidden();
  else await expect(launcher).toBeVisible();
});

test("M00 known gap: desktop rail crowds the mobile monograph", async ({
  page,
  isMobile,
}) => {
  test.info().annotations.push({
    type: "known-mobile-gap",
    description: "M01: compact shell must not reserve desktop rail",
  });
  await page.goto("/wiki/mobile-a/chemistry");
  await expect(page.getByTestId("monograph-tab-nav")).toBeVisible();
  const width = await page
    .locator("aside + div")
    .evaluate((el) => el.clientWidth);
  if (isMobile) expect(width).toBeLessThan(page.viewportSize()!.width - 48);
  else expect(width).toBeGreaterThanOrEqual(700);
});

test("M00 Norwegian monograph at 200 percent text scale", async ({
  page,
}, testInfo) => {
  await page.goto("/wiki/mobile-a/pharmacokinetics");
  await expect(page.getByTestId("monograph-tab-nav")).toBeVisible();
  await activate(page, page.getByRole("button", { name: "NO", exact: true }));
  await expect(
    page.getByRole("button", { name: "EN", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--text-scale", "2"),
  );
  await expect(
    page.getByTestId("parameter-value-sources-halfLife"),
  ).toContainText("2–4");
  await captureAudit(page, testInfo, "monograph-norwegian-text-200");
});

test("M00 comparison retains units and ranges through resize", async ({
  page,
}, testInfo) => {
  await page.addInitScript((drugs) => {
    localStorage.setItem(
      "kinetix.basket",
      JSON.stringify({
        state: {
          items: drugs.map((d) => ({
            drugId: d.id,
            drugName: d.names.en,
            pubchemCid: null,
            addedAt: 1792742400000,
          })),
          comparisonParameterIds: ["halfLife", "toxicConcentration"],
          comparisonTargetIds: [],
          referenceDrugId: drugs[0]!.id,
        },
        version: 0,
      }),
    );
  }, MOBILE_DRUGS);
  await page.goto("/comparison");
  await expect(
    page.getByRole("heading", { name: "Comparison", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(/Mobiltest A/i);
  await expect(page.locator("main")).toContainText(/Mobiltest B/i);
  await captureAudit(page, testInfo, "comparison-default-rail");
  await page
    .getByRole("button", { name: "Collapse drug table", exact: true })
    .click();
  const values = await page.locator("main table").allTextContents();
  expect(values.join(" ")).toContain("2–4");
  await captureAudit(page, testInfo, "comparison-collapsed-rail");
  for (const width of [320, 360, 375, 390, 412, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page).toHaveURL(/\/comparison$/);
    expect(await page.locator("main table").allTextContents()).toEqual(values);
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("kinetix.drugTable")!).state
            .tableView,
      ),
    ).toBe("collapsed");
  }
});

test("M00 public detection and reference surfaces use only fixture data", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  for (const [path, name] of [
    ["/detection-times", "detection-times"],
    ["/references", "references"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await captureAudit(page, testInfo, `${name}-default-rail`);
  }
});
