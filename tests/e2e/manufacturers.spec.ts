// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resetAzuriteAndSeedAdmin } from "./_setup/reset-azurite.js";

/**
 * Real-stack E2E: wing-manufacturer reference-data loop.
 *
 * Hits the LIVE stack only (Vite :5173 + API :7071 + Azurite :10000) — NO
 * request interception, NO test-only backend hooks, NO hand-minted JWT.
 *
 * Proves the WHOLE reference-data round-trip from an empty public container:
 *   1. admin logs in through the real /login UI (real JWT in localStorage),
 *   2. a pilot is seeded via the admin API (real bearer token),
 *   3. the admin creates "Gin Gliders" (with a websiteUrl) on /admin/manufacturers
 *      — this WRITES manufacturers.json into the public `data` container (it did
 *      NOT pre-exist),
 *   4. on the pilot's profile the "Wing manufacturer" <select> (fed by useBlob
 *      reading that very blob via the Vite /blob proxy) offers "Gin Gliders",
 *   5. selecting it + "Save changes" persists to the private pilot blob,
 *   6. after a full page reload the profile re-fetches and displays
 *      "Gin Gliders" as a link to https://gingliders.com — closing the loop.
 */

const EVIDENCE_DIR = path.join(".omo", "evidence", "e2e-manufacturers");
const FINAL_SHOT = path.join(EVIDENCE_DIR, "task-10-manufacturers-e2e.png");

const MANUFACTURER = "Gin Gliders";
const WEBSITE_URL = "https://gingliders.com";

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

let admin: { email: string; password: string };

test.beforeAll(async () => {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  // Clean Azurite + admin-only seed. `data` is left EMPTY: manufacturers.json
  // does NOT pre-exist — this spec creates it via the admin flow.
  admin = await resetAzuriteAndSeedAdmin();
});

test.describe.serial("wing manufacturer reference data", () => {
  test("admin creates Gin Gliders → pilot selects it → reload shows the manufacturer link", async ({ page }) => {
    test.setTimeout(120_000);

    // ─── 1. Log in via the real UI (no hand-minted JWT). ───────────────────────
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel(/email address/i).fill(admin.email);
    await page.getByLabel(/^password$/i).fill(admin.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Nav renders the signed-in admin's email — proves the real login round-trip.
    await expect(page.getByText(admin.email)).toBeVisible({ timeout: 15_000 });

    // ─── 2. Seed a pilot via the admin API using the live bearer token. ────────
    const token = await page.evaluate(() => localStorage.getItem("bcc_access_token"));
    expect(token, "admin access token present in localStorage after login").toBeTruthy();

    const createRes = await page.request.post("http://localhost:7071/api/pilots", {
      headers: { Authorization: `Bearer ${token}` },
      data: { firstName: "Test", lastName: "Flyer" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const pilot = (await createRes.json()) as { id: string };
    expect(pilot.id).toBeTruthy();

    // ─── 3. Create "Gin Gliders" on /admin/manufacturers (writes the blob). ────
    await page.goto("/admin/manufacturers");
    await expect(page.getByRole("heading", { name: /^manufacturers$/i })).toBeVisible({ timeout: 15_000 });
    // Empty public container → the page shows the empty state, not a stale list.
    await expect(page.getByText(/no manufacturers yet/i)).toBeVisible();
    await shot(page, "01-manufacturers-empty");

    await page.getByPlaceholder("Name").fill(MANUFACTURER);
    await page.getByPlaceholder(/website url \(optional\)/i).fill(WEBSITE_URL);
    await page.getByRole("button", { name: /^create$/i }).click();

    // Success banner + the new row rendered from the re-fetched manufacturers.json.
    await expect(page.getByText(/manufacturer created\./i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(MANUFACTURER, { exact: true })).toBeVisible();
    await shot(page, "02-manufacturer-created");

    // ─── 4+5. On the pilot profile, pick "Gin Gliders" and save. ───────────────
    await page.goto(`/pilots/${pilot.id}`);
    // Admin can edit any pilot → the shared EditProfileForm renders.
    await expect(page.getByRole("heading", { name: /edit profile/i })).toBeVisible({ timeout: 15_000 });

    const wingSelect = page.getByLabel("Wing manufacturer", { exact: true });
    await expect(wingSelect).toBeVisible();
    // selectOption auto-waits for the option (fed by useBlob → manufacturers.json).
    await wingSelect.selectOption({ label: MANUFACTURER });
    await shot(page, "03-manufacturer-selected");

    await page.getByRole("button", { name: /save changes/i }).click();
    // Save success triggers a parent re-fetch that remounts the form (dropping the
    // transient "Saved." banner), so the STABLE success signal — and the barrier we
    // must wait on before reloading — is the "Wing" row rendering the ManufacturerLink.
    const link = page.getByRole("link", { name: MANUFACTURER });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", /gingliders\.com/);

    // ─── 6. Reload → the profile re-fetches from the persisted private blob. ───
    await page.reload();
    await expect(page.getByRole("heading", { name: /edit profile/i })).toBeVisible({ timeout: 15_000 });

    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", /gingliders\.com/);

    // Belt-and-braces: the edit <select> also reflects the persisted choice.
    const selectedLabel = await wingSelect.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "",
    );
    expect(selectedLabel).toBe(MANUFACTURER);

    // ─── Required evidence screenshot (post-reload, showing Gin Gliders). ──────
    await page.screenshot({ path: FINAL_SHOT, fullPage: true });
    await shot(page, "04-reload-shows-manufacturer");
  });
});
