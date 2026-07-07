// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Flight, Round } from "@bccweb/types";
import { invoke, makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";

import "../manualFlight.js";

interface RoundCtx {
  roundId: string;
  teamId: string;
  place: number;
  pilotId: string;
  organisingClubId: string;
}

async function seedRound(
  overrides: {
    status?: Round["status"];
    igcPath?: string;
    organisingClubId?: string;
  } = {},
): Promise<RoundCtx> {
  const roundId = randomUUID();
  const teamId = randomUUID();
  const pilotId = randomUUID();
  const organisingClubId = overrides.organisingClubId ?? randomUUID();
  const status = overrides.status ?? "Locked";

  const flight: Flight | null = overrides.igcPath
    ? {
        id: randomUUID(),
        distance: 42,
        scoringType: "XC",
        score: 10,
        wingFactor: 0.9,
        isManualLog: false,
        igcPath: overrides.igcPath,
        sanityFlags: [],
      }
    : null;

  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status,
    isLocked: status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: organisingClubId, name: "Test Club" },
    season: { year: 2026 },
    teams: [
      {
        id: teamId,
        teamName: "A",
        club: { id: randomUUID(), name: "Test Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId,
            snapshot: null,
            flight,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  return { roundId, teamId, place: 1, pilotId, organisingClubId };
}

function post(ctx: RoundCtx, userId: string, email: string, body: unknown) {
  return invoke(
    "recordManualFlight",
    makeAuthRequest(userId, email, {
      method: "POST",
      params: { id: ctx.roundId, teamId: ctx.teamId, place: String(ctx.place) },
      body,
    }),
  );
}

const VALID_JUSTIFICATION = "GPS track lost; distance measured from the OS map.";

describe("recordManualFlight endpoint", () => {
  it("unauthenticated -> 401", async () => {
    const ctx = await seedRound();
    const res = await invoke(
      "recordManualFlight",
      makeRequest({
        method: "POST",
        params: { id: ctx.roundId, teamId: ctx.teamId, place: "1" },
        body: { distance: 50, manualLogJustification: VALID_JUSTIFICATION },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("pilot role -> 403 (manual entry is operator-only)", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: ctx.pilotId });

    const res = await post(ctx, user.id, user.email, {
      distance: 50,
      manualLogJustification: VALID_JUSTIFICATION,
    });

    expect(res.status).toBe(403);
  });

  it("round not Locked -> 409 ROUND_NOT_LOCKED", async () => {
    const ctx = await seedRound({ status: "BriefComplete" });
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(ctx, user.id, user.email, {
      distance: 50,
      manualLogJustification: VALID_JUSTIFICATION,
    });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_NOT_LOCKED");
  });

  it("distance <= 0 -> 400 BAD_REQUEST", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(ctx, user.id, user.email, {
      distance: 0,
      manualLogJustification: VALID_JUSTIFICATION,
    });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("distance > 10000 -> 400 BAD_REQUEST", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(ctx, user.id, user.email, {
      distance: 10001,
      manualLogJustification: VALID_JUSTIFICATION,
    });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("empty manualLogJustification -> 422 VALIDATION_ERROR", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(ctx, user.id, user.email, {
      distance: 50,
      manualLogJustification: "   ",
    });

    expect(res.status).toBe(422);
    expect((res.jsonBody as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("admin records manual flight -> 200 (Manual, isManualLog, justification stored)", async () => {
    const ctx = await seedRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(ctx, user.id, user.email, {
      distance: 123.4,
      manualLogJustification: VALID_JUSTIFICATION,
      url: "https://example.com/flight",
      duration: 95,
      dateTime: "2026-06-09T12:00:00.000Z",
    });

    expect(res.status).toBe(200);
    const flight = res.jsonBody as Flight;
    expect(flight.scoringType).toBe("Manual");
    expect(flight.isManualLog).toBe(true);
    expect(flight.distance).toBe(123.4);
    expect(flight.manualLogJustification).toBe(VALID_JUSTIFICATION);
    expect(flight.score).toBe(0);
    expect(flight.wingFactor).toBe(0);
    expect(flight.duration).toBe(95);
    expect(flight.url).toBe("https://example.com/flight");

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    const stored = round?.teams[0].pilots[0].flight;
    expect(stored?.scoringType).toBe("Manual");
    expect(stored?.isManualLog).toBe(true);
    expect(stored?.manualLogJustification).toBe(VALID_JUSTIFICATION);
  });

  it("manual entry supersedes IGC: clears igcPath and deletes the .igc blob", async () => {
    const igcPath = `flight-igcs/${randomUUID()}/${randomUUID()}.igc`;
    const ctx = await seedRound({ igcPath });
    await writePrivateJson(igcPath, { note: "pretend-igc" });
    expect(await privateBlobExists(igcPath)).toBe(true);

    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await post(ctx, user.id, user.email, {
      distance: 77,
      manualLogJustification: "Manual override of the previously IGC-scored flight.",
    });

    expect(res.status).toBe(200);
    expect((res.jsonBody as Flight).igcPath).toBeUndefined();

    // The superseded track blob must be gone.
    expect(await privateBlobExists(igcPath)).toBe(false);

    // The stored slot no longer references the IGC path.
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].flight?.igcPath).toBeUndefined();
    expect(round?.teams[0].pilots[0].flight?.scoringType).toBe("Manual");
  });
});
