// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { test, expect, type Page } from "@playwright/test";
import path from "path";

/**
 * Cold-navigation e2e for the code-split (React.lazy) public routes, run against
 * the PRODUCTION `vite preview` build (E2E_BASE_URL=http://localhost:4173).
 *
 * Each lazy route is reached two ways — a direct `page.goto` (cold load: entry
 * chunk + the route's own lazy chunk fetched on demand) and an in-app `<Link>`
 * click (client-side navigation that fetches the lazy chunk without a full
 * reload) — and must render real content with a strictly clean console.
 */

/**
 * Attach a console-error + pageerror collector (the returned array must end
 * empty) and deterministically neutralise the public-blob reads the app shell
 * performs on mount: FirstLoginOfSeasonGate reads `clubs.json`; Home reads
 * `rounds.json` / `seasons.json`. All resolve to `/blob/*`, a path `vite preview`
 * does not serve, so Chromium would log a benign 404 ("Failed to load resource
 * … 404"). The app itself swallows it (blobClient throws BlobNotFoundError,
 * useBlob catches it → notFound), but it would still dirty the console. Fulfilling
 * with `[]` — a valid empty array for every array-shaped public blob, so no
 * schema/`DATA_SHAPE_INVALID` fallout — keeps the console strictly clean and the
 * zero-error assertion exact.
 */
async function armPage(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.route("**/blob/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    })
  );
  return errors;
}

test.beforeAll(async ({ request }) => {
  const res = await request.get("/");
  const html = await res.text();
  // A production `vite build` injects a hashed entry chunk (/assets/index-<hash>.js);
  // the dev server serves /src/main.tsx + /@vite/client instead. Fail loudly if this
  // spec is pointed at the dev server (e.g. a naive `npm run e2e` at :5173) rather than
  // the intended `vite preview` prod build (E2E_BASE_URL=http://localhost:4173).
  expect(
    /\/assets\/index-[\w-]+\.js/.test(html),
    "lazy-routes.spec.ts must run against a production `vite preview` build (E2E_BASE_URL=http://localhost:4173), not the Vite dev server; served HTML has no hashed /assets/index-*.js entry chunk.",
  ).toBe(true);
});

test("cold goto /about renders the lazy About route with a clean console", async ({ page }) => {
  const errors = await armPage(page);

  await page.goto("/about");

  await expect(
    page.getByRole("heading", { name: /About the British Club Challenge/i })
  ).toBeVisible();

  await page.screenshot({
    path: path.join(".omo", "evidence", "task-5-e2e-about.png"),
    fullPage: true,
  });

  expect(errors).toEqual([]);
});

test("cold goto /login renders the lazy Login route with a clean console", async ({ page }) => {
  const errors = await armPage(page);

  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.screenshot({
    path: path.join(".omo", "evidence", "task-5-e2e-login.png"),
    fullPage: true,
  });

  expect(errors).toEqual([]);
});

test("in-app <Link> click cold-loads the /login lazy chunk with a clean console", async ({ page }) => {
  const errors = await armPage(page);

  await page.goto("/");

  // The logged-out Nav renders <Link to="/login">Sign in</Link> at the top level
  // (not nested in a dropdown), so this click is a reliable client-side navigation
  // that forces the /login lazy chunk to be fetched on demand — proving lazy-chunk
  // navigation, not merely a full-page load.
  await page.getByRole("link", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // Note: with React Router's useTransitions={true}, the old view may be held
  // briefly instead of showing the <Suspense> spinner while the chunk loads.
  // That is observed, documented behaviour and is intentionally NOT asserted.

  expect(errors).toEqual([]);
});
