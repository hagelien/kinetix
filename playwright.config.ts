import { defineConfig, devices } from "@playwright/test";

// Baselines must use built assets, never a reused development server.
const preview = process.env.PLAYWRIGHT_PREVIEW === "1";
const mobileTests = /mobile-.*\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  metadata: { buildMode: preview ? "production-preview" : "development" },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      testMatch: mobileTests,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "mobile-narrow",
      testMatch: mobileTests,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 320, height: 740 },
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "mobile-webkit",
      testMatch: mobileTests,
      use: {
        ...devices["iPhone 13"],
        contextOptions: { reducedMotion: "reduce" },
      },
    },
  ],
  webServer: {
    command: preview
      ? "npm run preview -- --port 3000 --strictPort"
      : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI && !preview,
  },
});
