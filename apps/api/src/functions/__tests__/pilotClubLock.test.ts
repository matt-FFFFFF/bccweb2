import { describe, expect, test } from "vitest";
import type { Pilot, SeasonSummary } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makePilot,
  makeUser,
  readPrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../pilots.js";

const ctx = { log: () => undefined } as never;
const ACTIVE_YEAR = 2025;

async function invokePut(
  userId: string,
  email: string,
  pilotId: string,
  body: Record<string, unknown>
) {
  const entry = getRegisteredHandler("updatePilot");
  if (!entry) throw new Error("updatePilot not registered");
  const req = makeAuthRequest(userId, email, {
    method: "PUT",
    params: { id: pilotId },
    body,
  });
  return (await entry.handler(req as never, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

async function seedActiveSeason() {
  const seasons: SeasonSummary[] = [
    { id: "season-active", year: ACTIVE_YEAR, active: true },
  ];
  await writePublicJson("seasons.json", seasons);
}

async function makeLinkedPilotWithSeasonClub() {
  await seedActiveSeason();
  const pilot = await makePilot({});
  pilot.seasonClubs = [
    {
      seasonYear: ACTIVE_YEAR,
      clubId: "club-original",
      clubName: "Original Club",
    },
  ];
  pilot.currentClub = { id: "club-original", name: "Original Club" };
  pilot.userId = "will-be-overwritten";
  const { writePrivateJson } = await import(
    "../../__tests__/helpers/seed.js"
  );
  await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
  return pilot;
}

describe("PUT /api/pilots/{id} — currentClub lock", () => {
  test("self-pilot CANNOT change club when they have a seasonClubs entry for the active year", async () => {
    const pilot = await makeLinkedPilotWithSeasonClub();
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("CLUB_LOCKED");

    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-original");
  });

  test("Admin CAN change club despite the seasonClubs lock", async () => {
    const pilot = await makeLinkedPilotWithSeasonClub();
    const { user: admin } = await makeUser({
      roles: ["Admin"],
      emailVerified: true,
    });

    const res = await invokePut(admin.id, admin.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-new");
  });

  test("self-pilot can submit a no-op club (same id) even when locked", async () => {
    const pilot = await makeLinkedPilotWithSeasonClub();
    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-original", name: "Original Club" },
      helmetColour: "blue",
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.helmetColour).toBe("blue");
  });

  test("self-pilot CAN change club when there is no seasonClubs entry for the active year", async () => {
    await seedActiveSeason();
    const pilot = await makePilot({});
    pilot.currentClub = { id: "club-original", name: "Original Club" };
    const { writePrivateJson } = await import(
      "../../__tests__/helpers/seed.js"
    );
    await writePrivateJson(`pilots/${pilot.id}.json`, pilot);

    const { user } = await makeUser({
      roles: ["Pilot"],
      pilotId: pilot.id,
      emailVerified: true,
    });

    const res = await invokePut(user.id, user.email, pilot.id, {
      currentClub: { id: "club-new", name: "New Club" },
    });

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`);
    expect(stored?.currentClub?.id).toBe("club-new");
  });
});
