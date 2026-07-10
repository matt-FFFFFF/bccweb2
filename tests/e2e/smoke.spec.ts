// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { test, expect } from "@playwright/test";
import path from "path";

test("smoke: home page contains BCC branding", async ({ page }) => {
  await page.goto("/");

  // Try title first, fall back to heading
  const title = await page.title();
  const headingLocator = page.locator("h1, h2").first();

  const titleMatches = /BCC/i.test(title);
  // eslint-disable-next-line playwright/no-conditional-in-test -- smoke check intentionally accepts BCC branding in EITHER the page title or a top-level heading
  if (!titleMatches) {
    // eslint-disable-next-line playwright/no-conditional-expect -- intentional either/or branding assertion (title-or-heading), not a logic bug
    await expect(headingLocator).toContainText(/BCC/i);
  } else {
    // eslint-disable-next-line playwright/no-conditional-expect -- intentional either/or branding assertion (title-or-heading), not a logic bug
    expect(title).toMatch(/BCC/i);
  }

  // Screenshot regardless of whether the assertion passed above
  await page.screenshot({
    path: path.join(
      ".omo",
      "evidence",
      "task-5-e2e-smoke.png"
    ),
    fullPage: true,
  });
});
