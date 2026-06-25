import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Config, Pilot, PilotSnapshot, PilotSlot, Round, RoundSummary, Team } from "@bccweb/types";
import {
  ConfigSchema,
  PilotSchema,
  RoundSchema,
  RoundSummarySchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getPrivateBlobClient,
  withPrivateLease,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, BlobShapeError, withErrorHandler } from "../lib/http.js";
import { rateLimit } from "../lib/rateLimit.js";
import { trustedClientIp } from "../lib/clientIp.js";
import { getLatestSignature } from "../lib/signTofly/ledger.js";

// RegistrationConfig widens ConfigSchema with autoAllocatePilotsToRoundClub —
// a runtime-only field that the registration flow reads but Config (and
// ConfigSchema's .strip()) would otherwise drop on read.
const RegistrationConfigSchema = ConfigSchema.extend({
  autoAllocatePilotsToRoundClub: z.boolean().optional(),
}).strip();
type RegistrationConfig = Config & { autoAllocatePilotsToRoundClub?: boolean };

const RoundSummariesSchema = z.array(RoundSummarySchema);

interface RegisterSelfBody {
  teamId?: unknown;
  preferredPlace?: unknown;
}

interface PilotClubForSeason {
  clubId: string;
  clubName: string;
}

const OPEN_STATUSES = new Set<Round["status"]>(["Proposed", "Confirmed"]);

function ipFallback(req: HttpRequest): string {
  return trustedClientIp(req) ?? "unknown";
}

async function registerSelf(
  req: HttpRequest,
  _ctx: InvocationContext,
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
    identityKey: caller.pilotId ?? `anon:${ipFallback(req)}`,
  });

  const roundId = req.params["roundId"];
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const body = await parseRegisterBody(req);
  const [round, config] = await Promise.all([readRound(roundId), readConfig()]);
  ensureRegistrationOpen(round, "REGISTRATION_CLOSED");

  const pilot = await readPilot(caller.pilotId);
  ensureProfileComplete(pilot);

  const pilotClub = await ensurePilotClubForSeason(pilot.id, round, config);
  const team = findTeamForPilotClub(round, body.teamId, pilotClub.clubId);

  await ensureNotDoubleBooked(pilot.id, round);
  const place = choosePlace(team, body.preferredPlace, config.maxPilotsInTeam);
  const pilotSnapshot = buildPilotSnapshot(pilot);

  await withPrivateLease(`rounds/${roundId}.json`, async (leaseId) => {
    const lockedRound = await readRound(roundId);
    ensureRegistrationOpen(lockedRound, "REGISTRATION_CLOSED");
    const lockedTeam = findTeamForPilotClub(lockedRound, body.teamId, pilotClub.clubId);
    const lockedPlace = choosePlace(lockedTeam, place, config.maxPilotsInTeam);
    if (lockedPlace !== place) throw new HttpError(409, "SLOT_TAKEN", `Place ${place} is no longer available`);
    if (isPilotInRound(lockedRound, pilot.id)) {
      throw new HttpError(409, "DOUBLE_BOOKING", `Pilot is already registered in this round ${lockedRound.id}`);
    }

    const slot = getOrCreateSlot(lockedTeam, place);
    fillSlot(slot, pilot.id, pilotSnapshot);
    await writePrivateJson(`rounds/${roundId}.json`, RoundSchema, lockedRound, leaseId);
  });

  return { status: 200, jsonBody: { roundId, teamId: body.teamId, place, pilotSnapshot } };
}

async function unregisterSelf(
  req: HttpRequest,
  _ctx: InvocationContext,
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
    identityKey: caller.pilotId ?? `anon:${ipFallback(req)}`,
  });

  const roundId = req.params["roundId"];
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const round = await readRound(roundId);
  ensureRegistrationOpen(round, "UNREGISTRATION_CLOSED");
  const existing = findPilotSlot(round, caller.pilotId!);
  if (!existing) throw new HttpError(404, "NOT_REGISTERED", "You are not registered in this round");

  const signature = await getLatestSignature(roundId, existing.team.id, existing.slot.placeInTeam);
  if (signature) {
    throw new HttpError(
      409,
      "SIGNED_CONTACT_COORD",
      "You have already signed to fly; ask a coordinator to remove you.",
    );
  }

  await withPrivateLease(`rounds/${roundId}.json`, async (leaseId) => {
    const lockedRound = await readRound(roundId);
    ensureRegistrationOpen(lockedRound, "UNREGISTRATION_CLOSED");
    const lockedSlot = findPilotSlot(lockedRound, caller.pilotId!);
    if (!lockedSlot) throw new HttpError(404, "NOT_REGISTERED", "You are not registered in this round");

    const lockedSignature = await getLatestSignature(roundId, lockedSlot.team.id, lockedSlot.slot.placeInTeam);
    if (lockedSignature) {
      throw new HttpError(
        409,
        "SIGNED_CONTACT_COORD",
        "You have already signed to fly; ask a coordinator to remove you.",
      );
    }

    clearSlot(lockedSlot.slot);
    await writePrivateJson(`rounds/${roundId}.json`, RoundSchema, lockedRound, leaseId);
  });

  return {
    status: 200,
    jsonBody: {
      roundId,
      removedFromTeamId: existing.team.id,
      removedFromPlace: existing.slot.placeInTeam,
    },
  };
}

async function parseRegisterBody(req: HttpRequest): Promise<{ teamId: string; preferredPlace?: number }> {
  let body: RegisterSelfBody;
  try {
    body = await req.json() as RegisterSelfBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const teamId = typeof body.teamId === "string" ? body.teamId.trim() : "";
  if (!teamId) throw new HttpError(400, "INVALID_BODY", "teamId is required");

  if (body.preferredPlace === undefined || body.preferredPlace === null || body.preferredPlace === "") {
    return { teamId };
  }
  const preferredPlace = Number(body.preferredPlace);
  if (!Number.isInteger(preferredPlace) || preferredPlace < 1) {
    throw new HttpError(400, "INVALID_BODY", "preferredPlace must be a positive integer");
  }
  return { teamId, preferredPlace };
}

async function readRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

async function readPilot(pilotId: string): Promise<Pilot> {
  const path = `pilots/${pilotId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), PilotSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(422, "PROFILE_INCOMPLETE", "Complete your profile first");
    }
    // A pilot blob whose required schema fields are blank/missing is the
    // observable form of an incomplete profile (e.g. firstName === ""), so
    // surface the same 422 the runtime check below would have raised.
    if (err instanceof BlobShapeError) {
      throw new HttpError(422, "PROFILE_INCOMPLETE", "Complete your profile first");
    }
    throw err;
  }
}

async function readConfig(): Promise<RegistrationConfig> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      RegistrationConfigSchema,
      "config.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        maxTeamsInClub: 3,
        maxPilotsInTeam: 5,
        maxScoringPilotsInTeam: 3,
        flightDateValidationEnabled: true,
        wingFactors: {
          "EN A": 1.2,
          "EN B": 1.1,
          "EN C": 1,
          "EN C 2-liner": 0.95,
          "EN D": 0.9,
          "EN D 2-liner": 0.85,
        },
      };
    }
    throw err;
  }
}

function ensureRegistrationOpen(round: Round, code: "REGISTRATION_CLOSED" | "UNREGISTRATION_CLOSED"): void {
  if (!OPEN_STATUSES.has(round.status)) {
    throw new HttpError(409, code, `Round status is ${round.status}`);
  }
}

function ensureProfileComplete(pilot: Pilot): void {
  if (!pilot.person.firstName?.trim() || !pilot.person.lastName?.trim()) {
    throw new HttpError(422, "PROFILE_INCOMPLETE", "Complete your profile first");
  }
}

async function ensurePilotClubForSeason(
  pilotId: string,
  round: Round,
  config: RegistrationConfig,
): Promise<PilotClubForSeason> {
  const seasonYear = round.season.year;
  const roundClub = round.organisingClub;
  if (!roundClub) {
    throw new HttpError(409, "NOT_IN_CLUB_FOR_SEASON", "Round has no organising club");
  }

  const pilot = await readPilot(pilotId);
  const existing = pilot.seasonClubs.find((club) => club.seasonYear === seasonYear);
  if (existing?.clubId === roundClub.id) return existing;

  if (existing && !config.autoAllocatePilotsToRoundClub) {
    throw new HttpError(409, "NOT_IN_CLUB_FOR_SEASON", `Pilot is registered with ${existing.clubName} for ${seasonYear}`);
  }

  if (!existing || config.autoAllocatePilotsToRoundClub) {
    const allocated = { seasonYear, clubId: roundClub.id, clubName: roundClub.name };
    await withPrivateLease(`pilots/${pilotId}.json`, async (leaseId) => {
      const lockedPilot = await readPilot(pilotId);
      const idx = lockedPilot.seasonClubs.findIndex((club) => club.seasonYear === seasonYear);
      if (idx >= 0) {
        if (lockedPilot.seasonClubs[idx].clubId !== roundClub.id && !config.autoAllocatePilotsToRoundClub) {
          throw new HttpError(409, "NOT_IN_CLUB_FOR_SEASON", `Pilot is registered with ${lockedPilot.seasonClubs[idx].clubName} for ${seasonYear}`);
        }
        lockedPilot.seasonClubs[idx] = allocated;
      } else {
        lockedPilot.seasonClubs.push(allocated);
      }
      lockedPilot.currentClub = roundClub;
      await writePrivateJson(`pilots/${pilotId}.json`, PilotSchema, lockedPilot, leaseId);
    });
    return allocated;
  }

  throw new HttpError(409, "NOT_IN_CLUB_FOR_SEASON", `Pilot is not associated with ${roundClub.name} for ${seasonYear}`);
}

function findTeamForPilotClub(round: Round, teamId: string, clubId: string): Team {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "Team not found");
  if (team.club.id !== clubId) {
    throw new HttpError(422, "TEAM_CLUB_MISMATCH", "Team does not belong to your club for this season");
  }
  return team;
}

async function ensureNotDoubleBooked(pilotId: string, targetRound: Round): Promise<void> {
  let summaries: RoundSummary[] = [];
  try {
    summaries = await readJson(
      getBlobClient("rounds.json"),
      RoundSummariesSchema,
      "rounds.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  const candidates = summaries.filter((summary) =>
    summary.id !== targetRound.id &&
    summary.seasonYear === targetRound.season.year &&
    summary.status !== "Cancelled" &&
    isWithinOneLocalDate(summary.date, targetRound.date)
  );

  for (const candidate of candidates) {
    const round = await readRound(candidate.id);
    if (round.status === "Cancelled") continue;
    if (isPilotInRound(round, pilotId)) {
      throw new HttpError(409, "DOUBLE_BOOKING", `Conflicting round ${round.id} on ${round.date}`);
    }
  }
}

function isWithinOneLocalDate(dateA: string, dateB: string): boolean {
  return Math.abs(localDateNumber(dateA) - localDateNumber(dateB)) <= 1;
}

function localDateNumber(value: string): number {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function isPilotInRound(round: Round, pilotId: string): boolean {
  return round.teams.some((team) =>
    team.pilots.some((slot) => slot.status === "Filled" && slot.pilotId === pilotId),
  );
}

function choosePlace(team: Team, preferredPlace: number | undefined, maxPilotsInTeam: number): number {
  if (preferredPlace !== undefined) {
    if (preferredPlace > maxPilotsInTeam) throw new HttpError(409, "TEAM_FULL", `Team is full (max ${maxPilotsInTeam})`);
    if (!isSlotAvailable(team, preferredPlace)) throw new HttpError(409, "SLOT_TAKEN", `Place ${preferredPlace} is already taken`);
    return preferredPlace;
  }

  for (let place = 1; place <= maxPilotsInTeam; place += 1) {
    if (isSlotAvailable(team, place)) return place;
  }
  throw new HttpError(409, "TEAM_FULL", `Team is full (max ${maxPilotsInTeam})`);
}

function isSlotAvailable(team: Team, place: number): boolean {
  const slot = team.pilots.find((candidate) => candidate.placeInTeam === place);
  return !slot || slot.status === "Empty" || !slot.pilotId;
}

function getOrCreateSlot(team: Team, place: number): PilotSlot {
  let slot = team.pilots.find((candidate) => candidate.placeInTeam === place);
  if (!slot) {
    slot = {
      placeInTeam: place,
      isScoring: true,
      status: "Empty",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: null,
      snapshot: null,
      flight: null,
    };
    team.pilots.push(slot);
    team.pilots.sort((a, b) => a.placeInTeam - b.placeInTeam);
  }
  return slot;
}

function fillSlot(slot: PilotSlot, pilotId: string, snapshot: PilotSnapshot): void {
  slot.status = "Filled";
  slot.pilotId = pilotId;
  slot.snapshot = snapshot;
  slot.signToFly = false;
  slot.accountedFor = false;
}

function clearSlot(slot: PilotSlot): void {
  slot.status = "Empty";
  slot.pilotId = null;
  slot.snapshot = null;
  slot.signToFly = false;
  slot.accountedFor = false;
}

function buildPilotSnapshot(pilot: Pilot): PilotSnapshot {
  return {
    wingClass: pilot.wingClass ?? "EN B",
    pilotRating: pilot.pilotRating,
    phoneNumber: pilot.person.phoneNumber,
    helmetColour: pilot.helmetColour,
    harnessType: pilot.harnessType,
    harnessColour: pilot.harnessColour,
    wingManufacturer: pilot.wingManufacturer?.name,
    wingModel: pilot.wingModel,
    wingColours: pilot.wingColours,
    emergencyContactName: pilot.emergencyContactName,
    emergencyPhoneNumber: pilot.emergencyPhoneNumber,
    medicalInfo: pilot.medicalInfo,
  };
}

function findPilotSlot(round: Round, pilotId: string): { team: Team; slot: PilotSlot } | null {
  for (const team of round.teams) {
    const slot = team.pilots.find((candidate) => candidate.status === "Filled" && candidate.pilotId === pilotId);
    if (slot) return { team, slot };
  }
  return null;
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
