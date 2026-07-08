// SPDX-License-Identifier: MPL-2.0
/**
 * Shared flight-endpoint helpers — round/slot/stream/pilot-name utilities reused
 * across the IGC (`igc.ts`), manual-flight (`manualFlight.ts`), and async rescore
 * (`rescoreRound.ts`) handlers. Extracted verbatim so a future change (the 404
 * code, pilot-name resolution, slot lookup) is made in exactly one place.
 */
import type { PilotSlot, Round } from "@bccweb/types";
import { PilotSchema, RoundSchema } from "@bccweb/schemas";
import { getPrivateBlobClient } from "./blob.js";
import { readJson } from "./blobJson.js";
import { HttpError } from "./http.js";

/** Locate a slot by its 1-based `placeInTeam` within `teamId`, or null if absent. */
export function findSlot(round: Round, teamId: string, place: number): PilotSlot | null {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === place) ?? null;
}

/** Read a round blob, translating an Azure 404 into a 404 HttpError. */
export async function readRoundOr404(roundPath: string): Promise<Round> {
  try {
    return await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

/**
 * Best-effort expected pilot name for the IGC_PILOT_MISMATCH sanity check. The
 * round slot's `snapshot` does NOT carry a name, so resolve it from the pilot
 * blob; any miss (unlinked slot, absent/corrupt blob) yields `undefined`, which
 * scoreIgc treats as "skip the name check".
 */
export async function resolveExpectedPilotName(pilotId: string | null): Promise<string | undefined> {
  if (!pilotId) return undefined;
  const path = `pilots/${pilotId}.json`;
  try {
    const pilot = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    return pilot.person.fullName || undefined;
  } catch {
    return undefined;
  }
}

/** Buffer a readable stream (e.g. an IGC blob download) into a single Buffer. */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
