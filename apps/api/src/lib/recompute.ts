import type {
  Round,
  RoundSummary,
  Season,
  SeasonResults,
  RoundResult,
  WingClass,
} from "@bccweb/types";
import { computeLeague } from "@bccweb/scoring";
import {
  getBlobClient,
  getPrivateBlobClient,
  readBlob,
  writeBlob,
  withLease,
} from "./blob.js";

// ─── updateRoundsIndex ────────────────────────────────────────────────────────

/**
 * Upsert a round summary into rounds.json.
 * Uses a blob lease for atomic read-modify-write; falls back to an
 * un-leased write if rounds.json does not yet exist.
 */
export async function updateRoundsIndex(round: Round): Promise<void> {
  const path = "rounds.json";

  const summary: RoundSummary = {
    id: round.id,
    legacyId: round.legacyId,
    date: round.date,
    siteId: round.site.id,
    siteName: round.site.name,
    status: round.status,
    seasonYear: round.season.year,
  };

  const applyUpdate = async (leaseId?: string) => {
    let rounds: RoundSummary[] = [];
    try {
      rounds = await readBlob<RoundSummary[]>(getBlobClient(path));
    } catch {
      // may not exist yet — start with empty array
    }
    const idx = rounds.findIndex((r) => r.id === round.id);
    if (idx >= 0) rounds[idx] = summary;
    else rounds.push(summary);
    await writeBlob(path, rounds, leaseId);
  };

  try {
    await withLease(path, async (leaseId) => {
      await applyUpdate(leaseId);
    });
  } catch (err: unknown) {
    // acquireLease throws 404 when the blob doesn't exist yet
    if ((err as { statusCode?: number }).statusCode === 404) {
      await applyUpdate();
    } else {
      throw err;
    }
  }
}

// ─── recomputeSeason ──────────────────────────────────────────────────────────

/**
 * Recompute derived blobs for a season after a round completes:
 *   - seasons/{year}.json — updated league table
 *   - results/{year}.json — per-round results for display
 *
 * Loads all round documents in the season in parallel.
 * Called after a round transitions to Complete, and by the admin recompute
 * endpoint to recover from partial failures.
 */
export async function recomputeSeason(seasonYear: number): Promise<void> {
  const seasonPath = `seasons/${seasonYear}.json`;
  const season = await readBlob<Season>(getBlobClient(seasonPath));

  // Load all rounds in parallel; skip rounds that fail to load
  const maybeRounds = await Promise.all(
    season.rounds.map((id) =>
      readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`)).catch(() => null)
    )
  );
  const rounds = maybeRounds.filter((r): r is Round => r !== null);

  // Compute league table
  const leagueTable = computeLeague(rounds);
  await writeBlob(seasonPath, { ...season, leagueTable });

  // Load pilot index for name resolution in results
  let pilotNameMap: Record<string, string> = {};
  try {
    const idx = await readBlob<Array<{ id: string; name: string }>>(
      getBlobClient("pilots.json")
    );
    pilotNameMap = Object.fromEntries(idx.map((p) => [p.id, p.name]));
  } catch {
    // pilots.json may not exist yet — names will fall back to IDs
  }

  // Compute and persist per-round results
  const results = buildSeasonResults(rounds, pilotNameMap);
  await writeBlob(`results/${seasonYear}.json`, results);
}

// ─── buildSeasonResults ───────────────────────────────────────────────────────

function buildSeasonResults(
  rounds: Round[],
  pilotNameMap: Record<string, string>
): SeasonResults {
  const completeRounds = rounds
    .filter((r) => r.status === "Complete")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return completeRounds.map((round): RoundResult => {
    const teamResults = round.teams
      .sort((a, b) => b.score - a.score)
      .map((team, i) => ({
        rank: i + 1,
        teamName: team.teamName,
        clubName: team.club.name,
        score: team.score,
        pilots: team.pilots
          .filter((p) => p.flight != null && p.snapshot != null)
          .sort((a, b) => b.pilotPoints - a.pilotPoints)
          .map((slot) => ({
            pilotName: slot.pilotId
              ? (pilotNameMap[slot.pilotId] ?? slot.pilotId)
              : "Unknown",
            distance: slot.flight!.distance,
            score: slot.pilotPoints,
            wingClass: slot.snapshot!.wingClass as WingClass,
          })),
      }));

    return {
      roundId: round.id,
      date: round.date,
      siteName: round.site.name,
      teamResults,
    };
  });
}
