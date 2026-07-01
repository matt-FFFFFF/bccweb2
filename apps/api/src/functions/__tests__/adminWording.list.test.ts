import { beforeEach, describe, expect, it } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { MockHttpRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin } from "../../__tests__/helpers/seed.js";
import { getPrivateBlockBlobClient } from "../../lib/blob.js";
import { addWordingVersion } from "../../lib/signTofly/wording.js";

import "../adminWording.js";

describe("admin sign-to-fly wording list endpoint", () => {
  beforeEach(async () => {
    await Promise.all([
      getPrivateBlockBlobClient("sign-to-fly/wording/active.json").deleteIfExists(),
      ...[1, 2, 3, 4].map((version) =>
        getPrivateBlockBlobClient(`sign-to-fly/wording/${version}.json`).deleteIfExists(),
      ),
    ]);
  });

  it("returns wording versions in descending order", async () => {
    await seedThreeVersions();

    const res = await invokeList();

    expect(res.status).toBe(200);
    expect((res.jsonBody as Array<{ version: number }>).map((item) => item.version)).toEqual([3, 2, 1]);
  });

  it("returns metadata only without wording content fields", async () => {
    await seedThreeVersions();

    const res = await invokeList();
    const body = res.jsonBody as Array<Record<string, unknown>>;

    expect(body).toHaveLength(3);
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(["blobPath", "lastModified", "version"]);
      expect(item).not.toHaveProperty("html");
      expect(item).not.toHaveProperty("plainText");
      expect(item).not.toHaveProperty("hash");
      expect(item).not.toHaveProperty("createdBy");
      expect(item).toMatchObject({
        version: expect.any(Number),
        blobPath: expect.stringMatching(/^sign-to-fly\/wording\/\d+\.json$/),
        lastModified: expect.any(Date),
      });
    }
  });
});

async function seedThreeVersions(): Promise<void> {
  await addWordingVersion({ markdown: "# v1", createdBy: "admin-list" });
  await addWordingVersion({ markdown: "# v2", createdBy: "admin-list" });
  await addWordingVersion({ markdown: "# v3", createdBy: "admin-list" });
}

async function invokeList() {
  const entry = getRegisteredHandler("listSignToFlyWording");
  if (!entry) throw new Error("listSignToFlyWording handler not registered");

  const { token } = await bootstrapAdmin();
  return entry.handler(
    new MockHttpRequest({
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
    { functionName: "listSignToFlyWording" },
  );
}
