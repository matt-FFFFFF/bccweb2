import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import type { Round, RoundBrief, Signature } from "@bccweb/types";

import { getPrivateBlobClient, withPrivateLeaseRetry } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import { listSignaturesForRound } from "./ledger.js";

type RoundBriefWithVersion = RoundBrief & { version?: number };

export async function reflectRoundSignToFly(roundId: string): Promise<void> {
  // OUTSIDE the lease: the expensive prefix scan. A signature that lands AFTER
  // this list is self-healed by its OWN reflect job (its enqueue re-triggers).
  const signatures = await listSignaturesForRound(roundId);
  const roundPath = `rounds/${roundId}.json`;

  await withPrivateLeaseRetry(roundPath, async (leaseId) => {
    const round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    if (round.status !== "BriefComplete") return;

    const brief = await readBriefOrNull(roundId);
    if (!brief) return;

    const changed = materializeSignToFly(round, brief, signatures);
    if (changed) await writePrivateJson(roundPath, RoundSchema, round, leaseId);
  });
}

export function materializeSignToFly(
  round: Round,
  brief: RoundBrief & { version?: number },
  signatures: Signature[],
): boolean {
  const currentBriefVersion = brief.version ?? 1;
  const latest = new Map<string, number>();

  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotKey(signature.teamId, signature.place);
    latest.set(key, Math.max(latest.get(key) ?? 0, signature.briefVersion));
  }

  let changed = false;
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      const latestVersion = latest.get(slotKey(team.id, slot.placeInTeam));
      const next = latestVersion !== undefined && latestVersion === currentBriefVersion;
      if (slot.signToFly !== next) {
        slot.signToFly = next;
        changed = true;
      }
    }
  }

  return changed;
}

function slotKey(teamId: string, place: number): string {
  return `${teamId}:${place}`;
}

async function readBriefOrNull(roundId: string): Promise<RoundBriefWithVersion | null> {
  const path = `round-briefs/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if (isMissingBlob(err)) return null;
    throw err;
  }
}

function isMissingBlob(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}
