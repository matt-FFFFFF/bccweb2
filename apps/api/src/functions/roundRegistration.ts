// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { RoundSchema } from "@bccweb/schemas";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { withPrivateLeaseRetry } from "../lib/blob.js";
import { writePrivateJson } from "../lib/blobJson.js";
import { trustedClientIp } from "../lib/clientIp.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { pilotClubIdForSeason, ensureSeasonClubRecorded } from "../lib/pilotClub.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  ensureNotDoubleBooked,
  readRegistrationConfig,
  readRegistrationPilot,
  readRegistrationRound,
} from "./roundRegistrationData.js";
import {
  buildPilotSnapshot,
  choosePlace,
  ensureProfileComplete,
  ensureRegistrationOpen,
  fillRegistrationSlot,
  getOrCreateRegistrationSlot,
  isPilotInRound,
  pickRegistrationTeam,
} from "./roundRegistrationRoster.js";
import { unregisterSelf } from "./roundUnregistration.js";

export { choosePlace } from "./roundRegistrationRoster.js";

type RegisterSelfBody = {
  readonly teamId?: unknown;
};

async function registerSelf(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Pilot") || !caller.pilotId) {
    throw new HttpError(403, "NOT_A_PILOT");
  }

  rateLimit(req, {
    endpoint: "round-register",
    capacity: 10,
    refillPerMin: 10,
    identityKey:
      caller.pilotId ?? `anon:${trustedClientIp(req) ?? "unknown"}`,
  });

  const roundId = req.params["roundId"];
  if (!roundId) {
    throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");
  }

  const body = await parseRegisterBody(req);
  const [round, config] = await Promise.all([
    readRegistrationRound(roundId),
    readRegistrationConfig(),
  ]);
  ensureRegistrationOpen(round, "REGISTRATION_CLOSED");

  const pilot = await readRegistrationPilot(caller.pilotId);
  ensureProfileComplete(pilot);

  const seasonYear = round.season.year;
  const pilotClubId = pilotClubIdForSeason(pilot, seasonYear);
  if (!pilotClubId) {
    throw new HttpError(
      409,
      "NO_CLUB_FOR_SEASON",
      "Set your club in your profile before registering."
    );
  }
  const candidateTeams = round.teams.filter(
    (team) => team.club.id === pilotClubId
  );
  if (candidateTeams.length === 0) {
    throw new HttpError(
      409,
      "NO_TEAM_FOR_CLUB",
      "Your club has no team in this round yet. Ask your club coordinator to register one."
    );
  }
  const chosenTeam = pickRegistrationTeam(candidateTeams, body.teamId);

  await ensureNotDoubleBooked(pilot.id, round);
  await ensureSeasonClubRecorded(
    pilot.id,
    seasonYear,
    pilotClubId,
    chosenTeam.club.name
  );
  const pilotSnapshot = buildPilotSnapshot(pilot);

  const registration = await withPrivateLeaseRetry(
    `rounds/${roundId}.json`,
    async (leaseId) => {
      const lockedRound = await readRegistrationRound(roundId);
      ensureRegistrationOpen(lockedRound, "REGISTRATION_CLOSED");
      if (isPilotInRound(lockedRound, pilot.id)) {
        throw new HttpError(
          409,
          "DOUBLE_BOOKING",
          `Pilot is already registered in this round ${lockedRound.id}`
        );
      }
      const lockedTeam = lockedRound.teams.find(
        (team) => team.id === chosenTeam.id
      );
      if (!lockedTeam) {
        throw new HttpError(404, "TEAM_NOT_FOUND", "Team not found");
      }
      const place = choosePlace(
        lockedTeam,
        undefined,
        config.maxPilotsInTeam
      );
      const slot = getOrCreateRegistrationSlot(
        lockedTeam,
        place,
        config.maxScoringPilotsInTeam
      );
      fillRegistrationSlot(slot, pilot.id, pilotSnapshot);
      await writePrivateJson(
        `rounds/${roundId}.json`,
        RoundSchema,
        lockedRound,
        leaseId
      );
      return { teamId: lockedTeam.id, place };
    }
  );

  return {
    status: 200,
    jsonBody: {
      roundId,
      teamId: registration.teamId,
      place: registration.place,
      pilotSnapshot,
    },
  };
}

async function parseRegisterBody(
  req: HttpRequest
): Promise<{ readonly teamId?: string }> {
  let body: RegisterSelfBody;
  try {
    body = (await req.json()) as RegisterSelfBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }
  const teamId = typeof body.teamId === "string" ? body.teamId.trim() : "";
  return teamId ? { teamId } : {};
}

app.http("registerSelfForRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/register-self",
  handler: withErrorHandler(registerSelf),
});

app.http("unregisterSelfFromRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/unregister-self",
  handler: withErrorHandler(unregisterSelf),
});
