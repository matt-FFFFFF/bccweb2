// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";

import { getBlobClient } from "./blob.js";
import { readJson } from "./blobJson.js";

// Minimal LOCAL shape for reading results/{year}.json — no shared results schema
// exists in packages/schemas and this helper only needs the pilotId reachability.
// `.loose()` tolerates the full RoundResult fields (roundId/date/siteName/rank/…)
// without enumerating them; `teamResults` defaults to [] so a malformed round row
// never throws on access.
const FlownResultsSchema = z.array(
  z
    .object({
      teamResults: z
        .array(
          z.object({
            pilots: z.array(
              z.object({ pilotId: z.string().nullable().optional() }).loose(),
            ),
          }),
        )
        .default([]),
    })
    .loose(),
);

/**
 * True iff `pilotId` appears in a scored (Complete) round of results/{seasonYear}.json.
 *
 * The public results blob is written by recompute.ts:buildSeasonResults, which only
 * emits pilot rows for Complete rounds — so "flown" == "present in results".
 *
 * A missing results blob (Azure RestError statusCode 404) means the season has no
 * completed rounds yet, which is "not flown" → returns false. Any non-404 error is
 * re-thrown (404 detection matches recompute.ts / seed.ts).
 *
 * `p.pilotId === pilotId` is null-safe: the query id is always a real non-null string,
 * so a results row carrying `pilotId: null` can never match.
 */
export async function hasFlownInSeason(
  pilotId: string,
  seasonYear: number,
): Promise<boolean> {
  const path = `results/${seasonYear}.json`;
  try {
    const results = await readJson(getBlobClient(path), FlownResultsSchema, path);
    return results.some((roundResult) =>
      roundResult.teamResults.some((team) =>
        team.pilots.some((p) => p.pilotId === pilotId),
      ),
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}
