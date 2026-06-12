import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SignToFlyWording } from "@bccweb/types";
import { getPrivateBlockBlobClient } from "../../blob.js";
import { addWordingVersion, getActiveWording } from "../wording.js";

const LEGACY_HTML = `<div class="alert alert-warning">
    By clicking <strong>Sign to Fly</strong>, you are confirming that you have received and understood a full brief for this round, which incorporated:
    <br /><br />
    The day's expected meteorological conditions, including anticipated convection activity, convergence lines, cloud cover, and any frontal effects (including sea breeze fronts).
    <br /><br />
    An understanding of any conditions which would require terminating the flight for safety reasons, made with reference to a current aeronautical chart, details of all controlled airspace
    or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAMs), up to a clearly defined “May not exceed” limit.
    <br /><br />
    That you have received and understood a suitable briefing, made with reference to a current aeronautical chart, which addresses all controlled airspace or hazards to aviation that may be encountered along the anticipated
    route of the flight (including NOTAM’s), up to the “Do not exceed” limit detailed in this briefing document.
    <br /><br />
          <div class="alert alert-danger">
              <b>Club Pilots</b><br />
              You are confirming that you are aware of the geographical limits and altitude, height or flight level limits of the airspace or hazards and that you are confident of your ability to navigate and safely avoid any such areas or hazards.
              <br /><br />
              In addition you are confirming that you understand that if the flight should stray outside the anticipated “cone" of the briefed track, or reach the “May not exceed” limit, your flight must be discontinued.
          </div>
    Are you sure you want to <strong>Sign to Fly</strong> in this round?
</div>`;

describe("Sign-to-Fly wording registry", () => {
  it("getActiveWording returns seeded v1 with matching hash", async () => {
    await seedVersion1(LEGACY_HTML);

    const active = await getActiveWording();

    expect(active.version).toBe(1);
    expect(active.html).toBe(LEGACY_HTML);
    expect(active.hash).toBe(hashHtml(LEGACY_HTML));
  });

  it("addWordingVersion creates v2, marks v1 superseded, switches active pointer to v2; v1 html unchanged", async () => {
    await seedVersion1("<p>v1 wording</p>");

    const v2 = await addWordingVersion({
      html: "<p>v2 wording</p>",
      plainText: "v2 wording",
      createdBy: "admin-user",
    });

    const v1 = await readPrivateJson<SignToFlyWording>("sign-to-fly/wording/1.json");
    const active = await getActiveWording();

    expect(v2.version).toBe(2);
    expect(v2.hash).toBe(hashHtml("<p>v2 wording</p>"));
    expect(v1.html).toBe("<p>v1 wording</p>");
    expect(v1.supersededBy).toBe(2);
    expect(v1.supersededAt).toEqual(expect.any(String));
    expect(active.version).toBe(2);
  });

  it("addWordingVersion under concurrent calls: lease retry produces sequential versions", async () => {
    await seedVersion1("<p>v1 concurrent</p>");

    const attempts = await Promise.allSettled([
      addWordingVersion({ html: "<p>v2-a</p>", plainText: "v2-a", createdBy: "admin-a" }),
      addWordingVersion({ html: "<p>v2-b</p>", plainText: "v2-b", createdBy: "admin-b" }),
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

async function seedVersion1(html: string): Promise<void> {
  await getPrivateBlockBlobClient("sign-to-fly/wording/2.json").deleteIfExists();
  await getPrivateBlockBlobClient("sign-to-fly/wording/3.json").deleteIfExists();
  const wording: SignToFlyWording = {
    version: 1,
    hash: hashHtml(html),
    html,
    plainText: html.replace(/<[^>]+>/g, ""),
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
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

function blobExists(path: string): Promise<boolean> {
  return getPrivateBlockBlobClient(path).exists();
}

function hashHtml(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}
