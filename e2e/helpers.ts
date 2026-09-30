import type { Page } from '@playwright/test';

export async function preferEnglish(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('kinetix-lang', 'en');
  });
}

export async function mockAuthenticatedUser(page: Page) {
  await page.route('**/api/auth**', async (route) => {
    const url = new URL(route.request().url());

    if (url.searchParams.get('action') !== 'me') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 1,
          email: 'e2e@example.test',
          username: 'e2e',
          role: 'admin',
          displayName: 'E2E User',
          enabledConcentrationUnits: ['umol/L', 'mg/L'],
          notificationSettings: null,
          favoriteParameters: [],
        },
      }),
    });
  });
}

export async function mockClipboard(page: Page) {
  await page.addInitScript(() => {
    let clipboardText = '';

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          clipboardText = value;
        },
        readText: async () => clipboardText,
      },
      configurable: true,
    });
  });
}
