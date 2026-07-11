// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BlobLeaseClient } from "@azure/storage-blob";
import type { Pilot, Round, Signature, Team } from "@bccweb/types";
import { vi } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeConfig,
  makePilot,
  makeRound,
  makeUser,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";

export type SlotSeed = {
  readonly placeInTeam: number;
  readonly pilotId: string | null;
};

export type RegistrationContext = {
  readonly clubId: string;
  readonly pilot: Pilot;
  readonly userId: string;
  readonly email: string;
  readonly round: Round;
  readonly team: Team;
};

type SeedOptions = {
  readonly roundStatus?: Round["status"];
  readonly pilotOverrides?: {
    readonly firstName?: string;
    readonly lastName?: string;
  };
  readonly teamSlots?: readonly SlotSeed[];
  readonly team?: Team;
  readonly maxPilotsInTeam?: number;
};

export async function seedRegistrationRound(
  options: SeedOptions = {}
): Promise<RegistrationContext> {
  resetAllBuckets();
  const clubId = options.team?.club.id ?? randomUUID();
  await makeConfig({ maxPilotsInTeam: options.maxPilotsInTeam ?? 3 });
  const pilot = await makePilot({
    firstName: options.pilotOverrides?.firstName ?? "Ava",
    lastName: options.pilotOverrides?.lastName ?? "Pilot",
    clubId,
  });
  pilot.seasonClubs = [
    { seasonYear: 2026, clubId, clubName: "Test Club" },
  ];
  await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
  const { user } = await makeUser({
    roles: ["Pilot"],
    pilotId: pilot.id,
    clubId,
  });

  const seededSlots = options.teamSlots?.map((slot) => ({
    placeInTeam: slot.placeInTeam,
    pilotId: slot.pilotId === "self" ? pilot.id : slot.pilotId,
  }));
  const team = options.team ?? makeTeam(clubId, "Test Team", seededSlots);
  if (options.team) {
    options.team.club = { id: clubId, name: "Test Club" };
  }

  const round = await makeRound({
    date: "2026-06-09",
    status: options.roundStatus ?? "Confirmed",
    seasonYear: 2026,
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    teams: [team],
  });

  return {
    clubId,
    pilot,
    userId: user.id,
    email: user.email,
    round,
    team,
  };
}

export function makeTeam(
  clubId: string,
  name: string,
  slots: readonly SlotSeed[] = []
): Team {
  return {
    id: randomUUID(),
    teamName: name,
    club: { id: clubId, name: "Test Club" },
    score: 0,
    pilots: slots.map((slot) => ({
      placeInTeam: slot.placeInTeam,
      isScoring: true,
      status: slot.pilotId ? "Filled" : "Empty",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: slot.pilotId,
      snapshot: null,
      flight: null,
    })),
  };
}

export async function register(
  context: RegistrationContext,
  body: { readonly preferredPlace?: number } = {}
) {
  return invoke(
    "registerSelfForRound",
    makeAuthRequest(context.userId, context.email, {
      method: "POST",
      params: { roundId: context.round.id },
      body: { teamId: context.team.id, ...body },
      headers: { "x-forwarded-for": `${randomUUID()}.test` },
    })
  );
}

export async function unregister(context: RegistrationContext) {
  return invoke(
    "unregisterSelfFromRound",
    makeAuthRequest(context.userId, context.email, {
      method: "POST",
      params: { roundId: context.round.id },
      headers: { "x-forwarded-for": `${randomUUID()}.test` },
    })
  );
}

export function makeSignature(context: RegistrationContext): Signature {
  return {
    id: randomUUID(),
    roundId: context.round.id,
    teamId: context.team.id,
    place: 1,
    pilotId: context.pilot.id,
    userId: context.userId,
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: null,
    userAgent: null,
    source: "pilot-self",
  };
}

export function failRoundLeaseOnce(roundPath: string, statusCode: number) {
  const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
  const acquireLease = vi.spyOn(BlobLeaseClient.prototype, "acquireLease");
  let pendingFailure = true;
  let roundAttempts = 0;
  acquireLease.mockImplementation(function (this: BlobLeaseClient, duration, options) {
    if (pendingFailure && this.url.includes(roundPath)) {
      roundAttempts += 1;
      pendingFailure = false;
      return Promise.reject(leaseError(statusCode));
    }
    if (this.url.includes(roundPath)) roundAttempts += 1;
    return originalAcquireLease.call(this, duration, options);
  });
  return { roundAttempts: () => roundAttempts };
}

export function trackRoundLeaseAttempts(roundPath: string): () => number {
  const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
  let roundAttempts = 0;
  vi.spyOn(BlobLeaseClient.prototype, "acquireLease").mockImplementation(
    function (this: BlobLeaseClient, duration, options) {
      if (this.url.includes(roundPath)) roundAttempts += 1;
      return originalAcquireLease.call(this, duration, options);
    }
  );
  return () => roundAttempts;
}

function leaseError(
  statusCode: number
): Error & { readonly statusCode: number } {
  return Object.assign(new Error(`lease conflict (${statusCode})`), { statusCode });
}
