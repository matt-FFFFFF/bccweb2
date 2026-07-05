import { describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import type { Pilot, User, PilotSummary, PilotEmailIndex } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
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

  test("returns 409 PILOT_EMAIL_TAKEN when caller email is claimed by another pilot", async () => {
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });
    await writePrivateJson<PilotEmailIndex>("pilot-email-index.json", {
      [user.email.toLowerCase()]: randomUUID(),
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Daisy", lastName: "Downwind" },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
  });

  test("creates pilot when caller email is unclaimed", async () => {
    await writePublicJson("pilots.json", []);
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Erin", lastName: "Elevator" },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;
    const emailIndex = await readPrivateJson<PilotEmailIndex>(
      "pilot-email-index.json"
    );
    expect(emailIndex?.[user.email.toLowerCase()]).toBe(created.id);
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

describe("POST /api/me/pilot — wingManufacturer canonicalisation", () => {
  test("canonicalises a valid wingManufacturer id, replacing the client-sent name", async () => {
    await writePublicJson("pilots.json", []);
    await writePublicJson("manufacturers.json", [
      { id: "X", name: "Ozone", websiteUrl: "https://ozone.com" },
    ]);
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Self",
          lastName: "Wing",
          wingManufacturer: { id: "X", name: "stale" },
        },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;
    expect(created.wingManufacturer).toEqual({
      id: "X",
      name: "Ozone",
      websiteUrl: "https://ozone.com",
    });
    const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
    expect(stored?.wingManufacturer).toEqual({
      id: "X",
      name: "Ozone",
      websiteUrl: "https://ozone.com",
    });
  });

  test("returns 400 MANUFACTURER_NOT_FOUND for an unknown id and leaks no id value", async () => {
    await writePublicJson("pilots.json", []);
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Bad",
          lastName: "Self",
          wingManufacturer: { id: "ghost-me-4419", name: "Nope" },
        },
      })
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MANUFACTURER_NOT_FOUND");
    expect(JSON.stringify(res.jsonBody)).not.toContain("ghost-me-4419");
  });

  test("treats a missing manufacturers.json as an empty list (400, not 500)", async () => {
    await writePublicJson("pilots.json", []);
    await getPublicContainer().getBlockBlobClient("manufacturers.json").deleteIfExists();
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "No",
          lastName: "List",
          wingManufacturer: { id: "X", name: "Ozone" },
        },
      })
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MANUFACTURER_NOT_FOUND");
  });

  test("stores no wingManufacturer when the body omits it", async () => {
    await writePublicJson("pilots.json", []);
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { user } = await makeUser({
      roles: [],
      pilotId: null,
      emailVerified: true,
    });

    const res = await invoke(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Plain", lastName: "Self" },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Pilot;
    expect(created.wingManufacturer).toBeUndefined();
    const stored = await readPrivateJson<Pilot>(`pilots/${created.id}.json`);
    expect(stored?.wingManufacturer).toBeUndefined();
  });
});
