import { describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import type { Pilot, User, PilotSummary, PilotEmailIndex } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../meProfile.js";

const ctx = { log: () => undefined } as never;

async function invoke(req: ReturnType<typeof makeAuthRequest>) {
  const entry = getRegisteredHandler("createMyPilot");
  if (!entry) throw new Error("createMyPilot not registered");
  return (await entry.handler(req, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

describe("POST /api/me/pilot", () => {
  test("creates pilot, links user, sets Pilot role, updates indexes", async () => {
    await writePublicJson("pilots.json", []);
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Alice",
          lastName: "Airborne",
          phoneNumber: "+44 7000 000000",
          currentClub: { id: "club-1", name: "Test Club" },
        },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe(user.id);
    expect(created.person.fullName).toBe("Alice Airborne");
    expect(created.currentClub?.id).toBe("club-1");

    const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
    expect(stored?.id).toBe(created.id);

    const updatedUser = await readPrivateJson<User>(`users/${user.id}.json`);
    expect(updatedUser?.pilotId).toBe(created.id);
    expect(updatedUser?.roles).toContain("Pilot");
    expect(updatedUser?.clubId).toBe("club-1");

    const index = await readPublicJson<PilotSummary[]>("pilots.json");
    expect(index?.some((p) => p.id === created.id)).toBe(true);

    const emailIndex = await readPrivateJson<PilotEmailIndex>(
      "pilot-email-index.json"
    );
    expect(emailIndex?.[user.email.toLowerCase()]).toBe(created.id);
  });

  test("returns 409 when user is already linked to a pilot", async () => {
    const existingPilotId = randomUUID();
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: existingPilotId,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Bob", lastName: "Builder" },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("ALREADY_LINKED");
  });

  test("returns 403 when email is not verified", async () => {
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: false,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Carol", lastName: "Cumulus" },
      })
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("returns 400 when firstName or lastName missing", async () => {
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "  " },
      })
    );

    expect(res.status).toBe(400);
  });
});
