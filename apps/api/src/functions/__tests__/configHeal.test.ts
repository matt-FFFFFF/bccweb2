import { describe, expect, test } from "vitest";
import type { Config } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../admin.js";

const ctx = { log: () => undefined } as never;

async function callGetConfig(userId: string, email: string) {
  const entry = getRegisteredHandler("getConfig");
  if (!entry) throw new Error("getConfig not registered");
  const req = makeAuthRequest(userId, email, { method: "GET" });
  return (await entry.handler(req as never, ctx)) as {
    status: number;
    jsonBody?: unknown;
  };
}

describe("GET /api/manage/config — heal partial blobs", () => {
  test("returns full defaults when blob is missing (no write)", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await callGetConfig(user.id, user.email);

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.wingFactors["EN A"]).toBeTypeOf("number");
    expect(cfg.maxTeamsInClub).toBeTypeOf("number");
    expect(cfg.flightDateValidationEnabled).toBeTypeOf("boolean");
  });

  test("heals a blob missing wingFactors and persists the repair", async () => {
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
    expect(cfg.wingFactors).toBeTruthy();
    expect(cfg.wingFactors["EN A"]).toBeTypeOf("number");
    expect(cfg.maxTeamsInClub).toBe(4);
    expect(cfg.flightDateValidationEnabled).toBe(false);

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted?.wingFactors["EN A"]).toBeTypeOf("number");
    expect(persisted?.maxTeamsInClub).toBe(4);
  });

  test("fills missing wing factor entries while keeping the present ones", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    await writePrivateJson("config.json", {
      maxTeamsInClub: 2,
      maxPilotsInTeam: 12,
      maxScoringPilotsInTeam: 6,
      flightDateValidationEnabled: true,
      wingFactors: { "EN A": 1.42 },
    });

    const res = await callGetConfig(user.id, user.email);

    const cfg = (res.jsonBody as Config);
    expect(cfg.wingFactors["EN A"]).toBe(1.42);
    expect(cfg.wingFactors["EN B"]).toBeTypeOf("number");
    expect(cfg.wingFactors["EN D 2-liner"]).toBeTypeOf("number");

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted?.wingFactors["EN A"]).toBe(1.42);
    expect(persisted?.wingFactors["EN B"]).toBeTypeOf("number");
  });

  test("does NOT rewrite a fully-valid blob", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });
    const fullCfg: Config = {
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

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted).toEqual(fullCfg);
  });
});
