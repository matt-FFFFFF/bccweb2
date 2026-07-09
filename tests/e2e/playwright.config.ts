// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      testIgnore: /admin-sign-to-fly-wording\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "realstack-serial",
      fullyParallel: false,
      testMatch: /admin-sign-to-fly-wording\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
