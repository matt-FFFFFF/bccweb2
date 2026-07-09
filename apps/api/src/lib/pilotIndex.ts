// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Shared pilot public-index upsert — extracted from pilots.ts + meProfile.ts (issue #101).
 *
 * Writes/updates the anonymously-readable `pilots.json` summary index for a pilot.
 * The index shows only VERIFIED active-season club membership, derived from the
 * pilot's `seasonClubs` entry for the active year — never the self-declared
 * `currentClub` (which a pilot can set to any club), so the public index cannot be
 * poisoned with an unaffiliated club. issue #101 (Decision 6): a self-selected club
 * now IS the pilot's active-season club (createMyPilot seeds it into
 * `pilot.seasonClubs`), so a newly self-created pilot appears under their chosen
 * club via that entry; `clubId` is non-PII and the club only locks once the pilot
 * has flown (see updatePilot). Callers mid-mutation pass the already-resolved year
 * to skip a second `seasons.json` read and close a season-flip window between the
 * two reads.
 */

import * as z from "zod/v4";
import type { Pilot, PilotSummary } from "@bccweb/types";
import { PilotSummarySchema } from "@bccweb/schemas";
import {
  ensureJsonIndexBlob,
  getBlobClient,
  withLeaseRetry,
  writeBlob,
} from "./blob.js";
import { readJson } from "./blobJson.js";
import { getActiveSeasonYear } from "./season.js";

const PilotsIndexSchema = z.array(PilotSummarySchema);

export async function upsertPilotInIndex(
  pilot: Pilot,
  activeYear?: number,
): Promise<void> {
  const year = activeYear ?? (await getActiveSeasonYear());
  const verifiedClubId = pilot.seasonClubs.find(
    (sc) => sc.seasonYear === year,
  )?.clubId;

  await ensureJsonIndexBlob("pilots.json", "[]");

  await withLeaseRetry("pilots.json", async (leaseId) => {
    let index: PilotSummary[] = [];
    try {
      index = await readJson(
        getBlobClient("pilots.json"),
        PilotsIndexSchema,
        "pilots.json",
      );
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }

    const entry: PilotSummary = {
      id: pilot.id,
      legacyId: pilot.legacyId,
      name: pilot.person.fullName,
      clubId: verifiedClubId,
      rating: pilot.pilotRating,
    };

    const idx = index.findIndex((p) => p.id === pilot.id);
    if (idx >= 0) {
      index[idx] = entry;
    } else {
      index.push(entry);
    }

    index.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    await writeBlob("pilots.json", index, leaseId);
  });
}
