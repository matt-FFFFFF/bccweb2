import { test, expect } from "@playwright/test";
import path from "path";

test("smoke: home page contains BCC branding", async ({ page }) => {
  await page.goto("/");

  // Try title first, fall back to heading
  const title = await page.title();
  const headingLocator = page.locator("h1, h2").first();

  const titleMatches = /BCC/i.test(title);
  if (!titleMatches) {
    await expect(headingLocator).toContainText(/BCC/i);
  } else {
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
