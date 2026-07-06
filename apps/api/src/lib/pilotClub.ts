import { PilotSchema } from "@bccweb/schemas";
import type { Pilot, PilotSeasonClub } from "@bccweb/types";

import { getPrivateBlobClient, withPrivateLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";

export function pilotClubIdForSeason(pilot: Pilot, seasonYear: number): string | null {
  return (
    pilot.seasonClubs.find((club) => club.seasonYear === seasonYear)?.clubId
    ?? pilot.currentClub?.id
    ?? null
  );
}

export function withSeasonClub(
  seasonClubs: PilotSeasonClub[],
  entry: PilotSeasonClub,
): PilotSeasonClub[] {
  return [...seasonClubs.filter((club) => club.seasonYear !== entry.seasonYear), entry];
}

export async function ensureSeasonClubRecorded(
  pilotId: string,
  seasonYear: number,
  clubId: string,
  clubName: string,
): Promise<string> {
  const path = `pilots/${pilotId}.json`;
  return withPrivateLease(path, async (leaseId) => {
    const pilot = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    const existing = pilot.seasonClubs.find((club) => club.seasonYear === seasonYear);
    if (existing) return existing.clubId;
    pilot.seasonClubs.push({ seasonYear, clubId, clubName });
    await writePrivateJson(path, PilotSchema, pilot, leaseId);
    return clubId;
  });
}
