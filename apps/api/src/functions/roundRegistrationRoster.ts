// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  Pilot,
  PilotSlot,
  PilotSnapshot,
  Round,
  Team,
} from "@bccweb/types";
import { HttpError } from "../lib/http.js";

const OPEN_STATUSES = new Set<Round["status"]>(["Proposed", "Confirmed"]);

export function ensureRegistrationOpen(
  round: Round,
  code: "REGISTRATION_CLOSED" | "UNREGISTRATION_CLOSED"
): void {
  if (!OPEN_STATUSES.has(round.status)) {
    throw new HttpError(409, code, `Round status is ${round.status}`);
  }
}

export function ensureProfileComplete(pilot: Pilot): void {
  if (!pilot.person.firstName?.trim() || !pilot.person.lastName?.trim()) {
    throw new HttpError(
      422,
      "PROFILE_INCOMPLETE",
      "Complete your profile first"
    );
  }
}

export function pickRegistrationTeam(
  candidates: Team[],
  teamId: string | undefined
): Team {
  if (teamId) {
    const team = candidates.find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new HttpError(
        422,
        "TEAM_CLUB_MISMATCH",
        "That team does not belong to your club for this round."
      );
    }
    return team;
  }
  if (candidates.length === 1) return candidates[0];
  throw new HttpError(
    400,
    "TEAM_REQUIRED",
    "Choose which of your club's teams to join."
  );
}

export function isPilotInRound(round: Round, pilotId: string): boolean {
  return round.teams.some((team) =>
    team.pilots.some(
      (slot) => slot.status === "Filled" && slot.pilotId === pilotId
    )
  );
}

export function choosePlace(
  team: Team,
  preferredPlace: number | undefined,
  maxPilotsInTeam: number
): number {
  if (preferredPlace !== undefined) {
    if (preferredPlace > maxPilotsInTeam) {
      throw new HttpError(
        409,
        "TEAM_FULL",
        `Team is full (max ${maxPilotsInTeam})`
      );
    }
    if (!isSlotAvailable(team, preferredPlace)) {
      throw new HttpError(
        409,
        "SLOT_TAKEN",
        `Place ${preferredPlace} is already taken`
      );
    }
    return preferredPlace;
  }

  for (let place = 1; place <= maxPilotsInTeam; place += 1) {
    if (isSlotAvailable(team, place)) return place;
  }
  throw new HttpError(
    409,
    "TEAM_FULL",
    `Team is full (max ${maxPilotsInTeam})`
  );
}

export function getOrCreateRegistrationSlot(
  team: Team,
  place: number,
  maxScoringPilotsInTeam: number
): PilotSlot {
  let slot = team.pilots.find(
    (candidate) => candidate.placeInTeam === place
  );
  if (!slot) {
    slot = {
      placeInTeam: place,
      isScoring: place <= maxScoringPilotsInTeam,
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

export function fillRegistrationSlot(
  slot: PilotSlot,
  pilotId: string,
  snapshot: PilotSnapshot
): void {
  slot.status = "Filled";
  slot.pilotId = pilotId;
  slot.snapshot = snapshot;
  slot.signToFly = false;
  slot.accountedFor = false;
}

export function clearRegistrationSlot(slot: PilotSlot): void {
  slot.status = "Empty";
  slot.pilotId = null;
  slot.snapshot = null;
  slot.signToFly = false;
  slot.accountedFor = false;
}

export function buildPilotSnapshot(pilot: Pilot): PilotSnapshot {
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

export function findPilotRegistrationSlot(
  round: Round,
  pilotId: string
): { team: Team; slot: PilotSlot } | null {
  for (const team of round.teams) {
    const slot = team.pilots.find(
      (candidate) =>
        candidate.status === "Filled" && candidate.pilotId === pilotId
    );
    if (slot) return { team, slot };
  }
  return null;
}

function isSlotAvailable(team: Team, place: number): boolean {
  const slot = team.pilots.find(
    (candidate) => candidate.placeInTeam === place
  );
  return !slot || slot.status === "Empty" || !slot.pilotId;
}
