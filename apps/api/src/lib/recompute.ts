import type {
  Config,
  Round,
  RoundSummary,
  Season,
  SeasonResults,
  RoundResult,
} from "@bccweb/types";
import { normalizeStatus } from "@bccweb/types";
import { computeLeague } from "@bccweb/scoring";
import {
  ConfigSchema,
  PilotSummarySchema,
  RoundSchema,
  RoundSummarySchema,
  SeasonSchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getBlockBlobClient,
  getPrivateBlobClient,
  withLease,
  withLeaseRenewing,
} from "./blob.js";
import { readJson, writeJson } from "./blobJson.js";

const RoundSummariesSchema = z.array(RoundSummarySchema);
const PilotIndexEntrySchema = z.array(PilotSummarySchema);

const STALE_RECOMPUTE_MARKER_MS = 5 * 60 * 1000;

const recomputeInFlight = new Map<number, Promise<void>>();

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
      rounds = await readJson(getBlobClient(path), RoundSummariesSchema, path);
    } catch {
      // may not exist yet — start with empty array
    }
    const idx = rounds.findIndex((r) => r.id === round.id);
    if (idx >= 0) rounds[idx] = summary;
    else rounds.push(summary);
    await writeJson(path, RoundSummariesSchema, rounds, leaseId);
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
  const existing = recomputeInFlight.get(seasonYear);
  if (existing) return existing;

  const promise = recomputeSeasonUncached(seasonYear).finally(() => {
    recomputeInFlight.delete(seasonYear);
  });
  recomputeInFlight.set(seasonYear, promise);
  return promise;
}

async function loadConfig(): Promise<Config> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
  } catch {
    return ConfigSchema.parse({});
  }
}

async function recomputeSeasonUncached(seasonYear: number): Promise<void> {
  const seasonPath = `seasons/${seasonYear}.json`;
  const season = await readJson(getBlobClient(seasonPath), SeasonSchema, seasonPath);

  // Load all rounds in parallel; skip rounds that fail to load
  const maybeRounds = await Promise.all(
    season.rounds.map((id) => {
      const path = `rounds/${id}.json`;
      return readJson(getPrivateBlobClient(path), RoundSchema, path).catch(() => null);
    })
  );
  const normalizedRounds: Round[] = [];
  for (const round of maybeRounds) {
    if (round !== null) normalizedRounds.push(normalizeRoundForRecompute(round));
  }
  normalizedRounds.sort(compareRounds);

  // Compute league table. D13: the league RE-derives from persisted per-round
  // team.score aggregates under the CURRENT config, so editing
  // leagueRoundScoresCounted intentionally re-windows the league. The
  // "immutable to config edits" guarantee scopes to per-round scores + the
  // Round.scoring snapshot, NOT to the league table.
  const config = await loadConfig();
  const leagueTable = stableLeagueTable(computeLeague(normalizedRounds, config));
  const seasonPayload: Season = stableSeason({ ...season, leagueTable });

  // Load pilot index for name resolution in results
  let pilotNameMap: Record<string, string> = {};
  try {
    const idx = await readJson(
      getBlobClient("pilots.json"),
      PilotIndexEntrySchema,
      "pilots.json",
    );
    pilotNameMap = Object.fromEntries(idx.map((p) => [p.id, p.name]));
  } catch {
    // pilots.json may not exist yet — names will fall back to IDs
  }

  // Compute and persist per-round results
  const results = stableSeasonResults(buildSeasonResults(normalizedRounds, pilotNameMap));
  const roundsIndex = await buildRoundsIndex();

  await ensureRecomputeLockBlob(seasonYear);
  await withLeaseRenewing(`seasons/${seasonYear}.json.lock`, async () => {
    await createRecomputeMarker(seasonYear);
    try {
      await swapJsonBlob(seasonPath, seasonPayload);
      await swapJsonBlob(`results/${seasonYear}.json`, results);
      await swapJsonBlob("rounds.json", roundsIndex);
    } finally {
      await deleteRecomputeMarker(seasonYear);
    }
  }, {
    renewIntervalMs: 10_000,
  });
}

// ─── buildSeasonResults ───────────────────────────────────────────────────────

function buildSeasonResults(
  rounds: Round[],
  pilotNameMap: Record<string, string>
): SeasonResults {
  const completeRounds = rounds
    .filter((r) => r.status === "Complete")
    .sort(compareRounds);

  return completeRounds.map((round): RoundResult => {
    const teamResults = [...round.teams]
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.club.id.localeCompare(b.club.id) ||
          a.teamName.localeCompare(b.teamName) ||
          a.id.localeCompare(b.id)
      )
      .map((team, i) => ({
        rank: i + 1,
        teamName: team.teamName,
        clubName: team.club.name,
        // `score` fields carry NORMALIZED points (team.score / slot.pilotPoints);
        // `distance` carries RAW km (flight.distance). Different units — do not conflate.
        score: team.score,
        pilots: [...team.pilots]
          .filter((p) => p.flight != null && p.snapshot != null)
          .sort(
            (a, b) =>
              b.pilotPoints - a.pilotPoints ||
              (a.pilotId ?? "").localeCompare(b.pilotId ?? "") ||
              a.placeInTeam - b.placeInTeam
          )
          .map((slot) => ({
            pilotId: slot.pilotId ?? null,
            pilotName: slot.pilotId
              ? (pilotNameMap[slot.pilotId] ?? slot.pilotId)
              : "Unknown",
            distance: slot.flight!.distance,
            score: slot.pilotPoints,
            wingClass: slot.snapshot!.wingClass,
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

function normalizeRoundForRecompute(round: Round): Round {
  const copy = structuredClone(round);
  copy.status = normalizeStatus(copy.status);
  copy.teams = [...copy.teams].sort(
    (a, b) =>
      a.club.id.localeCompare(b.club.id) ||
      a.teamName.localeCompare(b.teamName) ||
      a.id.localeCompare(b.id)
  );
  for (const team of copy.teams) {
    team.pilots = [...team.pilots].sort(
      (a, b) =>
        a.placeInTeam - b.placeInTeam ||
        (a.pilotId ?? "").localeCompare(b.pilotId ?? "")
    );
  }
  return copy;
}

async function buildRoundsIndex(): Promise<RoundSummary[]> {
  let existing: RoundSummary[] = [];
  try {
    existing = await readJson(
      getBlobClient("rounds.json"),
      RoundSummariesSchema,
      "rounds.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  const loaded = await Promise.all(
    existing.map((summary) => {
      const path = `rounds/${summary.id}.json`;
      return readJson(getPrivateBlobClient(path), RoundSchema, path).catch(() => null);
    })
  );

  return loaded
    .map((round, index): RoundSummary => {
      if (!round) return normalizeRoundSummary(existing[index]);
      const normalized = normalizeRoundForRecompute(round);
      return {
        id: normalized.id,
        legacyId: normalized.legacyId,
        date: normalized.date,
        siteId: normalized.site.id,
        siteName: normalized.site.name,
        status: normalized.status,
        seasonYear: normalized.season.year,
      };
    })
    .sort(compareRoundSummaries);
}

function normalizeRoundSummary(summary: RoundSummary): RoundSummary {
  return {
    ...summary,
    status: normalizeStatus(summary.status),
  };
}

async function ensureRecomputeLockBlob(seasonYear: number): Promise<void> {
  const client = getBlockBlobClient(`seasons/${seasonYear}.json.lock`);
  const content = Buffer.from(stableStringify({ purpose: "recompute-lock" }));
  await client.uploadData(content, {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: { ifNoneMatch: "*" },
  }).catch((err: unknown) => {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  });
}

async function createRecomputeMarker(seasonYear: number): Promise<void> {
  const path = `seasons/${seasonYear}.recompute.lock`;
  const client = getBlockBlobClient(path);
  const now = new Date().toISOString();

  try {
    const properties = await client.getProperties();
    const startedAt = properties.metadata?.["startedAt"];
    if (startedAt) {
      const ageMs = Date.now() - Date.parse(startedAt);
      if (Number.isFinite(ageMs) && ageMs > STALE_RECOMPUTE_MARKER_MS) {
        console.warn("[recomputeSeason] taking over stale recompute marker", {
          path,
          startedAt,
          ageMs,
        });
      }
    }
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  await client.uploadData(Buffer.alloc(0), {
    metadata: { startedAt: now },
    conditions: { ifNoneMatch: "*" },
  }).catch(async (err: unknown) => {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    await client.setMetadata({ startedAt: now });
  });
}

async function deleteRecomputeMarker(seasonYear: number): Promise<void> {
  await getBlobClient(`seasons/${seasonYear}.recompute.lock`).deleteIfExists();
}

async function swapJsonBlob(path: string, payload: unknown): Promise<void> {
  const bytes = Buffer.from(stableStringify(payload));
  const tmpPath = `${path}.tmp`;
  const tmp = getBlockBlobClient(tmpPath);
  const finalBlob = getBlobClient(path);

  await tmp.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });

  try {
    const poller = await finalBlob.beginCopyFromURL(tmp.url, { intervalInMs: 100 });
    await poller.pollUntilDone();
  } catch (err) {
    // Leave .tmp for forensics if the final copy/swap fails.
    throw err;
  }

  await tmp.deleteIfExists();
}

function stableSeason(season: Season): Season {
  return {
    ...season,
    rounds: [...season.rounds].sort(),
    leagueTable: stableLeagueTable(season.leagueTable),
  };
}

function stableLeagueTable(entries: Season["leagueTable"]): Season["leagueTable"] {
  return [...entries]
    .map((entry) => ({
      ...entry,
      roundScores: sortRecord(entry.roundScores),
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.totalScore - a.totalScore ||
        a.clubId.localeCompare(b.clubId) ||
        a.teamName.localeCompare(b.teamName)
    );
}

function stableSeasonResults(results: SeasonResults): SeasonResults {
  return [...results].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.roundId.localeCompare(b.roundId)
  );
}

function compareRounds(a: Round, b: Round): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function compareRoundSummaries(a: RoundSummary, b: RoundSummary): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  );
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortObjectKeys(child)])
  );
}
