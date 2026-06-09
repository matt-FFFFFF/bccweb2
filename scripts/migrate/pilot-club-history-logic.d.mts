export interface PilotClubHistoryEntry {
  pilotId: string;
  clubId: string;
  clubName: string;
  joinedAt: string | null;
  leftAt: string | null;
  source: "legacy" | "current";
  legacyId?: number;
}

export declare function buildPilotClubHistory(
  pilotClubRows: Array<{
    ID: number;
    Pilot_ID: number;
    Club_ID: number | null;
    JoinedAt: Date | null;
    LeftAt: Date | null;
  }>,
  pilotUuid: Map<number, string>,
  clubUuid: Map<number, string>,
  clubsList: Array<{ id: string; name: string }>,
  pilotsWithCurrentClub: Array<{
    pilotId: string;
    currentSeasonClub: { clubId: string; clubName: string } | undefined;
  }>
): Map<string, PilotClubHistoryEntry[]>;
