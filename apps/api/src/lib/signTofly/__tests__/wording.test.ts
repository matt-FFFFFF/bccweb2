import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SignToFlyWording } from "@bccweb/types";
import { getPrivateBlockBlobClient } from "../../blob.js";
import { addWordingVersion, getActiveWording } from "../wording.js";

// Stability lock: the wording hash is sha256 of the RAW markdown source bytes.
// This hard-coded value pins the hashing contract — if it ever needs changing
// the algorithm has drifted and every wordingHash already recorded in the
// signature ledger would silently mismatch. Do not edit lightly.
const FIXED_MARKDOWN =
  "# Sign to Fly\n\nBy clicking **Sign to Fly**, you confirm you have received and understood a full brief for this round.\n";
const FIXED_MARKDOWN_SHA256 =
  "6dda7f5c90373fc53e91f9c9a65dfd301e3d956ba6950355597d430309744bfe";

describe("Sign-to-Fly wording registry", () => {
  it("hashes raw markdown with a stable sha256 (stability lock)", async () => {
    await seedVersion1(FIXED_MARKDOWN);

    const active = await getActiveWording();

    expect(active.hash).toBe(FIXED_MARKDOWN_SHA256);
    expect(active.hash).toBe(hashMarkdown(FIXED_MARKDOWN));
  });

  it("getActiveWording returns seeded v1 with matching markdown + hash", async () => {
    await seedVersion1(FIXED_MARKDOWN);

    const active = await getActiveWording();

    expect(active.version).toBe(1);
    expect(active.markdown).toBe(FIXED_MARKDOWN);
    expect(active.hash).toBe(FIXED_MARKDOWN_SHA256);
    expect(active).not.toHaveProperty("html");
    expect(active).not.toHaveProperty("plainText");
  });

  it("addWordingVersion creates v2, marks v1 superseded, switches active pointer to v2; v1 markdown unchanged", async () => {
    await seedVersion1("# v1 wording");

    const v2 = await addWordingVersion({
      markdown: "# v2 wording",
      createdBy: "admin-user",
    });

    const v1 = await readPrivateJson<SignToFlyWording>("sign-to-fly/wording/1.json");
    const active = await getActiveWording();

    expect(v2.version).toBe(2);
    expect(v2.markdown).toBe("# v2 wording");
    expect(v2.hash).toBe(hashMarkdown("# v2 wording"));
    expect(v2).not.toHaveProperty("html");
    expect(v2).not.toHaveProperty("plainText");
    expect(v1.markdown).toBe("# v1 wording");
    expect(v1.supersededBy).toBe(2);
    expect(v1.supersededAt).toEqual(expect.any(String));
    expect(active.version).toBe(2);
  });

  it("addWordingVersion under concurrent calls: lease retry produces sequential versions", async () => {
    await seedVersion1("# v1 concurrent");

    const attempts = await Promise.allSettled([
      addWordingVersion({ markdown: "# v2-a", createdBy: "admin-a" }),
      addWordingVersion({ markdown: "# v2-b", createdBy: "admin-b" }),
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<SignToFlyWording> => result.status === "fulfilled",
    );

    expect(fulfilled).toHaveLength(2);
    const versions = fulfilled.map((result) => result.value.version).sort((a, b) => a - b);
    expect(versions).toEqual([2, 3]);
    expect(await blobExists("sign-to-fly/wording/2.json")).toBe(true);
    expect(await blobExists("sign-to-fly/wording/3.json")).toBe(true);
  });
});

async function seedVersion1(markdown: string): Promise<void> {
  await getPrivateBlockBlobClient("sign-to-fly/wording/2.json").deleteIfExists();
  await getPrivateBlockBlobClient("sign-to-fly/wording/3.json").deleteIfExists();
  const wording: SignToFlyWording = {
    version: 1,
    hash: hashMarkdown(markdown),
    markdown,
    createdAt: new Date().toISOString(),
    createdBy: "seed-test",
  };
  await writePrivateJson("sign-to-fly/wording/1.json", wording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

async function writePrivateJson(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await getPrivateBlockBlobClient(path).upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

async function readPrivateJson<T>(path: string): Promise<T> {
  const response = await getPrivateBlockBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

function blobExists(path: string): Promise<boolean> {
  return getPrivateBlockBlobClient(path).exists();
}

function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
