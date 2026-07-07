// SPDX-License-Identifier: MPL-2.0
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import type { Config, Flight, PilotSlot, RescoreJob, Round } from "@bccweb/types";
import { scoreRound } from "@bccweb/scoring";
import { ConfigSchema, PilotSchema, RoundSchema } from "@bccweb/schemas";

import { getPrivateBlobClient, readBlob, withPrivateLeaseRenewing, writePrivateBlob } from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { forbiddenResponse, getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { scoreIgc } from "../lib/igcScoring.js";
import { acquireActiveGuard, enqueueRescore, releaseActiveGuard, writeJobStatus } from "../lib/rescoreJob.js";

const BUDGET_MS = 8 * 60_000;

type RescoreCounters = {
  rescoredCount: number; skippedManualCount: number; skippedNoIgcCount: number;
  skippedBudgetCount: number; errorCount: number;
};

type RescoreError = { teamId: string; place: number; error: string };

type FlightUpdate = { teamId: string; place: number; flightPatch: Partial<Flight> };

async function loadConfig(): Promise<Config> {
  try {
    return await readJson(getPrivateBlobClient("config.json"), ConfigSchema, "config.json");
  } catch {
    return ConfigSchema.parse({});
  }
}

async function readRoundOr404(path: string): Promise<Round> {
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

async function resolveExpectedPilotName(pilotId: string | null): Promise<string | undefined> {
  if (!pilotId) return undefined;

  const path = `pilots/${pilotId}.json`;
  try {
    const pilot = await readJson(getPrivateBlobClient(path), PilotSchema, path);
    return pilot.person.fullName || undefined;
  } catch {
    return undefined;
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function matchingSlot(round: Round, update: FlightUpdate): PilotSlot | undefined {
  const team = round.teams.find((candidate) => candidate.id === update.teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === update.place);
}

function applyUpdates(round: Round, updates: readonly FlightUpdate[]): void {
  for (const update of updates) {
    const slot = matchingSlot(round, update);
    if (!slot?.flight) continue;
    slot.flight = { ...slot.flight, ...update.flightPatch };
  }
}

async function buildRescoreUpdates(round: Round, startedAt: number): Promise<{
  counters: RescoreCounters;
  errors: RescoreError[];
  updates: FlightUpdate[];
  scoredByVersion: string | undefined;
}> {
  const counters: RescoreCounters = {
    rescoredCount: 0,
    skippedManualCount: 0,
    skippedNoIgcCount: 0,
    skippedBudgetCount: 0,
    errorCount: 0,
  };
  const errors: RescoreError[] = [];
  const updates: FlightUpdate[] = [];
  let scoredByVersion: string | undefined;

  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (Date.now() - startedAt > BUDGET_MS) {
        counters.skippedBudgetCount += 1;
        continue;
      }

      if (slot.flight?.isManualLog === true) {
        counters.skippedManualCount += 1;
        continue;
      }

      const igcPath = slot.flight?.igcPath;
      if (!igcPath) {
        counters.skippedNoIgcCount += 1;
        continue;
      }

      try {
        const download = await getPrivateBlobClient(igcPath).download();
        const readableStreamBody = download.readableStreamBody;
        if (!readableStreamBody) {
          throw new Error(`IGC blob ${igcPath} returned no readable stream`);
        }
        const expectedPilotName = await resolveExpectedPilotName(slot.pilotId);
        const result = await scoreIgc({
          buffer: await streamToBuffer(readableStreamBody),
          expectedDate: round.date,
          expectedPilotName,
        });
        scoredByVersion = result.scoredByVersion;
        updates.push({
          teamId: team.id,
          place: slot.placeInTeam,
          flightPatch: {
            distance: result.distance,
            sanityFlags: result.sanityFlags,
            scoredAt: result.scoredAt,
            scoredByVersion: result.scoredByVersion,
            score: 0,
          },
        });
        counters.rescoredCount += 1;
      } catch (err: unknown) {
        counters.errorCount += 1;
        errors.push({
          teamId: team.id,
          place: slot.placeInTeam,
          error: errorMessage(err),
        });
      }
    }
  }

  return { counters, errors, updates, scoredByVersion };
}

export async function runRescoreJob(
  roundId: string,
  job: RescoreJob,
  _ctx: InvocationContext,
): Promise<RescoreJob> {
  const startedAt = Date.now();
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await writeJobStatus(job);

  const path = `rounds/${roundId}.json`;
  const round = await readRoundOr404(path);
  const { counters, errors, updates, scoredByVersion } = await buildRescoreUpdates(round, startedAt);

  await withPrivateLeaseRenewing(path, async (leaseId) => {
    const leasedRound = (await readBlob(getPrivateBlobClient(path))) as Round;
    applyUpdates(leasedRound, updates);
    const config = await loadConfig();
    const { round: scored, derivation } = scoreRound(leasedRound, config);
    scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
    await writePrivateJson(path, RoundSchema, scored, leaseId);
  });

  const auditTimestamp = new Date().toISOString();
  await writePrivateBlob(`audit/rescore/${roundId}-${auditTimestamp}.json`, {
    actorEmail: job.requestedByEmail,
    roundId,
    timestamp: auditTimestamp,
    counts: counters,
    errors,
  });

  job.counts = counters;
  job.errors = errors;
  if (scoredByVersion !== undefined) job.scoredByVersion = scoredByVersion;
  job.finishedAt = new Date().toISOString();
  job.status = counters.skippedBudgetCount > 0 ? "partial" : "completed";
  await writeJobStatus(job);
  return job;
}

async function rescoreRound(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const round = await readRoundOr404(`rounds/${id}.json`);
  if (round.status !== "Locked" && round.status !== "Complete") {
    return {
      status: 409,
      jsonBody: {
        error: `Round must be Locked or Complete to rescore (currently ${round.status})`,
      },
    };
  }

  const jobId = randomUUID();
  if (!(await acquireActiveGuard(id))) {
    return {
      status: 409,
      jsonBody: {
        error: "A rescore is already in progress for this round",
        code: "RESCORE_IN_PROGRESS",
      },
    };
  }

  const job: RescoreJob = {
    jobId,
    roundId: id,
    status: "queued",
    requestedByEmail: caller.email,
    requestedAt: new Date().toISOString(),
  };

  try {
    await writeJobStatus(job);
    await enqueueRescore({
      jobId,
      roundId: id,
      requestedByEmail: caller.email,
      requestedByIp: req.headers.get("x-forwarded-for") ?? "",
      requestedAt: job.requestedAt,
    });
  } catch (err: unknown) {
    await releaseActiveGuard(id);
    throw err;
  }

  return { status: 202, jsonBody: { jobId, status: "queued" } };
}

app.http("rescoreRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/rescore",
  handler: withErrorHandler(rescoreRound),
});
