// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SignToFlyWording } from "@bccweb/types";
import { getPrivateBlockBlobClient, resetBlobSingletons } from "../../blob.js";
import { readPrivateJson, privateBlobExists } from "../../../__tests__/helpers/seed.js";
import { addWordingVersion, getActiveWording } from "../wording.js";

import "../../../__tests__/helpers/azurite.js";

resetBlobSingletons();

describe("Sign-to-Fly wording bootstrap", () => {
  beforeEach(async () => {
    await Promise.all([
      getPrivateBlockBlobClient("sign-to-fly/wording/active.json").deleteIfExists(),
      ...[1, 2, 3, 4].map((version) =>
        getPrivateBlockBlobClient(`sign-to-fly/wording/${version}.json`).deleteIfExists(),
      ),
    ]);
  });

  it("virgin store addWordingVersion creates version 1 without leasing the missing active pointer", async () => {
    const wording = await addWordingVersion({
      markdown: "# bootstrap wording",
      createdBy: "admin-bootstrap",
    });

    expect(wording).toMatchObject({
      version: 1,
      hash: hashMarkdown("# bootstrap wording"),
      markdown: "# bootstrap wording",
      createdBy: "admin-bootstrap",
    });
    expect(wording).not.toHaveProperty("html");
    expect(wording).not.toHaveProperty("plainText");
    expect(wording.createdAt).toEqual(expect.any(String));
  });

  it("bootstrap creates both the v1 blob and the active pointer", async () => {
    await addWordingVersion({
      markdown: "# both blobs",
      createdBy: "admin-bootstrap",
    });

    const version = await readPrivateJson<SignToFlyWording>("sign-to-fly/wording/1.json");
    const active = await readPrivateJson<{ activeVersion: number }>("sign-to-fly/wording/active.json");

    expect(await privateBlobExists("sign-to-fly/wording/1.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/active.json")).toBe(true);
    expect(version).toMatchObject({ version: 1, markdown: "# both blobs" });
    expect(active).toEqual({ activeVersion: 1 });
    await expect(getActiveWording()).resolves.toMatchObject({ version: 1, markdown: "# both blobs" });
  });

  it("heals a partial bootstrap with v1 present and active pointer absent", async () => {
    const first: SignToFlyWording = {
      version: 1,
      hash: hashMarkdown("# partial bootstrap seed"),
      markdown: "# partial bootstrap seed",
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      createdBy: "admin-seed",
    };
    const content = JSON.stringify(first, null, 2);
    await getPrivateBlockBlobClient("sign-to-fly/wording/1.json").upload(
      content,
      Buffer.byteLength(content),
      {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: { ifNoneMatch: "*" },
      },
    );

    const wording = await addWordingVersion({
      markdown: "# healed wording",
      createdBy: "admin-heal",
    });

    expect(wording).toMatchObject({
      version: 2,
      hash: hashMarkdown("# healed wording"),
      markdown: "# healed wording",
      createdBy: "admin-heal",
    });
    await expect(getActiveWording()).resolves.toMatchObject({ version: 2 });
  });

  it("three concurrent addWordingVersion calls against virgin store produce v1, v2, and v3", async () => {
    const attempts = await Promise.all([
      addWordingVersion({ markdown: "# race a", createdBy: "admin-a" }),
      addWordingVersion({ markdown: "# race b", createdBy: "admin-b" }),
      addWordingVersion({ markdown: "# race c", createdBy: "admin-c" }),
    ]);

    expect(attempts.map((wording) => wording.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(await privateBlobExists("sign-to-fly/wording/1.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/2.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/3.json")).toBe(true);
    await expect(getActiveWording()).resolves.toMatchObject({ version: 3 });
  });
});

function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
