import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Round, RoundBrief } from "@bccweb/types";
import { invoke, makeAuthRequest, MockHttpRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash, diffMaterialFields } from "../../lib/signTofly/briefVersion.js";
import "../brief.js";

// Valid magic-byte prefixes so matchesMagicBytes() passes (real Azurite upload).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

const UUID_JPG = (id: string) => new RegExp(`^round-briefs/${id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`);

function pngFile(name = "shot.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}
function jpegFile(name = "shot.jpg"): File {
  return new File([JPEG_BYTES], name, { type: "image/jpeg" });
}

async function uploadReq(roundId: string, file: File): Promise<MockHttpRequest> {
  const { user } = await bootstrapAdmin();
  const req = makeAuthRequest(user.id, user.email, { method: "POST", params: { id: roundId } });
  (req as unknown as { formData: () => Promise<FormData> }).formData = async () => {
    const fd = new FormData();
    fd.append("file", file);
    return fd;
  };
  return req;
}

async function adminReq(
  options: Parameters<typeof makeAuthRequest>[2] = {},
): Promise<MockHttpRequest> {
  const { user } = await bootstrapAdmin();
  return makeAuthRequest(user.id, user.email, options);
}

async function seedRound(status: Round["status"], id = randomUUID()): Promise<string> {
  const round: Round = {
    id,
    date: "2026-06-09",
    status,
    isLocked: status === "Locked" || status === "Complete",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: randomUUID(), name: "Test Club" },
    season: { year: 2026 },
    teams: [],
  };
  await writePrivateJson(`rounds/${id}.json`, round);
  return id;
}

async function seedBrief(
  roundId: string,
  opts: { frozen?: boolean; imagePaths?: string[] } = {},
): Promise<RoundBrief & { version: number }> {
  const brief: RoundBrief & { version: number } = {
    roundId,
    version: 1,
    generatedAt: new Date().toISOString(),
    date: "2026-06-09",
    siteName: "Milk Hill",
    imagePaths: opts.imagePaths ?? [],
    teams: [],
  };
  if (opts.frozen) brief.hash = computeBriefHash(brief);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
  return brief;
}

describe("brief image upload / delete (UUID paths, lease-gated)", () => {
  it("upload on Confirmed with no brief lazy-creates via CAS and appends a UUID path; GET streams it", async () => {
    const id = await seedRound("Confirmed");

    const res = await invoke("uploadBriefImage", await uploadReq(id, jpegFile()));

    expect(res.status).toBe(200);
    const path = (res.jsonBody as { path: string }).path;
    expect(path).toMatch(UUID_JPG(id));

    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
    expect(brief?.imagePaths).toEqual([path]);

    const getRes = await invoke(
      "getRoundBriefImage",
      await adminReq({ method: "GET", params: { id, n: "1" } }),
    );
    expect(getRes.status).toBe(200);
    expect(String(getRes.headers?.["Content-Type"])).toContain("image/jpeg");
  });

  it("GET image when the brief is absent soft-fails 404 (never 500)", async () => {
    const id = await seedRound("Confirmed");

    const res = await invoke(
      "getRoundBriefImage",
      await adminReq({ method: "GET", params: { id, n: "1" } }),
    );

    expect(res.status).toBe(404);
  });

  it("delete then reupload yields a DIFFERENT path; diffMaterialFields reports imagePaths changed", async () => {
    const id = await seedRound("Confirmed");

    const up1 = await invoke("uploadBriefImage", await uploadReq(id, jpegFile()));
    const path1 = (up1.jsonBody as { path: string }).path;
    const briefBefore = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);

    const del = await invoke(
      "deleteBriefImage",
      await adminReq({ method: "DELETE", params: { id, index: "1" } }),
    );
    expect(del.status).toBe(204);

    const up2 = await invoke("uploadBriefImage", await uploadReq(id, jpegFile()));
    const path2 = (up2.jsonBody as { path: string }).path;

    expect(path2).not.toBe(path1);
    const briefAfter = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
    expect(diffMaterialFields(briefBefore!, briefAfter!)).toContain("imagePaths");
  });

  it("B3: upload at BriefComplete is rejected 409 UNDER the round lease and the frozen hash is unchanged", async () => {
    const id = await seedRound("Confirmed");
    await seedBrief(id, { frozen: true, imagePaths: [`round-briefs/${id}/${randomUUID()}.jpg`] });
    const before = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
    const hashBefore = computeBriefHash(before!);

    // Simulate T7 freezing the round at BriefComplete.
    const round = await readPrivateJson<Round>(`rounds/${id}.json`);
    await writePrivateJson(`rounds/${id}.json`, { ...round!, status: "BriefComplete" });

    const res = await invoke("uploadBriefImage", await uploadReq(id, jpegFile()));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_LOCKED");
    const after = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
    expect(after?.imagePaths).toEqual(before?.imagePaths);
    expect(computeBriefHash(after!)).toBe(hashBefore);
  });

  it("R3: concurrent first uploads on a missing brief — CAS create wins once, both images appended, no clobber", async () => {
    const id = await seedRound("Confirmed");

    const reqA = await uploadReq(id, jpegFile());
    const reqB = await uploadReq(id, pngFile());
    const [r1, r2] = await Promise.all([
      invoke("uploadBriefImage", reqA),
      invoke("uploadBriefImage", reqB),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const p1 = (r1.jsonBody as { path: string }).path;
    const p2 = (r2.jsonBody as { path: string }).path;
    expect(p1).not.toBe(p2);

    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
    expect(brief?.imagePaths).toHaveLength(2);
    expect(brief?.imagePaths).toEqual(expect.arrayContaining([p1, p2]));
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(true);
  });

  it("rejects a PNG-declared file carrying JPEG bytes (magic mismatch) before touching the brief", async () => {
    const id = await seedRound("Confirmed");
    const badFile = new File([JPEG_BYTES], "foo.png", { type: "image/png" });

    const res = await invoke("uploadBriefImage", await uploadReq(id, badFile));

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("IMAGE_MAGIC_MISMATCH");
  });

  it("rejects upload when 10 images already present", async () => {
    const id = await seedRound("Confirmed");
    await seedBrief(id, {
      imagePaths: Array.from({ length: 10 }, () => `round-briefs/${id}/${randomUUID()}.jpg`),
    });

    const res = await invoke("uploadBriefImage", await uploadReq(id, jpegFile()));

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("TOO_MANY_IMAGES");
  });
});
