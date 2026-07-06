import * as z from "zod/v4";

import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
} from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";

interface PilotClubMap {
  [pilotId: string]: string;
}

// PilotClubMap is a denormalised pilotId→clubId index private to the API.
// No schema in @bccweb/schemas; defined inline so observe-mode validates the
// shape without stripping unknown pilot ids. This mirrors the inline schema in
// functions/pilotSeasonClubs.ts on purpose (see upsertPilotClubMap note below).
const PilotClubMapSchema = z.record(z.string().min(1), z.string().min(1));

// Create-only seed so the very first upsert has a blob to lease. `{}` uploaded
// with ifNoneMatch:"*" — a 409/412 means it already exists, which is the no-op
// we want; any other status is a real failure and re-throws.
async function ensureSentinel(path: string): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  try {
    await client.upload(Buffer.from("{}"), 2, {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== 409 && statusCode !== 412) throw err;
  }
}

/**
 * Leased read-modify-write of `seasons/{seasonYear}/pilot-club-map.json` that
 * sets `map[pilotId] = clubId`. Idempotent: last-writer-wins per pilot, all
 * other pilots preserved.
 *
 * The sentinel-then-lease ordering is load-bearing: `ensureSentinel` guarantees
 * the blob exists before `withPrivateLease` acquires the 30s lease, so
 * concurrent callers serialise on the lease and no update is lost.
 *
 * NOTE: this intentionally duplicates the ~15-line sentinel + leased-RMW block
 * in functions/pilotSeasonClubs.ts (deliberate per the pilot-club-change-101
 * plan — no shared schema is added to @bccweb/schemas for this private index).
 */
export async function upsertPilotClubMap(
  seasonYear: number,
  pilotId: string,
  clubId: string,
): Promise<void> {
  const mapPath = `seasons/${seasonYear}/pilot-club-map.json`;
  await ensureSentinel(mapPath);
  await withPrivateLease(mapPath, async (mapLease) => {
    let map: PilotClubMap = {};
    try {
      map = await readJson(
        getPrivateBlobClient(mapPath),
        PilotClubMapSchema,
        mapPath,
      );
    } catch (err: unknown) {
      // A 404 after the sentinel is unexpected but safe to treat as an empty
      // map; any other error (corrupt shape, transport, auth) must surface.
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    map[pilotId] = clubId;
    await writePrivateJson(mapPath, PilotClubMapSchema, map, mapLease);
  });
}
