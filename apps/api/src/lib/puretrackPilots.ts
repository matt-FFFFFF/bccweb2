// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { PilotSchema } from "@bccweb/schemas";
import type { Round } from "@bccweb/types";
import { getPrivateBlobClient } from "./blob.js";
import { readJson } from "./blobJson.js";

export async function loadPilotPureTrackIds(
  round: Round,
): Promise<Map<string, number>> {
  const pilotIds = round.teams.flatMap((team) =>
    team.pilots.flatMap((slot) =>
      slot.status === "Filled" && slot.pilotId ? [slot.pilotId] : [],
    ),
  );
  const pilotPureTrackIds = new Map<string, number>();
  await Promise.all([...new Set(pilotIds)].map(async (pilotId) => {
    try {
      const path = `pilots/${pilotId}.json`;
      const pilot = await readJson(getPrivateBlobClient(path), PilotSchema, path);
      if (pilot.pureTrackId != null) pilotPureTrackIds.set(pilotId, pilot.pureTrackId);
    } catch (error: unknown) {
      if (statusCodeOf(error) !== 404) throw error;
    }
  }));
  return pilotPureTrackIds;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!(error instanceof Object) || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
