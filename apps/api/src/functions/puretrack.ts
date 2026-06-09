/**
 * PureTrack manual trigger endpoint — Phase 4
 *
 * POST /api/rounds/{id}/puretrack/create-groups
 *
 * Manually (re-)creates PureTrack groups for a locked round.
 * Useful if the automatic creation on lock failed, or to recreate after an unlock/re-lock.
 *
 * Auth: RoundsCoord or Admin only.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Round, Pilot } from "@bccweb/types";
import { getPrivateBlobClient, readBlob, writePrivateBlob, withPrivateLease } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import {
  createPureTrackGroups,
  PureTrackRoundResult,
} from "../lib/puretrack.js";

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

async function createPureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  // Load round
  let round: Round;
  try {
    round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Round not found" } };
    }
    throw err;
  }

  if (round.status !== "Locked" && round.status !== "Complete") {
    return {
      status: 409,
      jsonBody: {
        error: `PureTrack groups can only be created for Locked or Complete rounds (currently ${round.status})`,
      },
    };
  }

  // Collect pilot PureTrack IDs
  const pilotIds = round.teams.flatMap((t) =>
    t.pilots
      .filter((s) => s.status === "Filled" && s.pilotId)
      .map((s) => s.pilotId!)
  );
  const uniquePilotIds = [...new Set(pilotIds)];

  const pilotPureTrackIds = new Map<string, number>();
  await Promise.all(
    uniquePilotIds.map(async (pilotId) => {
      try {
        const pilot = await readBlob<Pilot>(
          getPrivateBlobClient(`pilots/${pilotId}.json`)
        );
        if (pilot.pureTrackId) {
          pilotPureTrackIds.set(pilotId, pilot.pureTrackId);
        }
      } catch {
        // pilot not found — skip
      }
    })
  );

  // Create groups
  let result: PureTrackRoundResult;
  try {
    result = await createPureTrackGroups(round, pilotPureTrackIds);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[puretrack] createPureTrackGroups failed for round ${id}:`, err);
    return {
      status: 502,
      jsonBody: { error: `PureTrack API error: ${msg}` },
    };
  }

  // Persist group IDs back onto the round blob (under lease)
  const path = `rounds/${id}.json`;
  try {
    await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));
      r.pureTrackGroupId = result.roundGroupId;
      r.pureTrackGroupName = result.roundGroupName;
      r.pureTrackGroupSlug = result.roundGroupSlug;
      for (const team of r.teams) {
        const teamResult = result.teams.find((t) => t.teamId === team.id);
        if (teamResult) {
          team.pureTrackGroupId = teamResult.groupId;
          team.pureTrackGroupSlug = teamResult.groupSlug;
        }
      }
      await writePrivateBlob(path, r, leaseId);
    });
  } catch (err) {
    // Not fatal — groups were created, IDs just didn't persist; log and continue
    console.error(`[puretrack] Failed to persist group IDs for round ${id}:`, err);
  }

  return { status: 200, jsonBody: result };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createPureTrackGroups", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/puretrack/create-groups",
  handler: createPureTrackGroupsHandler,
});
