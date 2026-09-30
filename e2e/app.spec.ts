import { test, expect } from '@playwright/test';
import { preferEnglish } from './helpers';

test.beforeEach(async ({ page }) => {
  await preferEnglish(page);
});

test.describe('Kinetix Application', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load the application', async ({ page }) => {
    await expect(page).toHaveTitle('Kinetix');
    await expect(page.getByRole('link', { name: 'Kinetix' })).toBeVisible();
  });

  test('should render the drug table full-screen', async ({ page }) => {
    await expect(page.getByText(/Drug Table/).first()).toBeVisible();
    // The table should not be wrapped in the old widget-card div.
    await expect(page.locator('.widget-card')).toHaveCount(0);
  });

  test('should show the primary navigation', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Drug Table', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Modeling' })).not.toBeVisible();
  });
});

test.describe('Drug Table', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Give the drug data time to load.
    await page.waitForTimeout(1500);
  });

  test('should display drug list', async ({ page }) => {
    await expect(page.getByText(/drugs shown/i)).toBeVisible();
  });

  test('should filter drugs by search', async ({ page }) => {
    const tableRegion = page.getByRole('region', {
      name: 'Drug Table & Unit Conversion',
    });
    const rows = tableRegion.locator('tbody tr');
    await expect.poll(async () => rows.count()).toBeGreaterThan(50);
    const initialCount = await rows.count();

    await page.getByPlaceholder(/Filter drugs/).fill('morphin');
    await expect.poll(async () => rows.count()).toBeLessThan(initialCount);
    await expect(rows.first()).toContainText(/morph/i);
  });

  test('should hide forensic columns by default', async ({ page }) => {
    const headers = page.locator('thead th');
    const headerText = (await headers.allInnerTexts()).join(' ');
    expect(headerText).not.toMatch(/therapeutic/i);
    expect(headerText).not.toMatch(/toxic/i);
    expect(headerText).not.toMatch(/lethal/i);
    expect(headerText).not.toMatch(/metabolism/i);
    expect(headerText).not.toMatch(/PMR/);
  });

  test('should collapse to sidebar when a row is clicked in full mode', async ({ page }) => {
    // Issue #298: clicking a row in the full drug table activates that drug
    // and collapses the global table shell to its sidebar view, surfacing
    // the route content underneath.
    const row = page.locator('tbody tr').first();
    const drugName = (await row.locator('td').first().innerText()).trim();
    await row.click();

    // The full overlay closes — the column picker is full-only, so its
    // absence is a reliable signal that we're in sidebar mode.
    await expect(
      page.getByRole('button', { name: /^(columns|kolonner)$/i }),
    ).toHaveCount(0);
    // The sidebar still shows the drug catalog; the previously clicked drug
    // remains visible there.
    if (drugName) {
      await expect(page.getByText(drugName, { exact: false }).first()).toBeVisible();
    }
  });

  test('should toggle between full, sidebar, and collapsed states', async ({ page }) => {
    // Start in full mode (default). Collapse to sidebar.
    await page
      .getByRole('button', { name: /collapse drug table to sidebar|krymp legemiddeltabellen/i })
      .click();
    await expect(
      page.getByRole('button', { name: /^(columns|kolonner)$/i }),
    ).toHaveCount(0);

    // Sidebar → fully collapsed.
    await page
      .getByRole('button', { name: /^(collapse drug table|skjul legemiddeltabellen)$/i })
      .click();
    // Reveal handle → sidebar.
    await page
      .getByRole('button', { name: /open drug table sidebar|åpne legemiddeltabellen/i })
      .click();
    // Sidebar → full (expand).
    await page
      .getByRole('button', { name: /expand drug table|utvid legemiddeltabellen/i })
      .click();
    await expect(
      page.getByRole('button', { name: /^(columns|kolonner)$/i }),
    ).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  test('should have proper heading structure', async ({ page }) => {
    await page.goto('/');
    const h1 = page.locator('h1');
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText('Welcome to Kinetix');
  });
});
