// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resetAzuriteAndSeedAdmin } from "./_setup/reset-azurite.js";

/**
 * Real-stack E2E: admin sign-to-fly wording first-publish flow.
 *
 * Hits the LIVE stack only (Vite :5173 + API :7071 + Azurite :10000) — NO
 * request interception, NO test-only backend hooks, NO hand-minted JWT. The
 * dev stack is brought up by Task 6; this spec only resets Azurite (admin-only
 * seed) per test via resetAzuriteAndSeedAdmin().
 *
 * Proves: from a clean Azurite seeded with ONLY the admin, the admin opens the
 * sign-to-fly wording page with NO error (the 503 WORDING_NOT_SEEDED empty
 * state is handled gracefully), publishes v1, and `active` becomes v1 with a
 * valid history row (no "Invalid Date", no crash).
 */

const EVIDENCE_DIR = path.join(".omo", "evidence", "e2e-sign-to-fly-wording");

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

let admin: { email: string; password: string };

test.beforeEach(async () => {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  // Clean Azurite + admin-only seed. The helper owns ALL state; we seed nothing else.
  admin = await resetAzuriteAndSeedAdmin();
});

test.describe("admin sign-to-fly wording", () => {
  test("empty 503 state → publish v1 → active becomes v1 with valid history", async ({ page }) => {
    // Accept the window.confirm published at SignToFlyWording.tsx:104 BEFORE any
    // Publish click — otherwise the dialog blocks Playwright indefinitely.
    page.on("dialog", (d) => {
      void d.accept();
    });

    // --- Log in via the real UI (no hand-minted JWT). ---
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 10_000 });
    await page.getByLabel(/email address/i).fill(admin.email);
    await page.getByLabel(/^password$/i).fill(admin.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Nav renders the signed-in admin's email — proves the real login round-trip.
    await expect(page.getByText(admin.email)).toBeVisible({ timeout: 10_000 });

    // --- Navigate to the wording admin page; assert the graceful EMPTY state. ---
    await page.goto("/admin/sign-to-fly-wording");

    // Page heading must render (page did not crash / redirect).
    await expect(page.getByRole("heading", { name: /sign-to-fly wording/i })).toBeVisible({ timeout: 10_000 });

    // Positive empty-state proof: the publish form heading is visible and the
    // "currently active" card reports version "none".
    await expect(page.getByRole("heading", { name: /publish new version/i })).toBeVisible();
    await expect(page.getByText(/version none/i)).toBeVisible();

    // Negative proof: the fatal load-error banner did NOT render. The 503
    // WORDING_NOT_SEEDED empty state must not surface as an error.
    await expect(page.getByText(/WORDING_NOT_SEEDED|Failed to load wording/i)).toHaveCount(0);
    await shot(page, "01-empty-state-form");

    // --- Fill the publish form (MarkdownEditor). ---
    // @uiw/react-md-editor renders its editable area as .w-md-editor-text-input.
    const mdInput = page.locator(".w-md-editor-text-input");
    await mdInput.fill("## QA wording v1");
    await shot(page, "02-filled-form");

    // Empty state → active null → nextVersion 1 → button label "Publish Version 1".
    await page.getByRole("button", { name: /Publish Version 1/ }).click();

    // --- Assert success banner. ---
    await expect(page.getByText(/Version 1 published successfully/)).toBeVisible({ timeout: 10_000 });
    await shot(page, "03-publish-success");

    // --- Authenticated fetch of the active wording (real API, real token). ---
    const active = await page.evaluate(async () => {
      const t = localStorage.getItem("bcc_access_token");
      const r = await fetch("/api/sign-to-fly/wording/active", {
        headers: { Authorization: `Bearer ${t}` },
      });
      return r.json() as Promise<{ version: number; markdown: string }>;
    });
    expect(active.version).toBe(1);
    expect(active.markdown).toBe("## QA wording v1");

    // --- History table: a real row, a valid date, no crash. ---
    const historyTable = page.locator("table");
    await expect(historyTable).toBeVisible();
    await expect(historyTable).not.toContainText("Invalid Date");
    // The just-published version 1 row is present and active.
    await expect(historyTable.locator("tbody tr")).toHaveCount(1);
    await expect(historyTable.getByText("Active", { exact: true })).toBeVisible();
    await shot(page, "04-history-table");
  });
});
