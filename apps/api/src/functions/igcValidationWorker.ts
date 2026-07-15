// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, type InvocationContext } from "@azure/functions";
import { ConfigSchema, IgcValidationJobSchema, RoundSchema } from "@bccweb/schemas";
import type { Flight, FlightValidation, IgcValidationJob, Round } from "@bccweb/types";

import {
  getPrivateBlobClient,
  readBlob,
  withPrivateLeaseRenewing,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import { validateIgcSignature } from "../lib/faiVali.js";
import { findSlot, streamToBuffer } from "../lib/flightHelpers.js";
import {
  acquireIgcValidationGuard,
  assertFaiValiTimeoutWithinGuard,
  deleteValidationResult,
  enqueueIgcValidation,
  IGC_VALIDATION_QUEUE_NAME,
  paceBeforeFaiCall,
  readValidationResult,
  releaseIgcValidationGuard,
  writeValidationResult,
} from "../lib/igcValidationJob.js";
import { recomputeSeason, updateRoundsIndex } from "../lib/recompute.js";
import { scoreRoundEnforcingValidation } from "../lib/scoreRoundValidated.js";

const GUARD_RETRY_SECONDS = 5;

type ApplyResult =
  | { readonly kind: "committed"; readonly round: Round }
  | { readonly kind: "stale" };

function parseJob(message: unknown): IgcValidationJob | null {
  let raw: unknown;
  try {
    raw = typeof message === "string" ? JSON.parse(message) : message;
  } catch {
    return null;
  }
  const parsed = IgcValidationJobSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function matchingFlight(round: Round, job: IgcValidationJob): Flight | null {
  const flight = findSlot(round, job.teamId, job.place)?.flight;
  return flight?.id === job.flightId
    && flight.validation?.validationAttemptId === job.validationAttemptId
    ? flight
    : null;
}

async function loadConfig() {
  try {
    return await readJson(getPrivateBlobClient("config.json"), ConfigSchema, "config.json");
  } catch (error: unknown) {
    if (!hasStatusCode(error, 404)) throw error;
    return ConfigSchema.parse({});
  }
}

async function readRound(path: string): Promise<Round> {
  return readJson(getPrivateBlobClient(path), RoundSchema, path);
}

async function readIgc(path: string): Promise<Buffer> {
  const response = await getPrivateBlobClient(path).download();
  const stream = response.readableStreamBody;
  if (stream === undefined) throw new Error(`IGC blob ${path} returned no readable stream`);
  return streamToBuffer(stream);
}

function igcPathFor(flight: Flight): string {
  if (flight.igcPath === undefined) {
    throw new Error(`Flight ${flight.id} has no immutable IGC path`);
  }
  return flight.igcPath;
}

function terminalResult(flight: Flight): FlightValidation | null {
  return flight.validation?.signature !== undefined
    && flight.validation.signature !== "pending"
    ? flight.validation
    : null;
}

function isGuardContention(error: unknown): boolean {
  return hasStatusCode(error, 409) || hasStatusCode(error, 412);
}

function hasStatusCode(error: unknown, expected: number): boolean {
  return typeof error === "object"
    && error !== null
    && "statusCode" in error
    && error.statusCode === expected;
}

async function createValidationResult(
  job: IgcValidationJob,
  flight: Flight,
): Promise<FlightValidation | null> {
  let leaseId: string;
  try {
    ({ leaseId } = await acquireIgcValidationGuard());
  } catch (error: unknown) {
    if (!isGuardContention(error)) throw error;
    await enqueueIgcValidation(job, { visibilityTimeoutSeconds: GUARD_RETRY_SECONDS });
    return null;
  }

  try {
    const existing = await readValidationResult(job.validationAttemptId);
    if (existing !== null) return existing;
    await paceBeforeFaiCall(leaseId);
    const igcPath = igcPathFor(flight);
    const igc = await readIgc(igcPath);
    const currentFlight = matchingFlight(
      await readRound(`rounds/${job.roundId}.json`),
      job,
    );
    if (currentFlight === null || currentFlight.isManualLog === true) return null;
    const config = await loadConfig();
    let result: FlightValidation;
    if (config.flightSignatureValidationEnabled) {
      assertFaiValiTimeoutWithinGuard();
      result = await validateIgcSignature(
        igc,
        igcPath.split("/").at(-1) ?? "flight.igc",
      );
    } else {
      result = { signature: "unverified", faiStatus: "DISABLED" };
    }
    await writeValidationResult(job.validationAttemptId, result);
    return result;
  } finally {
    await releaseIgcValidationGuard(leaseId);
  }
}

async function resolveValidationResult(
  job: IgcValidationJob,
  flight: Flight,
): Promise<FlightValidation | null> {
  const terminal = terminalResult(flight);
  if (terminal !== null) return terminal;
  const durable = await readValidationResult(job.validationAttemptId);
  return durable ?? createValidationResult(job, flight);
}

async function applyValidationResult(
  path: string,
  job: IgcValidationJob,
  result: FlightValidation,
): Promise<ApplyResult> {
  let committed: Round | null = null;
  await withPrivateLeaseRenewing(path, async (leaseId) => {
    const round = RoundSchema.parse(await readBlob(getPrivateBlobClient(path)));
    const flight = matchingFlight(round, job);
    if (flight === null || flight.isManualLog === true) return;
    flight.validation = {
      ...flight.validation,
      ...result,
      validationAttemptId: job.validationAttemptId,
      checkedAt: new Date().toISOString(),
    };
    const config = await loadConfig();
    const { round: scored, derivation } = scoreRoundEnforcingValidation(round, config);
    scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
    await writePrivateJson(path, RoundSchema, scored, leaseId);
    committed = scored;
  });
  if (committed === null) return { kind: "stale" };
  await updateRoundsIndex(committed);
  await deleteValidationResult(job.validationAttemptId);
  return { kind: "committed", round: committed };
}

export async function igcValidationWorker(
  message: unknown,
  context: InvocationContext,
): Promise<void> {
  const job = parseJob(message);
  if (job === null) {
    context.warn("[igcValidationWorker] malformed IGC validation message");
    return;
  }
  const path = `rounds/${job.roundId}.json`;
  const flight = matchingFlight(await readRound(path), job);
  if (flight === null || flight.isManualLog === true) return;
  const result = await resolveValidationResult(job, flight);
  if (result === null) return;
  const applied = await applyValidationResult(path, job, result);
  if (applied.kind === "stale" || applied.round.status !== "Complete") return;
  try {
    await recomputeSeason(applied.round.season.year);
  } catch (error: unknown) {
    context.error(
      `[igcValidationWorker] recomputeSeason(${applied.round.season.year}) failed:`,
      error,
    );
  }
}

app.storageQueue("igcValidationWorker", {
  queueName: IGC_VALIDATION_QUEUE_NAME,
  connection: "AzureWebJobsStorage",
  handler: igcValidationWorker,
});
