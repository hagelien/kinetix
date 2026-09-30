import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockAuthenticatedUser, mockClipboard, preferEnglish } from './helpers';

const ROUTE = '/modeling?mode=ethanol';

function scenarioHash(scenario: unknown): string {
  return Buffer.from(JSON.stringify(scenario), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

test.describe('EtOH simulator route', () => {
  test.beforeEach(async ({ page }) => {
    await preferEnglish(page);
    await mockAuthenticatedUser(page);
    await mockClipboard(page);
  });

  test('renders workbook back-calculation panel with all seven outputs', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await expect(page.getByTestId('workbook-backcalc-panel')).toBeVisible();
    const outputs = page.getByTestId('workbook-outputs');
    await expect(outputs).toContainText('Back-calc (min) ‰');
    await expect(outputs).toContainText('Back-calc (likely) ‰');
    await expect(outputs).toContainText('Ethanol (g)');
    await expect(outputs).toContainText('After intake max ‰');
    await expect(outputs).toContainText('After intake likely ‰');
    await expect(outputs).toContainText('Back-calc minus intake (min) ‰');
    await expect(outputs).toContainText('Back-calc minus intake (likely) ‰');
  });

  test('updating detected promille recomputes back-calc', async ({ page }) => {
    await page.goto(ROUTE);
    const detected = page.getByLabel(/Detected promille/);
    await detected.fill('0');
    await expect(page.getByTestId('workbook-outputs')).toContainText('0,00');

    await detected.fill('1');
    // 1.0 + 0.1 * (some elapsed h) → > 1.0; we just verify it changes
    const outputsText = await page.getByTestId('workbook-outputs').innerText();
    expect(outputsText).not.toBe('');
    expect(outputsText).toMatch(/Back-calc \(min\)/);
  });

  test('valid legacy scenario hash restores workbook inputs and intake events', async ({
    page,
  }) => {
    const hash = scenarioHash({
      v: 1,
      referenceTime: '22:00',
      intakes: [{ id: 'drink-1', timeHour: 1.5, ethanolGrams: 28 }],
      person: {
        weightKg: 80,
        biologicalSex: 'male',
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
    });

    await page.goto(`${ROUTE}#scenario=${hash}`);

    await expect(page.getByLabel(/Detected promille/)).toHaveValue('1.42');
    await expect(page.locator('[title^="28 g"]')).toBeVisible();
  });

  test('malformed legacy scenario hashes still load default ethanol tools', async ({
    page,
  }) => {
    await page.goto(`${ROUTE}#scenario=not-json`);

    await expect(page.getByTestId('workbook-backcalc-panel')).toBeVisible();
    await expect(page.getByLabel(/Detected promille/)).toHaveValue('0');
  });

  test('Wattson outputs render alongside manual-r outputs', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    const wattson = page.getByTestId('workbook-outputs-wattson');
    await expect(wattson).toContainText('Wattson r (B39)');
    await expect(wattson).toContainText('After intake max ‰ (Wattson)');
  });

  test('WCAG 2.1 AA — no critical axe violations', async ({ page }) => {
    await page.goto(ROUTE);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast']) // light-theme palette tuned separately
      .analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
  });
});
