// SPDX-License-Identifier: MPL-2.0
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { resetAzuriteAndSeedAdmin } from "./_setup/reset-azurite.js";
import { seedRescoreRound, type SeededRescoreRound } from "./_setup/seed-rescore-round.js";

/**
 * Real-stack E2E: admin round-rescore enqueue → poll → counts.
 *
 * Hits the LIVE stack only (Vite :5173 + API :7071 + Azurite :10000 + the
 * `rescoreWorker` queue trigger) — NO request interception, NO test-only
 * backend hooks, NO hand-minted JWT. The dev stack is brought up by the Final
 * Verification Wave's real-QA task (`npm run e2e -- -g rescore` against
 * `make dev`); this spec only resets Azurite, seeds a Locked round with two
 * IGC-scored slots + a RoundsCoord, then drives the real UI. Mirrors
 * manufacturers.spec.ts (reset + real login + `describe.serial`).
 *
 * Proves the ASYNC enqueue→poll model: clicking Re-score does NOT return an
 * inline synchronous result — it enqueues a job (HTTP 202), shows a loading
 * overlay while the worker runs, then (polling `GET .../rescore/{jobId}`)
 * surfaces the success modal with per-slot counts. A RoundsCoord (non-admin)
 * never sees the button.
 */

const EVIDENCE_DIR = path.join(".omo", "evidence", "e2e-rescore");

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Nav renders the signed-in email — proves the real login round-trip.
  await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });
}

let admin: { email: string; password: string };
let seeded: SeededRescoreRound;

test.beforeAll(async () => {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  // Reuse the existing seed harness: clean Azurite + admin, then layer the
  // Locked-round-with-IGC and the RoundsCoord on top.
  admin = await resetAzuriteAndSeedAdmin();
  seeded = await seedRescoreRound();
});

test.describe.serial("admin round rescore (enqueue → poll → counts)", () => {
  test("admin enqueues a rescore, sees the loading overlay, then the success modal with counts", async ({ page }) => {
    // The worker + Azurite can be slow on CI — allow the full 5-minute poll plus margin.
    test.setTimeout(6 * 60_000);

    await login(page, admin.email, admin.password);

    await page.goto(`/rounds/${seeded.roundId}`);
    // Round detail rendered (site heading) and the Admin-only control is present.
    await expect(
      page.getByRole("heading", { name: new RegExp(seeded.siteName, "i") }),
    ).toBeVisible({ timeout: 15_000 });
    const rescoreButton = page.getByTestId("rescore-round-btn");
    await expect(rescoreButton).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-round-with-rescore-button");

    // Open the confirm dialog and confirm the re-score.
    await rescoreButton.click();
    await expect(page.getByTestId("rescore-confirm-dialog")).toBeVisible();
    await shot(page, "02-confirm-dialog");
    await page.getByTestId("rescore-confirm-yes").click();

    // Enqueue→poll model: a loading overlay appears while the job runs — this is
    // NOT an inline synchronous rescore result.
    await expect(page.getByTestId("rescore-loading-overlay")).toBeVisible({ timeout: 15_000 });
    await shot(page, "03-loading-overlay");

    // Poll up to 5 minutes for the worker to finish and the success modal to show.
    const successModal = page.getByTestId("rescore-success-modal");
    await expect(successModal).toBeVisible({ timeout: 5 * 60_000 });

    // The counters are shown; the two seeded IGC slots were re-scored.
    await expect(page.getByTestId("rescore-count-rescored")).toHaveText("2");
    await expect(page.getByTestId("rescore-count-manual")).toBeVisible();
    await expect(page.getByTestId("rescore-count-no-igc")).toBeVisible();
    await expect(page.getByTestId("rescore-count-budget")).toBeVisible();
    await shot(page, "04-success-modal-counts");
  });

  test("a RoundsCoord (non-admin) does not see the rescore button", async ({ page }) => {
    await login(page, seeded.coord.email, seeded.coord.password);

    await page.goto(`/rounds/${seeded.roundId}`);
    // The round renders for the coord…
    await expect(
      page.getByRole("heading", { name: new RegExp(seeded.siteName, "i") }),
    ).toBeVisible({ timeout: 15_000 });
    // …but the Admin-only rescore control is absent.
    await expect(page.getByTestId("rescore-round-btn")).toHaveCount(0);
    await shot(page, "05-coord-no-rescore-button");
  });
});
