import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import type { User } from "@bccweb/types";
import { EmailIndexConflictError, getCallerIdentity, getOrCreateUser, updatePilotEmailIndex } from "../auth.js";
import { getPrivateBlockBlobClient } from "../blob.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import { privateBlobExists, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";

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

  it("throws EmailIndexConflictError when a pilot email is claimed by a different pilot", async () => {
    // Given: the pilot email index already maps the email to pilot A.
    const email = `pilot-conflict-${randomUUID()}@example.com`;
    const pilotA = randomUUID();
    const pilotB = randomUUID();
    await writePrivateJson("pilot-email-index.json", { [email.toLowerCase()]: pilotA });

    // When / Then: pilot B attempts the same claim and receives the owner id.
    await expect(updatePilotEmailIndex(email, pilotB)).rejects.toMatchObject({
      name: "EmailIndexConflictError",
      existingId: pilotA,
    });
    await expect(updatePilotEmailIndex(email, pilotB)).rejects.toBeInstanceOf(
      EmailIndexConflictError,
    );
  });

  it("allows a pilot email claim when the existing owner is the same pilot", async () => {
    // Given: the pilot email index already maps the email to pilot A.
    const email = `pilot-idempotent-${randomUUID()}@example.com`;
    const pilotA = randomUUID();
    await writePrivateJson("pilot-email-index.json", { [email.toLowerCase()]: pilotA });

    // When: pilot A claims the email again.
    await updatePilotEmailIndex(email, pilotA);

    // Then: the claim succeeds without changing ownership.
    const index = await readPrivateJson<Record<string, string>>("pilot-email-index.json");
    expect(index?.[email.toLowerCase()]).toBe(pilotA);
  });

  it("throws EmailIndexConflictError by default when creating a user for an owned email", async () => {
    // Given: the user email index already maps the email to user A.
    const email = `user-conflict-${randomUUID()}@example.com`;
    const userA = randomUUID();
    const userB = randomUUID();
    await writePrivateJson("user-index.json", { [email.toLowerCase()]: userA });

    // When / Then: default getOrCreateUser policy propagates the conflict.
    await expect(getOrCreateUser(userB, email)).rejects.toMatchObject({
      name: "EmailIndexConflictError",
      existingId: userA,
    });
  });

  it("swallows a user-index conflict and leaves the existing owner unchanged", async () => {
    // Given: the user email index already maps the email to user A.
    const email = `user-swallow-${randomUUID()}@example.com`;
    const userA = randomUUID();
    const userB = randomUUID();
    await writePrivateJson("user-index.json", { [email.toLowerCase()]: userA });

    // When: user B is created with the swallow policy.
    const user = await getOrCreateUser(userB, email, { onIndexConflict: "swallow" });

    // Then: the caller gets an in-memory user B and the index still points at user A.
    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(user.id).toBe(userB);
    expect(index?.[email.toLowerCase()]).toBe(userA);
  });

  it("returns a bare identity without persisting when swallow sees a foreign-owned email", async () => {
    // Given: the email belongs to user A and links to pilot A, while user B has no user blob.
    const email = `wrong-identity-${randomUUID()}@example.com`;
    const userA = randomUUID();
    const userB = randomUUID();
    const pilotA = randomUUID();
    await getPrivateBlockBlobClient(`users/${userB}.json`).deleteIfExists();
    await writePrivateJson("user-index.json", { [email.toLowerCase()]: userA });
    await writePrivateJson("pilot-email-index.json", { [email.toLowerCase()]: pilotA });

    // When: user B resolves via the swallow policy.
    const user = await getOrCreateUser(userB, email, { onIndexConflict: "swallow" });

    // Then: no pilot linkage is returned, no user B blob is written, and user A owns the index.
    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(user).toMatchObject({
      id: userB,
      roles: [],
      pilotId: null,
      clubId: null,
    });
    expect(await privateBlobExists(`users/${userB}.json`)).toBe(false);
    expect(index?.[email.toLowerCase()]).toBe(userA);

    // When: the same wrong-identity JWT is used through getCallerIdentity.
    const identity = await getCallerIdentity(
      makeAuthRequest(userB, email) as unknown as Parameters<typeof getCallerIdentity>[0],
    );

    // Then: identity resolution remains bare and does not throw or persist.
    expect(identity).toMatchObject({
      userId: userB,
      roles: [],
      pilotId: null,
      clubId: null,
    });
    expect(await privateBlobExists(`users/${userB}.json`)).toBe(false);
  });

  it("self-heals an orphaned same-owner user-index entry under the swallow policy", async () => {
    // Given: the user index maps the email to user B, but the user B blob is absent.
    const email = `orphan-self-heal-${randomUUID()}@example.com`;
    const userB = randomUUID();
    await getPrivateBlockBlobClient(`users/${userB}.json`).deleteIfExists();
    await writePrivateJson("user-index.json", { [email.toLowerCase()]: userB });

    // When: user B resolves via the swallow policy.
    const user = await getOrCreateUser(userB, email, { onIndexConflict: "swallow" });

    // Then: the same-owner claim is idempotent and the missing user blob is restored.
    const stored = await readPrivateJson<User>(`users/${userB}.json`);
    expect(user.id).toBe(userB);
    expect(stored).toMatchObject({ id: userB, email, pilotId: null, clubId: null });
  });
});
