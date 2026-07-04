import { randomUUID } from "crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pilot, PilotSummary, User } from "@bccweb/types";

const blobJsonControl = vi.hoisted(() => ({ failUserWrite: false }));

vi.mock("../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(
      (path: string, schema: unknown, data: unknown, leaseId?: string, opts?: unknown) => {
        if (blobJsonControl.failUserWrite && path.startsWith("users/")) {
          return Promise.reject(new Error("simulated user link write failure"));
        }
        return actual.writePrivateJson(path, schema, data, leaseId, opts);
      },
    ),
  };
});

import {
  releasePilotEmailClaim,
  updatePilotEmailIndex,
} from "../lib/auth.js";
import { getPrivateContainer } from "./helpers/azurite.js";
import { makeAuthRequest, invoke } from "./helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
} from "./helpers/seed.js";

async function listPrivatePilotBlobNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix: "pilots/" })) {
    names.push(item.name);
  }
  return names;
}

async function createPilotForUser(user: User, email: string) {
  return invoke(
    "createMyPilot",
    makeAuthRequest(user.id, email, {
      method: "POST",
      body: { firstName: "A", lastName: "B" },
    }),
  );
}

describe("createMyPilot", () => {
  it("leaves no orphan when a pilot email conflict happens before writes", async () => {
    // Given: user registration happened before any pilot owned this email.
    const email = `conflict-${randomUUID()}@example.com`;
    const { user } = await makeUser({ email, emailVerified: true });
    await writePrivateJson("pilot-email-index.json", {
      [email.toLowerCase()]: randomUUID(),
    });

    // When: profile creation is attempted twice after a different pilot claims it.
    const first = await createPilotForUser(user, email);
    const second = await createPilotForUser(user, email);

    // Then: both calls fail without private/public/user side effects or accumulation.
    expect(first.status).toBe(409);
    expect(first.jsonBody).toMatchObject({ code: "PILOT_EMAIL_TAKEN" });
    expect(second.status).toBe(409);
    expect(second.jsonBody).toMatchObject({ code: "PILOT_EMAIL_TAKEN" });
    expect(await listPrivatePilotBlobNames()).toEqual([]);

    const publicPilots = await readPublicJson<PilotSummary[]>("pilots.json");
    expect(publicPilots ?? []).toEqual([]);

    const storedUser = await readPrivateJson<User>(`users/${user.id}.json`);
    expect(storedUser?.pilotId).toBeNull();
  });

  it("rolls back the pilot blob and email claim when linking the user fails", async () => {
    // Given: a verified user with an unclaimed email, and the release primitive
    // keeps claims owned by a different pilot.
    const primitiveEmail = `primitive-${randomUUID()}@example.com`;
    const firstPilotId = randomUUID();
    await updatePilotEmailIndex(primitiveEmail, firstPilotId);
    await releasePilotEmailClaim(primitiveEmail, randomUUID());
    expect(
      (await readPrivateJson<Record<string, string>>("pilot-email-index.json"))?.[
        primitiveEmail.toLowerCase()
      ],
    ).toBe(firstPilotId);
    await releasePilotEmailClaim(primitiveEmail, firstPilotId);
    expect(
      (await readPrivateJson<Record<string, string>>("pilot-email-index.json"))?.[
        primitiveEmail.toLowerCase()
      ],
    ).toBeUndefined();

    const email = `rollback-${randomUUID()}@example.com`;
    const { user } = await makeUser({ email, emailVerified: true });

    // When: durable user-link write fails after the pilot blob has been written.
    blobJsonControl.failUserWrite = true;
    const res = await createPilotForUser(user, email);
    blobJsonControl.failUserWrite = false;

    // Then: the reservation is released and the private pilot blob is removed.
    expect(res.status).toBe(500);
    expect(
      (await readPrivateJson<Record<string, string>>("pilot-email-index.json"))?.[
        email.toLowerCase()
      ],
    ).toBeUndefined();
    expect(await listPrivatePilotBlobNames()).toEqual([]);
  });

  it("creates a pilot, links the user, publishes the summary, and claims the email", async () => {
    // Given: a verified user with no pilot profile.
    const email = `create-${randomUUID()}@example.com`;
    const { user } = await makeUser({ email, emailVerified: true });

    // When: the user creates their own pilot profile.
    const res = await createPilotForUser(user, email);

    // Then: private, public, user-link, and email-index state all agree.
    expect(res.status).toBe(201);
    const pilot = res.jsonBody as Pilot;
    expect((await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`))?.id).toBe(pilot.id);

    const linkedUser = await readPrivateJson<User>(`users/${user.id}.json`);
    expect(linkedUser?.pilotId).toBe(pilot.id);
    expect(linkedUser?.roles).toContain("Pilot");

    const publicPilots = await readPublicJson<PilotSummary[]>("pilots.json");
    expect(publicPilots?.some((entry) => entry.id === pilot.id)).toBe(true);

    const emailIndex = await readPrivateJson<Record<string, string>>("pilot-email-index.json");
    expect(emailIndex?.[email.toLowerCase()]).toBe(pilot.id);
  });
});
