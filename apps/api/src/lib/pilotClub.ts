import type { Pilot } from "@bccweb/types";

export function pilotClubIdForSeason(pilot: Pilot, seasonYear: number): string | null {
  return (
    pilot.seasonClubs.find((club) => club.seasonYear === seasonYear)?.clubId
    ?? pilot.currentClub?.id
    ?? null
  );
}
