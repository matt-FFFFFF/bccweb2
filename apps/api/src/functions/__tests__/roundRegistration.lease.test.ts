// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Pilot, Round } from "@bccweb/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeConfig,
  makePilot,
  makeRound,
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  failRoundLeaseOnce,
  makeTeam,
  register,
  seedRegistrationRound,
  trackRoundLeaseAttempts,
} from "./roundRegistration.testHelpers.js";
import "../roundRegistration.js";

describe("round self-registration lease handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([409, 412])(
    "raw lease acquisition %i is retried server-side",
    async (statusCode) => {
      const ctx = await seedRegistrationRound();
      const roundPath = `rounds/${ctx.round.id}.json`;
      const leaseFailure = failRoundLeaseOnce(roundPath, statusCode);
      const res = await register(ctx);
      expect(res.status).toBe(200);
      expect(leaseFailure.roundAttempts()).toBe(2);
      const saved = await readPrivateJson<Round>(roundPath);
      expect(saved?.teams[0].pilots[0]?.pilotId).toBe(ctx.pilot.id);
    }
  );

  it("raw non-lease acquisition error is not retried", async () => {
    const ctx = await seedRegistrationRound();
    const roundPath = `rounds/${ctx.round.id}.json`;
    const leaseFailure = failRoundLeaseOnce(roundPath, 500);
    const res = await register(ctx);
    expect(res.status).toBe(500);
    expect(leaseFailure.roundAttempts()).toBe(1);
  });

  it("leased DOUBLE_BOOKING remains the original business conflict without retry", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });
    const roundPath = `rounds/${ctx.round.id}.json`;
    const roundAttempts = trackRoundLeaseAttempts(roundPath);
    const res = await register(ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("DOUBLE_BOOKING");
    expect(roundAttempts()).toBe(1);
  });

  it("25 distinct pilots register concurrently exactly once", async () => {
    resetAllBuckets();
    const clubId = randomUUID();
    await makeConfig({ maxPilotsInTeam: 25 });
    const team = makeTeam(clubId, "Concurrent Team");
    const round = await makeRound({
      date: "2026-08-20",
      status: "Confirmed",
      seasonYear: 2026,
      organisingClubId: clubId,
      organisingClubName: "Test Club",
      teams: [team],
    });
    const registrations: Array<{
      pilot: Pilot;
      userId: string;
      email: string;
    }> = [];
    for (let index = 0; index < 25; index += 1) {
      const pilot = await makePilot({
        firstName: `Pilot${index}`,
        lastName: "Concurrent",
        clubId,
      });
      pilot.seasonClubs = [
        { seasonYear: 2026, clubId, clubName: "Test Club" },
      ];
      await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
      resetAllBuckets();
      const { user } = await makeUser({
        roles: ["Pilot"],
        pilotId: pilot.id,
        clubId,
      });
      registrations.push({ pilot, userId: user.id, email: user.email });
    }
    resetAllBuckets();
    const responses = await Promise.all(
      registrations.map(({ userId, email }) =>
        invoke(
          "registerSelfForRound",
          makeAuthRequest(userId, email, {
            method: "POST",
            params: { roundId: round.id },
            body: { teamId: team.id },
            headers: { "x-forwarded-for": `${randomUUID()}.test` },
          })
        )
      )
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(25).fill(200)
    );
    const saved = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    const filledSlots =
      saved?.teams[0].pilots.filter((slot) => slot.status === "Filled") ?? [];
    const pilotIds = registrations.map(({ pilot }) => pilot.id);
    expect(filledSlots.map((slot) => slot.pilotId).toSorted()).toEqual(
      pilotIds.toSorted()
    );
    expect(new Set(filledSlots.map((slot) => slot.pilotId))).toHaveLength(25);
    expect(new Set(filledSlots.map((slot) => slot.placeInTeam))).toHaveLength(25);
  }, 15_000);
});
