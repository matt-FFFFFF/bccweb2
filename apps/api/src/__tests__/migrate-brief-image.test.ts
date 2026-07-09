// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";

interface MigrateModule {
  briefImageBlobFromLegacy(image: unknown): Buffer | null;
  briefImagePath(roundId: string, imageNumber?: number): string;
}

async function loadMigrationHelpers(): Promise<MigrateModule> {
  const modulePath = new URL("../../../../scripts/migrate/transforms.mjs", import.meta.url).href;
  return import(modulePath) as Promise<MigrateModule>;
}

describe("brief image migration helpers", () => {
  it("converts legacy image bytes to a blob payload", async () => {
    const { briefImageBlobFromLegacy } = await loadMigrationHelpers();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    expect(briefImageBlobFromLegacy(bytes)?.equals(Buffer.from(bytes))).toBe(true);
  });

  it("returns the private round brief image blob path", async () => {
    const { briefImagePath } = await loadMigrationHelpers();

    expect(briefImagePath("round-123")).toBe("round-briefs/round-123/image-1.png");
  });
});
