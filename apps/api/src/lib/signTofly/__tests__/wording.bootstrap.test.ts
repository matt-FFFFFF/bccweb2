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
      html: "<p>bootstrap wording</p>",
      plainText: "bootstrap wording",
      createdBy: "admin-bootstrap",
    });

    expect(wording).toMatchObject({
      version: 1,
      hash: hashHtml("<p>bootstrap wording</p>"),
      html: "<p>bootstrap wording</p>",
      plainText: "bootstrap wording",
      createdBy: "admin-bootstrap",
    });
    expect(wording.createdAt).toEqual(expect.any(String));
  });

  it("bootstrap creates both the v1 blob and the active pointer", async () => {
    await addWordingVersion({
      html: "<p>both blobs</p>",
      plainText: "both blobs",
      createdBy: "admin-bootstrap",
    });

    const version = await readPrivateJson<SignToFlyWording>("sign-to-fly/wording/1.json");
    const active = await readPrivateJson<{ activeVersion: number }>("sign-to-fly/wording/active.json");

    expect(await privateBlobExists("sign-to-fly/wording/1.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/active.json")).toBe(true);
    expect(version).toMatchObject({ version: 1, html: "<p>both blobs</p>" });
    expect(active).toEqual({ activeVersion: 1 });
    await expect(getActiveWording()).resolves.toMatchObject({ version: 1, html: "<p>both blobs</p>" });
  });

  it("three concurrent addWordingVersion calls against virgin store produce v1, v2, and v3", async () => {
    const attempts = await Promise.all([
      addWordingVersion({ html: "<p>race a</p>", plainText: "race a", createdBy: "admin-a" }),
      addWordingVersion({ html: "<p>race b</p>", plainText: "race b", createdBy: "admin-b" }),
      addWordingVersion({ html: "<p>race c</p>", plainText: "race c", createdBy: "admin-c" }),
    ]);

    expect(attempts.map((wording) => wording.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(await privateBlobExists("sign-to-fly/wording/1.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/2.json")).toBe(true);
    expect(await privateBlobExists("sign-to-fly/wording/3.json")).toBe(true);
    await expect(getActiveWording()).resolves.toMatchObject({ version: 3 });
  });
});

function hashHtml(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}
