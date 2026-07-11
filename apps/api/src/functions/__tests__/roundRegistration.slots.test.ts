// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round } from "@bccweb/types";
import { describe, expect, it } from "vitest";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { readPrivateJson } from "../../__tests__/helpers/seed.js";
import {
  register,
  seedRegistrationRound,
} from "./roundRegistration.testHelpers.js";
import "../roundRegistration.js";

describe("round self-registration slot policy", () => {
  it("self-registration into a place within the scoring band -> isScoring true", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5].map((placeInTeam) => ({
        placeInTeam,
        pilotId: randomUUID(),
      })),
    });
    const res = await register(ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(6);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(
      round?.teams[0].pilots.find((slot) => slot.placeInTeam === 6)?.isScoring
    ).toBe(true);
  });

  it("self-registration into a place beyond the scoring band -> isScoring false", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5, 6].map((placeInTeam) => ({
        placeInTeam,
        pilotId: randomUUID(),
      })),
    });
    const res = await register(ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(7);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(
      round?.teams[0].pilots.find((slot) => slot.placeInTeam === 7)?.isScoring
    ).toBe(false);
  });

  it("missing config falls back to legacy schema defaults so place 7 is free and non-scoring", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [1, 2, 3, 4, 5, 6].map((placeInTeam) => ({
        placeInTeam,
        pilotId: randomUUID(),
      })),
    });
    await getPrivateContainer()
      .getBlockBlobClient("config.json")
      .deleteIfExists();
    const res = await register(ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { place: number }).place).toBe(7);
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(
      round?.teams[0].pilots.find((slot) => slot.placeInTeam === 7)?.isScoring
    ).toBe(false);
  });

  it("a tenth self-registration into a full 9-place team -> 409 TEAM_FULL", async () => {
    const ctx = await seedRegistrationRound({
      maxPilotsInTeam: 9,
      teamSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((placeInTeam) => ({
        placeInTeam,
        pilotId: randomUUID(),
      })),
    });
    const res = await register(ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("TEAM_FULL");
  });
});
