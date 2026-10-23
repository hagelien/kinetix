import { test, expect } from '@playwright/test';
import { preferEnglish } from './helpers';

/**
 * Public read-only routing contract.
 *
 * Data-publication checks remain in the APIs. These tests assert that the
 * frontend does not impose a blanket login requirement on published browsing
 * while edit/private routes still require an authenticated session.
 */
test.describe('Anonymous read-only routes', () => {
  test.beforeEach(async ({ page }) => {
    await preferEnglish(page);
    // Keep the tests independent of a development database's logged-in user.
    await page.route('**/api/auth?action=me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not authenticated' }),
      });
    });
  });

  for (const path of [
    '/wiki',
    '/comparison',
    '/entities',
    '/detection-times',
    '/modeling/how-it-works',
    '/references',
  ]) {
    test('anonymous user can open ' + path, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('main').first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(path.replaceAll('/', '\\/') + '$'));
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    });
  }

  test('anonymous navigation exposes public destinations, not restricted modules', async ({ page }) => {
    await page.goto('/');

    for (const route of ['/wiki', '/references', '/entities', '/detection-times']) {
      await expect(page.locator('header nav a[href="' + route + '"]')).toBeVisible();
    }

    for (const route of ['/methods', '/modeling/pattern', '/admin']) {
      await expect(page.locator('header nav a[href="' + route + '"]')).toHaveCount(0);
    }
  });

  for (const path of [
    '/wiki/new',
    '/wiki/example/edit',
    '/wiki/example/history',
    '/methods',
    '/learn',
    '/modeling',
  ]) {
    test('anonymous user is still redirected from ' + path, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    });
  }
});
