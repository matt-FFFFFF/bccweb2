// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";

interface MigrateModule {
  manufacturerFromLegacyRow(row: { ID: number; Name: string; WebsiteUrl?: string | null }): {
    id: string;
    legacyId: number;
    name: string;
    websiteUrl?: string;
  };
}

async function loadMigrationHelpers(): Promise<MigrateModule> {
  const modulePath = new URL("../../../../scripts/migrate/transforms.mjs", import.meta.url).href;
  return import(modulePath) as Promise<MigrateModule>;
}

describe("manufacturer migration", () => {
  it("non-null WebsiteUrl values round-trip; empty strings normalize to undefined", async () => {
    const { manufacturerFromLegacyRow } = await loadMigrationHelpers();

    expect(manufacturerFromLegacyRow({ ID: 1, Name: "Advance", WebsiteUrl: "https://advance.net" }).websiteUrl)
      .toBe("https://advance.net");
    expect(manufacturerFromLegacyRow({ ID: 2, Name: "Gin", WebsiteUrl: "   " }).websiteUrl)
      .toBeUndefined();
    expect(manufacturerFromLegacyRow({ ID: 3, Name: "Ozone", WebsiteUrl: "" }).websiteUrl)
      .toBeUndefined();
  });
});
