import type { Pilot } from "@bccweb/types";
import { describe, expect, test } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { getPublicContainer } from "../../__tests__/helpers/azurite.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../pilots.js";

const ctx = { log: () => undefined } as never;

async function invokeCreatePilot(
  req: ReturnType<typeof makeAuthRequest>
): Promise<{ status: number; jsonBody?: unknown }> {
  const entry = getRegisteredHandler("createPilot");
  if (!entry) throw new Error("createPilot not registered");
  return (await entry.handler(req, ctx)) as { status: number; jsonBody?: unknown };
}

async function invokeUpdatePilot(
  req: ReturnType<typeof makeAuthRequest>
): Promise<{ status: number; jsonBody?: unknown }> {
  const entry = getRegisteredHandler("updatePilot");
  if (!entry) throw new Error("updatePilot not registered");
  return (await entry.handler(req, ctx)) as { status: number; jsonBody?: unknown };
}

async function createPilotWith(
  wingManufacturer?: { id: string; name: string }
): Promise<{ pilot: Pilot; userId: string; userEmail: string }> {
  const { user } = await makeUser({ roles: ["Admin"] });
  const res = await invokeCreatePilot(
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: {
        firstName: "Wing",
        lastName: "Owner",
        ...(wingManufacturer ? { wingManufacturer } : {}),
      },
    })
  );
  if (res.status !== 201) {
    throw new Error(`createPilot setup failed: ${res.status} ${JSON.stringify(res.jsonBody)}`);
  }
  return { pilot: res.jsonBody as Pilot, userId: user.id, userEmail: user.email };
}

describe("pilot wingManufacturer canonicalisation — createPilot", () => {
  test("canonicalises a valid id, replacing the client-sent name and adding websiteUrl", async () => {
    await writePublicJson("manufacturers.json", [
      { id: "X", name: "Ozone", websiteUrl: "https://ozone.com" },
    ]);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invokeCreatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Cano",
          lastName: "Nical",
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
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invokeCreatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Bad",
          lastName: "Wing",
          wingManufacturer: { id: "ghost-create-9271", name: "Nope" },
        },
      })
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MANUFACTURER_NOT_FOUND");
    expect(JSON.stringify(res.jsonBody)).not.toContain("ghost-create-9271");
  });

  test("treats a missing manufacturers.json as an empty list (400, not 500)", async () => {
    await getPublicContainer().getBlockBlobClient("manufacturers.json").deleteIfExists();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invokeCreatePilot(
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
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { pilot } = await createPilotWith();
    expect(pilot.wingManufacturer).toBeUndefined();
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.wingManufacturer).toBeUndefined();
  });
});

describe("pilot wingManufacturer canonicalisation — updatePilot", () => {
  test("canonicalises a newly-set manufacturer, replacing the client-sent name", async () => {
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { pilot, userId, userEmail } = await createPilotWith();
    expect(pilot.wingManufacturer).toBeUndefined();

    const res = await invokeUpdatePilot(
      makeAuthRequest(userId, userEmail, {
        method: "PUT",
        params: { id: pilot.id },
        body: { wingManufacturer: { id: "X", name: "stale" } },
      })
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Pilot).wingManufacturer).toEqual({ id: "X", name: "Ozone" });
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.wingManufacturer).toEqual({ id: "X", name: "Ozone" });
  });

  test("preserves the existing manufacturer when the body omits it", async () => {
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { pilot, userId, userEmail } = await createPilotWith({ id: "X", name: "stale" });
    expect(pilot.wingManufacturer).toEqual({ id: "X", name: "Ozone" });

    const res = await invokeUpdatePilot(
      makeAuthRequest(userId, userEmail, {
        method: "PUT",
        params: { id: pilot.id },
        body: { firstName: "Renamed", lastName: "Pilot" },
      })
    );

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.wingManufacturer).toEqual({ id: "X", name: "Ozone" });
  });

  test("leaves an existing-but-deleted manufacturer untouched (same id → no lookup, no error)", async () => {
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { pilot, userId, userEmail } = await createPilotWith({ id: "X", name: "stale" });
    expect(pilot.wingManufacturer).toEqual({ id: "X", name: "Ozone" });

    // Admin deletes every manufacturer — the reference list is now empty.
    await writePublicJson("manufacturers.json", []);

    const res = await invokeUpdatePilot(
      makeAuthRequest(userId, userEmail, {
        method: "PUT",
        params: { id: pilot.id },
        body: { wingManufacturer: { id: "X", name: "IGNORED" } },
      })
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Pilot).wingManufacturer).toEqual({ id: "X", name: "Ozone" });
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.wingManufacturer).toEqual({ id: "X", name: "Ozone" });
  });

  test("returns 400 MANUFACTURER_NOT_FOUND for a newly-set unknown id, leaks no id, leaves pilot unchanged", async () => {
    await writePublicJson("manufacturers.json", [{ id: "X", name: "Ozone" }]);
    const { pilot, userId, userEmail } = await createPilotWith();
    expect(pilot.wingManufacturer).toBeUndefined();

    const res = await invokeUpdatePilot(
      makeAuthRequest(userId, userEmail, {
        method: "PUT",
        params: { id: pilot.id },
        body: { wingManufacturer: { id: "ghost-update-5583", name: "Nope" } },
      })
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("MANUFACTURER_NOT_FOUND");
    expect(JSON.stringify(res.jsonBody)).not.toContain("ghost-update-5583");
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.wingManufacturer).toBeUndefined();
  });
});
