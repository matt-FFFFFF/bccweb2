// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import type { Config } from "@bccweb/types";
import { ConfigSchema } from "@bccweb/schemas";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../admin.js";

const ctx = { log: () => undefined } as never;

async function callGetConfig(userId: string, email: string) {
  const entry = getRegisteredHandler("getConfig");
  if (!entry) throw new Error("getConfig not registered");
  const req = makeAuthRequest(userId, email, { method: "GET" });
  return (await entry.handler(req, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

describe("GET /api/manage/config — schema heal & defaults", () => {
  test("virgin store: returns full defaults AND persists config.json", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    // Sanity: virgin store has no config.json. (makeUser does not touch it.)
    // We can't assert pre-state across suites cleanly, so just exercise the
    // contract on the response + persisted blob.
    const res = await callGetConfig(user.id, user.email);

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBe(2);
    expect(cfg.maxPilotsInTeam).toBe(9);
    expect(cfg.maxScoringPilotsInTeam).toBe(6);
    expect(cfg.maxPilotScoresCountedPerTeam).toBe(4);
    expect(cfg.leagueRoundScoresCounted).toBe(6);
    expect(cfg.flightDateValidationEnabled).toBe(true);
    expect(cfg.taskMaxPoints).toBe(1000);
    expect(cfg.wingFactors["EN A"]).toBe(1.0);
    expect(cfg.wingFactors["EN B"]).toBe(0.9);
    expect(cfg.wingFactors["EN C"]).toBe(0.8);
    expect(cfg.wingFactors["EN C 2-liner"]).toBe(0.7);
    expect(cfg.wingFactors["EN D"]).toBe(0.6);
    expect(cfg.wingFactors["EN D 2-liner"]).toBe(0.5);
    expect(cfg.pilotFactors).toEqual({
      "Club Pilot": 1,
      Pilot: 1,
      "Advanced Pilot": 0.9,
    });
    expect(cfg.clubsAttendingFactors).toEqual({
      fewerThanThreeClubs: 0.5,
      exactlyThreeClubs: 0.75,
      moreThanThreeClubs: 1,
    });
    expect(cfg.minDistanceFactors).toEqual({
      oneFlight: 0.2,
      twoFlights: 0.4,
      threeFlights: 0.6,
      fourFlights: 0.8,
      fiveOrMoreFlights: 1,
    });

    // On 404, getConfig persists defaults so the next reader sees them.
    expect(await privateBlobExists("config.json")).toBe(true);
    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted).toEqual(cfg);
  });

  test("partial blob (missing wingFactors): response heals via ConfigSchema defaults", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    await writePrivateJson("config.json", {
      maxTeamsInClub: 4,
      maxPilotsInTeam: 8,
      maxScoringPilotsInTeam: 5,
      flightDateValidationEnabled: false,
    });

    const res = await callGetConfig(user.id, user.email);

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBe(4);
    expect(cfg.flightDateValidationEnabled).toBe(false);
    // ConfigSchema fills wingFactors with defaults when absent.
    expect(cfg.wingFactors["EN A"]).toBe(1.0);
    expect(cfg.wingFactors["EN D 2-liner"]).toBe(0.5);
  });

  test("partial wingFactors: schema fills missing keys, keeps present ones", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    await writePrivateJson("config.json", {
      maxTeamsInClub: 2,
      maxPilotsInTeam: 12,
      maxScoringPilotsInTeam: 6,
      flightDateValidationEnabled: true,
      wingFactors: { "EN A": 1.42 },
    });

    const res = await callGetConfig(user.id, user.email);

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.wingFactors["EN A"]).toBe(1.42);
    expect(cfg.wingFactors["EN B"]).toBe(0.9);
    expect(cfg.wingFactors["EN D 2-liner"]).toBe(0.5);
  });

  test("fully-valid blob: response matches stored exactly", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    // Spread schema defaults first so every W1 field is present: a partial
    // literal would heal on read and the "matches stored exactly" assertion
    // (the whole point of this case) would fail on the injected keys.
    const fullCfg: Config = {
      ...ConfigSchema.parse({}),
      maxTeamsInClub: 5,
      maxPilotsInTeam: 10,
      maxScoringPilotsInTeam: 4,
      flightDateValidationEnabled: true,
      wingFactors: {
        "EN A": 1.1,
        "EN B": 1.0,
        "EN C": 0.95,
        "EN C 2-liner": 0.9,
        "EN D": 0.85,
        "EN D 2-liner": 0.8,
      },
    };
    await writePrivateJson("config.json", fullCfg);

    const res = await callGetConfig(user.id, user.email);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(fullCfg);

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted).toEqual(fullCfg);
  });
});
