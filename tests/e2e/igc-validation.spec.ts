// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { test, expect } from "@playwright/test";
import { resetAzuriteAndSeedAdmin } from "./_setup/reset-azurite.js";
import { seedValidationRound, readPersistedScores, type SeededValidationRound } from "./_setup/seed-validation-round.js";

test.describe("IGC signature date validation E2E", () => {
  let seeded: SeededValidationRound;

  test.beforeAll(async () => {
    // Wipe storage, seed admin (qa-admin@example.test / test1234!)
    await resetAzuriteAndSeedAdmin();
    // Seed round with 2 flights (invalid & unverified) and a coord user
    seeded = await seedValidationRound();
  });

  test("operator remediation flow (admin allow + coord resubmit)", async ({ browser }) => {
    // FAI_VALI_ENABLED=false ensures we do not hit real FAI.
    // The seeded flights start in terminal states ('invalid' and 'unverified'),
    // and the test only exercises Admin Allow (which enforces locally via scoreRound
    // but skips external FAI re-validation) and Coord Resubmit (which checks UI
    // visibility without forcing a click). Thus, FAI egress is factually avoided.

    // -------------------------------------------------------------------------
    // Flow 2: Scoped Coord asserts NO Allow on invalid, sees Resubmit on unverified
    // -------------------------------------------------------------------------
    const coordContext = await browser.newContext();
    const coordPage = await coordContext.newPage();

    await coordPage.goto("/login");
    await expect(coordPage.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    await coordPage.getByLabel(/email address/i).fill(seeded.coord.email);
    await coordPage.getByLabel(/^password$/i).fill(seeded.coord.password);
    await coordPage.getByRole("button", { name: /sign in/i }).click();
    await expect(coordPage.getByText(seeded.coord.email)).toBeVisible({ timeout: 15_000 });

    // Navigate to the round details
    await coordPage.goto(`/rounds/${seeded.roundId}`);
    await expect(coordPage.getByRole("heading", { name: new RegExp(seeded.siteName, "i") })).toBeVisible();

    // Wait for the table
    const coordTable = coordPage.getByTestId("coord-igc-table");
    await expect(coordTable).toBeVisible();

    const invalidRowCoord = coordTable.locator("tr").filter({ hasText: "Sig: invalid" });
    const unverifiedRowCoord = coordTable.locator("tr").filter({ hasText: "Sig: unverified" });

    await expect(invalidRowCoord).toBeVisible();
    await expect(unverifiedRowCoord).toBeVisible();

    // Scoped coord must NOT see Allow on invalid
    await expect(invalidRowCoord.getByTestId("allow-igc-btn")).toBeHidden();
    
    // Scoped coord must see Resubmit on unverified
    await expect(unverifiedRowCoord.getByTestId("revalidate-igc-btn")).toBeVisible();

    await coordContext.close();

    // -------------------------------------------------------------------------
    // Flow 1: Admin allows invalid flight
    // -------------------------------------------------------------------------
    const preAllowScores = await readPersistedScores(seeded.roundId, seeded.teamId, seeded.invalidPilotId);
    expect(preAllowScores.pilotPoints).toBe(0);
    expect(preAllowScores.teamScore).toBe(0);

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    await adminPage.goto("/login");
    await expect(adminPage.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    await adminPage.getByLabel(/email address/i).fill("qa-admin@example.test");
    await adminPage.getByLabel(/^password$/i).fill("test1234!");
    await adminPage.getByRole("button", { name: /sign in/i }).click();
    await expect(adminPage.getByText("qa-admin@example.test")).toBeVisible({ timeout: 15_000 });

    await adminPage.goto(`/rounds/${seeded.roundId}`);
    await expect(adminPage.getByRole("heading", { name: new RegExp(seeded.siteName, "i") })).toBeVisible();

    const adminTable = adminPage.getByTestId("coord-igc-table");
    await expect(adminTable).toBeVisible();

    const invalidRowAdmin = adminTable.locator("tr").filter({ hasText: "Sig: invalid" });
    
    const allowBtn = invalidRowAdmin.getByTestId("allow-igc-btn");
    await expect(allowBtn).toBeVisible();

    // Click Allow
    await allowBtn.click();

    // The row should update to show Overridden
    await expect(invalidRowAdmin.getByText("Overridden")).toBeVisible({ timeout: 15_000 });
    
    // Verify scoring is actually persisted to the private blob
    await expect.poll(
      async () => {
        const s = await readPersistedScores(seeded.roundId, seeded.teamId, seeded.invalidPilotId);
        return s.pilotPoints > 0 && s.teamScore > 0;
      },
      { timeout: 10_000 }
    ).toBe(true);

    await adminContext.close();
  });
});
