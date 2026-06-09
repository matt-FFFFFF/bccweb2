import { describe, expect, test, beforeEach } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, makePilot, writePrivateJson, readPrivateJson } from "../../__tests__/helpers/seed.js";
import type { PilotSeasonClub, Pilot } from "@bccweb/types";
import "../pilotSeasonClubs.js"; // register handlers

describe("pilotSeasonClubs API", () => {
  test("admin lists assignments -> 200 + array", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await writePrivateJson("seasons/2026/pilot-club-map.json", {
      "pilot-1": "club-a",
      "pilot-2": "club-b",
    });

    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { year: "2026" },
    });
    
    const res = await invoke("getPilotSeasonClubs", req);
    expect(res.status).toBe(200);
    const body = res.jsonBody as any[];
    expect(body).toEqual([
      { pilotId: "pilot-1", clubId: "club-a", seasonYear: 2026 },
      { pilotId: "pilot-2", clubId: "club-b", seasonYear: 2026 },
    ]);
  });

  test("admin assigns pilot to registered club -> 201; pilot.seasonClubs updated; denorm map updated", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-1" });
    await writePrivateJson("clubs/club-a.json", { id: "club-a", name: "Club A" });
    await writePrivateJson("season-clubs/2026/club-a.json", { id: "sc-a", seasonYear: 2026, clubId: "club-a" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-1", clubId: "club-a", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
    
    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-1.json");
    expect(updatedPilot!.seasonClubs).toEqual([{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }]);
    
    const map = await readPrivateJson<Record<string, string>>("seasons/2026/pilot-club-map.json");
    expect(map!["pilot-1"]).toBe("club-a");
  });

  test("assign to non-registered (year,club) -> 409", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await makePilot({ id: "pilot-not-reg" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-not-reg", clubId: "club-never-registered", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(409);
    const body = res.jsonBody as any;
    expect(body.code).toBe("CLUB_NOT_REGISTERED_FOR_SEASON");
  });

  test("assign duplicate (year, pilot) -> 409", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-dup-1" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }];
    await writePrivateJson("pilots/pilot-dup-1.json", pilot);
    await writePrivateJson("season-clubs/2026/club-b.json", { id: "sc-b", seasonYear: 2026, clubId: "club-b" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-dup-1", clubId: "club-b", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(409);
    const body = res.jsonBody as any;
    expect(body.code).toBe("PILOT_ALREADY_ASSIGNED");
  });

  test("assign duplicate with reassign flag -> 201", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-reassign" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }];
    await writePrivateJson("pilots/pilot-reassign.json", pilot);
    await writePrivateJson("clubs/club-c.json", { id: "club-c", name: "Club C" });
    await writePrivateJson("season-clubs/2026/club-c.json", { id: "sc-c", seasonYear: 2026, clubId: "club-c" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      query: { reassign: "true" },
      body: { pilotId: "pilot-reassign", clubId: "club-c", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
    
    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-reassign.json");
    expect(updatedPilot!.seasonClubs).toEqual([{ seasonYear: 2026, clubId: "club-c", clubName: "Club C" }]);
  });

  test("RoundsCoord assigns within own club -> 201", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "club-coord-a" });
    await makePilot({ id: "pilot-coord-1" });
    await writePrivateJson("clubs/club-coord-a.json", { id: "club-coord-a", name: "Club Coord A" });
    await writePrivateJson("season-clubs/2026/club-coord-a.json", { id: "sc-coord-a", seasonYear: 2026, clubId: "club-coord-a" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-coord-1", clubId: "club-coord-a", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
  });

  test("RoundsCoord assigns to DIFFERENT club -> 403", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "club-coord-a" });
    
    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-coord-2", clubId: "club-coord-b", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(403);
  });

  test("DELETE removes from both pilot.seasonClubs and denorm map", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-delete" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-delete", clubName: "Club D" }];
    await writePrivateJson("pilots/pilot-delete.json", pilot);
    await writePrivateJson("seasons/2026/pilot-club-map.json", { "pilot-delete": "club-delete", "pilot-delete-2": "club-b" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { pilotId: "pilot-delete", seasonYear: "2026" },
    });

    const res = await invoke("deletePilotSeasonClub", req);
    expect(res.status).toBe(204);

    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-delete.json");
    expect(updatedPilot!.seasonClubs).toEqual([]);

    const map = await readPrivateJson<Record<string, string>>("seasons/2026/pilot-club-map.json");
    expect(map!["pilot-delete"]).toBeUndefined();
    expect(map!["pilot-delete-2"]).toBe("club-b");
  });
});
