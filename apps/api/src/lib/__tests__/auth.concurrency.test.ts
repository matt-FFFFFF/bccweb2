import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import { getOrCreateUser } from "../auth.js";
import { getPrivateBlockBlobClient } from "../blob.js";
import { readPrivateJson } from "../../__tests__/helpers/seed.js";

describe("auth index concurrency", () => {
  it("keeps all user-index entries when 5 users are created in parallel", async () => {
    await getPrivateBlockBlobClient("user-index.json").deleteIfExists();

    const entries = Array.from({ length: 5 }, (_, i) => {
      const userId = randomUUID();
      const email = `concurrency-${i}-${userId}@example.com`;
      return { userId, email };
    });

    await Promise.all(entries.map(({ userId, email }) => getOrCreateUser(userId, email)));

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(index).toBeTruthy();
    for (const { userId, email } of entries) {
      expect(index?.[email.toLowerCase()]).toBe(userId);
    }
  });
});
