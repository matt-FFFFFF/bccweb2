// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { QueueClient } from "@azure/storage-queue";
import type { HttpResponseInit } from "@azure/functions";
import type { RescoreJob, RescoreJobMessage, Round, User } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAuthRequest, MockHttpRequest } from "../../__tests__/helpers/api.js";
import { getRegisteredHandler, getRegisteredQueueHandler } from "../../__tests__/helpers/setup.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { getPrivateBlobClient, readBlob, writePrivateBlob } from "../../lib/blob.js";
import { acquireActiveGuard, activeGuardPath, readJobStatus, RESCORE_QUEUE_NAME, writeJobStatus } from "../../lib/rescoreJob.js";

vi.mock("../../lib/igcScoring.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/igcScoring.js")>();
  return { ...actual, scoreIgc: vi.fn(actual.scoreIgc) };
});

vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  return { ...actual, recomputeSeason: vi.fn().mockResolvedValue(undefined) };
});

import { scoreIgc } from "../../lib/igcScoring.js";
import * as rescoreRoundModule from "../rescoreRound.js";
import "../igc.js";
import "../manualFlight.js";
import "../rescoreWorker.js";

const D3P = readFileSync(new URL("../../lib/__tests__/fixtures/igc/d3p.igc", import.meta.url));

const VALID_JUSTIFICATION = "GPS failed; distance measured from the task map.";

interface MixedRound { roundId: string; teamId: string; admin: User; coord: User; pilot: User }

function scored(distance: number) {
  return {
    distance,
    sanityFlags: [],
    scoredAt: new Date().toISOString(),
    scoredByVersion: "vitest-scorer",
    parserErrors: [],
  };
}

function queueClient(): QueueClient {
  const connectionString = process.env["AzureWebJobsStorage"];
  if (!connectionString) throw new Error("AzureWebJobsStorage missing in test setup");
  return new QueueClient(connectionString, RESCORE_QUEUE_NAME);
}

async function seedUser(roles: User["roles"], overrides: Partial<User> = {}): Promise<User> {
  const id = overrides.id ?? randomUUID();
  const email = overrides.email ?? `${roles[0]?.toLowerCase() ?? "user"}-${id.slice(0, 8)}@example.com`;
  const user: User = { id, email, roles, pilotId: overrides.pilotId ?? null, clubId: overrides.clubId ?? null, createdAt: new Date().toISOString() };
  await writePrivateBlob(`users/${id}.json`, user);
  return user;
}

function makeIgcRequest(user: User, roundId: string, teamId: string, place: number): MockHttpRequest {
  const req = makeAuthRequest(user.id, user.email, {
    method: "POST",
    params: { id: roundId, teamId, place: String(place) },
  });
  (req as unknown as { formData: () => Promise<FormData> }).formData = async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(D3P)], "d3p.igc", { type: "text/plain" }));
    return form;
  };
  return req;
}

async function callHttp(name: string, req: MockHttpRequest): Promise<HttpResponseInit> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`HTTP handler ${name} was not registered`);
  return entry.handler(req, invocationContext(name)) as Promise<HttpResponseInit>;
}

function invocationContext(functionName: string) {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), functionName };
}

function slot(placeInTeam: number, pilotId: string): Round["teams"][number]["pilots"][number] {
  return {
    placeInTeam, isScoring: true, status: "Filled", accountedFor: false, signToFly: false, noScore: false, pilotPoints: 0, pilotId, snapshot: null, flight: null,
  };
}

async function seedMixedRound(): Promise<MixedRound> {
  const roundId = randomUUID();
  const teamId = randomUUID();
  const clubId = randomUUID();
  const pilotIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [admin, coord, pilot] = await Promise.all([
    seedUser(["Admin"]),
    seedUser(["RoundsCoord"], { clubId }),
    seedUser(["Pilot"], { pilotId: pilotIds[0] }),
  ]);
  const round: Round = {
    id: roundId, date: "2019-06-15", status: "Locked", isLocked: true, maxTeams: 8, minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year: 2019 },
    teams: [{
      id: teamId,
      teamName: "A",
      club: { id: clubId, name: "Test Club" },
      score: 0,
      pilots: pilotIds.map((pilotId, index) => slot(index + 1, pilotId)),
    }],
  };
  await writePrivateBlob(`rounds/${roundId}.json`, round);

  expect((await callHttp("uploadIgc", makeIgcRequest(admin, roundId, teamId, 1))).status).toBe(200);
  expect((await callHttp("uploadIgc", makeIgcRequest(admin, roundId, teamId, 2))).status).toBe(200);
  const manual = await callHttp("recordManualFlight", makeAuthRequest(admin.id, admin.email, {
    method: "POST",
    params: { id: roundId, teamId, place: "3" },
    body: { distance: 33, manualLogJustification: VALID_JUSTIFICATION },
  }));
  expect(manual.status).toBe(200);
  return { roundId, teamId, admin, coord, pilot };
}

function rescoreMessage(job: RescoreJob): RescoreJobMessage {
  return {
    jobId: job.jobId, roundId: job.roundId, requestedAt: job.requestedAt,
  };
}

async function seedQueuedJob(roundId: string, admin: User): Promise<RescoreJob> {
  const job: RescoreJob = { jobId: randomUUID(), roundId, status: "queued", requestedByEmail: admin.email, requestedAt: new Date().toISOString() };
  await writeJobStatus(job);
  await acquireActiveGuard(roundId);
  return job;
}

async function receiveQueuedMessage(): Promise<RescoreJobMessage> {
  const received = await queueClient().receiveMessages({ numberOfMessages: 1, visibilityTimeout: 1 });
  const message = received.receivedMessageItems[0];
  if (!message) throw new Error("Expected a message on rescore-jobs");
  return JSON.parse(Buffer.from(message.messageText, "base64").toString("utf8")) as RescoreJobMessage;
}

async function auditBlobCount(roundId: string): Promise<number> {
  let count = 0;
  for await (const blob of getPrivateContainer().listBlobsFlat({ prefix: `audit/rescore/${roundId}-` })) {
    if (blob.name.endsWith(".json")) count += 1;
  }
  return count;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(scoreIgc).mockReset().mockResolvedValue(scored(10));
  const client = queueClient();
  await client.createIfNotExists();
  await client.clearMessages();
});

describe("rescore enqueue/status/worker async chain", () => {
  it("enqueues for Admin on a Locked round, guards duplicates, and rejects non-admin roles", async () => {
    vi.mocked(scoreIgc)
      .mockResolvedValueOnce(scored(11))
      .mockResolvedValueOnce(scored(22));
    const ctx = await seedMixedRound();

    const first = await callHttp("rescoreRound", makeAuthRequest(ctx.admin.id, ctx.admin.email, {
      method: "POST",
      params: { id: ctx.roundId },
      headers: { "x-forwarded-for": "203.0.113.7" },
    }));
    expect(first.status).toBe(202);
    const jobId = (first.jsonBody as { jobId: string }).jobId;
    expect((await readJobStatus(jobId))?.status).toBe("queued");
    expect(await receiveQueuedMessage()).toMatchObject({ jobId, roundId: ctx.roundId });

    const duplicate = await callHttp("rescoreRound", makeAuthRequest(ctx.admin.id, ctx.admin.email, {
      method: "POST",
      params: { id: ctx.roundId },
    }));
    expect(duplicate.status).toBe(409);
    expect((duplicate.jsonBody as { code: string }).code).toBe("RESCORE_IN_PROGRESS");

    expect((await callHttp("rescoreRound", makeAuthRequest(ctx.coord.id, ctx.coord.email, { method: "POST", params: { id: ctx.roundId } }))).status).toBe(403);
    expect((await callHttp("rescoreRound", makeAuthRequest(ctx.pilot.id, ctx.pilot.email, { method: "POST", params: { id: ctx.roundId } }))).status).toBe(403);
  });

  it("completes a mixed queued job, updates flights, writes audit, and releases the guard", async () => {
    vi.mocked(scoreIgc)
      .mockResolvedValueOnce(scored(11))
      .mockResolvedValueOnce(scored(22))
      .mockResolvedValueOnce(scored(101))
      .mockResolvedValueOnce(scored(202));
    const ctx = await seedMixedRound();
    const job = await seedQueuedJob(ctx.roundId, ctx.admin);
    const worker = getRegisteredQueueHandler("rescoreWorker");

    await expect(worker.handler(rescoreMessage(job), invocationContext("rescoreWorker"))).resolves.toBeUndefined();

    const finished = await readJobStatus(job.jobId);
    expect(finished?.status).toBe("completed");
    expect(finished?.counts).toEqual({ rescoredCount: 2, skippedManualCount: 1, skippedNoIgcCount: 1, skippedBudgetCount: 0, errorCount: 0 });
    const round = await readBlob(getPrivateBlobClient(`rounds/${ctx.roundId}.json`)) as Round;
    expect(round?.teams[0]?.pilots[0]?.flight?.distance).toBe(101);
    expect(round?.teams[0]?.pilots[1]?.flight?.distance).toBe(202);
    expect(await auditBlobCount(ctx.roundId)).toBe(1);
    expect(await getPrivateContainer().getBlobClient(activeGuardPath(ctx.roundId)).exists()).toBe(false);
  });

  it("marks failed and releases the guard when runRescoreJob throws without rejecting the queue handler", async () => {
    const ctx = await seedMixedRound();
    const job = await seedQueuedJob(ctx.roundId, ctx.admin);
    vi.spyOn(rescoreRoundModule, "runRescoreJob").mockRejectedValueOnce(new Error("boom"));
    const worker = getRegisteredQueueHandler("rescoreWorker");

    await expect(worker.handler(rescoreMessage(job), invocationContext("rescoreWorker"))).resolves.toBeUndefined();

    expect((await readJobStatus(job.jobId))?.status).toBe("failed");
    expect(await getPrivateContainer().getBlobClient(activeGuardPath(ctx.roundId)).exists()).toBe(false);
  });

  it("marks partial when the rescore loop exhausts its budget", async () => {
    vi.mocked(scoreIgc)
      .mockResolvedValueOnce(scored(11))
      .mockResolvedValueOnce(scored(22))
      .mockResolvedValueOnce(scored(101));
    const ctx = await seedMixedRound();
    const job = await seedQueuedJob(ctx.roundId, ctx.admin);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
      .mockReturnValue(1_000 + 8 * 60_000 + 1);

    await getRegisteredQueueHandler("rescoreWorker").handler(rescoreMessage(job), invocationContext("rescoreWorker"));

    const finished = await readJobStatus(job.jobId);
    expect(finished?.status).toBe("partial");
    expect(finished?.counts?.skippedBudgetCount).toBeGreaterThan(0);
    // Only the IGC-bearing slot pushed past budget counts as budget-skipped; the
    // manual + no-IGC slots are classified by their own reason, not the budget.
    expect(finished?.counts?.skippedManualCount).toBe(1);
    expect(finished?.counts?.skippedNoIgcCount).toBe(1);
  });

  it("returns status to Admin and hides unknown, mismatched, and non-admin job lookups", async () => {
    const admin = await seedUser(["Admin"]);
    const pilot = await seedUser(["Pilot"], { pilotId: randomUUID() });
    const roundId = randomUUID();
    const otherRoundId = randomUUID();
    const job: RescoreJob = { jobId: randomUUID(), roundId, status: "queued", requestedByEmail: admin.email, requestedAt: new Date().toISOString() };
    await writeJobStatus(job);

    const ok = await callHttp("getRescoreJob", makeAuthRequest(admin.id, admin.email, { method: "GET", params: { id: roundId, jobId: job.jobId } }));
    expect(ok.status).toBe(200);
    expect(ok.jsonBody).toEqual(job);
    expect((await callHttp("getRescoreJob", makeAuthRequest(admin.id, admin.email, { method: "GET", params: { id: roundId, jobId: randomUUID() } }))).status).toBe(404);
    expect((await callHttp("getRescoreJob", makeAuthRequest(admin.id, admin.email, { method: "GET", params: { id: otherRoundId, jobId: job.jobId } }))).status).toBe(404);
    expect((await callHttp("getRescoreJob", makeAuthRequest(pilot.id, pilot.email, { method: "GET", params: { id: roundId, jobId: job.jobId } }))).status).toBe(403);
  });
});

afterEach(() => vi.restoreAllMocks());
