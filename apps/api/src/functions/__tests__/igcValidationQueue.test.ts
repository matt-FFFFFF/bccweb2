// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { FlightValidation, IgcValidationJob, Round, SeasonResults } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faiMock = vi.hoisted(() => ({ validate: vi.fn() }));
const jobMock = vi.hoisted(() => ({
  actualRecord: vi.fn(),
  actualWait: vi.fn(),
  enqueue: vi.fn(),
  record: vi.fn(),
  wait: vi.fn(),
}));
const recomputeMock = vi.hoisted(() => ({ recompute: vi.fn() }));
const telemetryMock = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock("../../lib/faiVali.js", () => ({ validateIgcSignature: faiMock.validate }));
vi.mock("../../lib/igcValidationJob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/igcValidationJob.js")>();
  jobMock.actualRecord.mockImplementation(actual.recordFaiCallStart);
  jobMock.actualWait.mockImplementation(actual.waitForPace);
  return {
    ...actual,
    enqueueIgcValidation: jobMock.enqueue,
    recordFaiCallStart: jobMock.record,
    waitForPace: jobMock.wait,
  };
});
vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  recomputeMock.recompute.mockImplementation(actual.recomputeSeason);
  return { ...actual, recomputeSeason: recomputeMock.recompute };
});
vi.mock("../../lib/telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telemetry.js")>();
  return { ...actual, getTelemetryClient: () => telemetryMock };
});

import { invokeQueue } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import * as blobJson from "../../lib/blobJson.js";
import {
  acquireIgcValidationGuard,
  readValidationResult,
  releaseIgcValidationGuard,
  writeValidationResult,
} from "../../lib/igcValidationJob.js";
import * as blobModule from "../../lib/blob.js";
import { getRegisteredQueueHandler } from "../../__tests__/helpers/setup.js";
import "../igcValidationWorker.js";

type SeededValidation = {
  readonly job: IgcValidationJob;
  readonly path: string;
  readonly igcPath: string;
};

const config = (enabled: boolean) => ({ flightSignatureValidationEnabled: enabled });

function validationRound(job: IgcValidationJob, status: Round["status"]): Round {
  return {
    id: job.roundId,
    date: "2026-06-29",
    status,
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    season: { year: 2026 },
    teams: [{
      id: job.teamId,
      teamName: "Alpha",
      club: { id: "club-1", name: "North Club" },
      score: 100,
      pilots: [{
        placeInTeam: job.place,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: true,
        noScore: false,
        pilotPoints: 100,
        pilotId: "pilot-1",
        snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
        flight: {
          id: job.flightId,
          distance: 42,
          scoringType: "XC",
          score: 42,
          wingFactor: 1,
          isManualLog: false,
          igcPath: `flight-igcs/${job.roundId}/pilot-1/${job.flightId}.igc`,
          validation: {
            signature: "pending",
            date: "valid",
            validationAttemptId: job.validationAttemptId,
          },
        },
      }],
    }],
  };
}

async function seedValidation(
  options: { readonly status?: Round["status"]; readonly enabled?: boolean } = {},
): Promise<SeededValidation> {
  const job: IgcValidationJob = {
    roundId: randomUUID(),
    teamId: randomUUID(),
    place: 1,
    flightId: randomUUID(),
    validationAttemptId: randomUUID(),
  };
  const round = validationRound(job, options.status ?? "Locked");
  const path = `rounds/${job.roundId}.json`;
  const igcPath = round.teams[0]?.pilots[0]?.flight?.igcPath;
  if (igcPath === undefined) throw new Error("Validation fixture has no immutable IGC path");
  await writePrivateJson(path, round);
  await writePrivateJson("config.json", config(options.enabled ?? true));
  await getPrivateContainer().getBlockBlobClient(igcPath).uploadData(Buffer.from("immutable-igc"));
  if (round.status === "Complete") {
    await writePublicJson(`seasons/${round.season.year}.json`, {
      id: `season-${round.season.year}`,
      year: round.season.year,
      active: true,
      rounds: [round.id],
      leagueTable: [],
    });
  }
  return { job, path, igcPath };
}

async function persistedRound(seed: SeededValidation): Promise<Round> {
  const round = await readPrivateJson<Round>(seed.path);
  if (round === null) throw new Error("Seeded validation round disappeared");
  return round;
}

function currentValidation(round: Round): FlightValidation | undefined {
  return round.teams[0]?.pilots[0]?.flight?.validation;
}

beforeEach(() => {
  vi.clearAllMocks();
  jobMock.record.mockResolvedValue(new Date("2026-07-14T12:00:00.000Z"));
  jobMock.wait.mockResolvedValue(undefined);
  jobMock.enqueue.mockResolvedValue(undefined);
  faiMock.validate.mockResolvedValue({ signature: "valid", faiStatus: "PASSED" });
});

afterEach(() => vi.restoreAllMocks());

describe("igcValidationWorker queue transaction", () => {
  it("ACKs malformed input without logging its untrusted contents", async () => {
    const secret = { unexpectedPii: "pilot@example.com" };
    const ctx = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), functionName: "igcValidationWorker" };

    await getRegisteredQueueHandler("igcValidationWorker").handler(secret, ctx);

    expect(ctx.warn).toHaveBeenCalledWith("[igcValidationWorker] malformed IGC validation message");
    expect(ctx.warn).not.toHaveBeenCalledWith(expect.anything(), secret);
    expect(faiMock.validate).not.toHaveBeenCalled();
  });

  it.each([
    ["valid", { signature: "valid", faiStatus: "PASSED", faiServer: "vali-1", faiMsg: "ok" }, 100],
    ["invalid", { signature: "invalid", faiStatus: "FAILED" }, 0],
    ["unverified timeout", { signature: "unverified", faiStatus: "TIMEOUT" }, 100],
  ] as const)("applies a %s FAI result and re-scores the round", async (_name, result, points) => {
    const seed = await seedValidation();
    faiMock.validate.mockResolvedValueOnce(result);

    await invokeQueue("igcValidationWorker", seed.job);

    const round = await persistedRound(seed);
    expect(currentValidation(round)).toMatchObject({
      ...result,
      date: "valid",
      validationAttemptId: seed.job.validationAttemptId,
      checkedAt: expect.any(String),
    });
    expect(round.teams[0]?.pilots[0]?.pilotPoints).toBe(points);
    expect(round.teams[0]?.pilots[0]?.flight?.score).toBe(points === 0 ? 0 : 42);
    expect(round.scoring?.scoredAt).toEqual(expect.any(String));
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(await readPublicJson<Round[]>("rounds.json")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: seed.job.roundId })]),
    );
    expect(faiMock.validate).toHaveBeenCalledWith(Buffer.from("immutable-igc"), seed.igcPath.split("/").at(-1));
    expect(jobMock.wait).toHaveBeenCalledTimes(1);
    expect(jobMock.record).toHaveBeenCalledTimes(1);
    const guard = await acquireIgcValidationGuard();
    await releaseIgcValidationGuard(guard.leaseId);
  });

  it.each(["missing flight", "different flight", "superseded attempt"] as const)(
    "ACKs a stale job with %s before outbound work",
    async (staleKind) => {
      const seed = await seedValidation();
      const before = await persistedRound(seed);
      const slot = before.teams[0]?.pilots[0];
      if (slot === undefined) throw new Error("Validation fixture has no slot");
      if (staleKind === "missing flight") slot.flight = null;
      if (staleKind === "different flight" && slot.flight !== null) slot.flight.id = randomUUID();
      if (staleKind === "superseded attempt" && slot.flight?.validation !== undefined) {
        slot.flight.validation.validationAttemptId = randomUUID();
      }
      await writePrivateJson(seed.path, before);
      await writeValidationResult(seed.job.validationAttemptId, {
        signature: "invalid",
        faiStatus: "FAILED",
      });

      await invokeQueue("igcValidationWorker", seed.job);

      expect(await persistedRound(seed)).toEqual(before);
      expect(faiMock.validate).not.toHaveBeenCalled();
      expect(jobMock.wait).not.toHaveBeenCalled();
      expect(jobMock.record).not.toHaveBeenCalled();
      expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    },
  );

  it("ACKs a crafted matching manual-flight job before IGC or FAI egress", async () => {
    const seed = await seedValidation();
    const before = await persistedRound(seed);
    const flight = before.teams[0]?.pilots[0]?.flight;
    if (flight === null || flight === undefined) throw new Error("Validation fixture has no flight");
    flight.isManualLog = true;
    await writePrivateJson(seed.path, before);
    await writeValidationResult(seed.job.validationAttemptId, {
      signature: "invalid",
      faiStatus: "FAILED",
    });
    const readPaths: string[] = [];
    const realGetPrivateBlobClient = blobModule.getPrivateBlobClient;
    const clientSpy = vi.spyOn(blobModule, "getPrivateBlobClient").mockImplementation((path) => {
      const client = realGetPrivateBlobClient(path);
      const download = client.download.bind(client);
      vi.spyOn(client, "download").mockImplementation(async () => {
        readPaths.push(path);
        return download();
      });
      return client;
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(faiMock.validate).not.toHaveBeenCalled();
    expect(jobMock.wait).not.toHaveBeenCalled();
    expect(jobMock.record).not.toHaveBeenCalled();
    expect(readPaths).toEqual([seed.path]);
    clientSpy.mockRestore();
    expect(await persistedRound(seed)).toEqual(before);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("ACKs when the matching flight becomes manual after the initial guard check", async () => {
    const seed = await seedValidation();
    let converted: Round | null = null;
    const realGetPrivateBlobClient = blobModule.getPrivateBlobClient;
    vi.spyOn(blobModule, "getPrivateBlobClient").mockImplementation((path) => {
      const client = realGetPrivateBlobClient(path);
      if (path !== seed.igcPath) return client;
      const download = client.download.bind(client);
      vi.spyOn(client, "download").mockImplementation(async () => {
        const response = await download();
        const concurrent = await persistedRound(seed);
        const flight = concurrent.teams[0]?.pilots[0]?.flight;
        if (flight === null || flight === undefined) {
          throw new Error("Validation fixture has no flight");
        }
        flight.isManualLog = true;
        converted = concurrent;
        await writePrivateJson(seed.path, concurrent);
        return response;
      });
      return client;
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(faiMock.validate).not.toHaveBeenCalled();
    expect(jobMock.wait).toHaveBeenCalledTimes(1);
    expect(jobMock.record).not.toHaveBeenCalled();
    expect(await persistedRound(seed)).toEqual(converted);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("replays an already-terminal Complete attempt without FAI and recomputes results", async () => {
    const seed = await seedValidation({ status: "Complete" });
    const round = await persistedRound(seed);
    const validation = currentValidation(round);
    if (validation === undefined) throw new Error("Validation fixture has no validation state");
    validation.signature = "invalid";
    validation.faiStatus = "FAILED";
    await writePrivateJson(seed.path, round);

    await invokeQueue("igcValidationWorker", seed.job);

    const committed = await persistedRound(seed);
    expect(committed.teams[0]?.pilots[0]?.pilotPoints).toBe(0);
    expect(faiMock.validate).not.toHaveBeenCalled();
    expect(recomputeMock.recompute).toHaveBeenCalledWith(2026);
    const results = await readPublicJson<SeasonResults>("results/2026.json");
    expect(results?.[0]?.teamResults[0]?.score).toBe(0);
  });

  it("persists the FAI result before a failed apply and reuses it on retry", async () => {
    const seed = await seedValidation();
    faiMock.validate.mockResolvedValueOnce({ signature: "invalid", faiStatus: "FAILED" });
    vi.spyOn(blobJson, "writePrivateJson").mockRejectedValueOnce(new Error("injected apply failure"));

    await expect(invokeQueue("igcValidationWorker", seed.job)).rejects.toThrow("injected apply failure");
    expect(await readValidationResult(seed.job.validationAttemptId)).toMatchObject({ signature: "invalid" });
    const guard = await acquireIgcValidationGuard();
    await releaseIgcValidationGuard(guard.leaseId);

    await invokeQueue("igcValidationWorker", seed.job);

    expect(faiMock.validate).toHaveBeenCalledTimes(1);
    expect((await persistedRound(seed)).teams[0]?.pilots[0]?.pilotPoints).toBe(0);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("logs and ACKs a Complete-round recompute failure after committing", async () => {
    const seed = await seedValidation({ status: "Complete" });
    faiMock.validate.mockResolvedValueOnce({ signature: "invalid", faiStatus: "FAILED" });
    recomputeMock.recompute.mockRejectedValueOnce(new Error("derived failure"));
    const ctx = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), functionName: "igcValidationWorker" };

    await expect(getRegisteredQueueHandler("igcValidationWorker").handler(seed.job, ctx)).resolves.toBeUndefined();

    expect((await persistedRound(seed)).teams[0]?.pilots[0]?.pilotPoints).toBe(0);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("recomputeSeason(2026) failed"), expect.any(Error));
  });

  it("re-reads a toggled-off config after IGC download and records DISABLED", async () => {
    const seed = await seedValidation();
    const realGetPrivateBlobClient = blobModule.getPrivateBlobClient;
    vi.spyOn(blobModule, "getPrivateBlobClient").mockImplementation((path) => {
      const client = realGetPrivateBlobClient(path);
      if (path !== seed.igcPath) return client;
      const download = client.download.bind(client);
      vi.spyOn(client, "download").mockImplementation(async () => {
        const response = await download();
        await writePrivateJson("config.json", config(false));
        return response;
      });
      return client;
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "unverified",
      faiStatus: "DISABLED",
    });
    expect(faiMock.validate).not.toHaveBeenCalled();
  });

  it("skips FAI when validation is disabled during the pace wait", async () => {
    // Given
    const seed = await seedValidation();
    jobMock.wait.mockImplementationOnce(async () => {
      await writePrivateJson("config.json", config(false));
    });

    // When
    await invokeQueue("igcValidationWorker", seed.job);

    // Then
    expect(faiMock.validate).not.toHaveBeenCalled();
    expect(jobMock.record).not.toHaveBeenCalled();
    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "unverified",
      faiStatus: "DISABLED",
    });
  });

  it("spaces actual FAI calls after slow guarded preparation", async () => {
    // Given
    const first = await seedValidation();
    const second = await seedValidation();
    const faiCallTimes: number[] = [];
    const realGetPrivateBlobClient = blobModule.getPrivateBlobClient;
    vi.spyOn(blobModule, "getPrivateBlobClient").mockImplementation((path) => {
      const client = realGetPrivateBlobClient(path);
      if (path !== first.igcPath) return client;
      const download = client.download.bind(client);
      vi.spyOn(client, "download").mockImplementation(async () => {
        const response = await download();
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        return response;
      });
      return client;
    });
    jobMock.record.mockImplementation(jobMock.actualRecord);
    jobMock.wait.mockImplementation(jobMock.actualWait);
    faiMock.validate.mockImplementation(async () => {
      faiCallTimes.push(Date.now());
      return { signature: "valid", faiStatus: "PASSED" };
    });

    // When
    await invokeQueue("igcValidationWorker", first.job);
    await invokeQueue("igcValidationWorker", second.job);

    // Then
    expect(faiCallTimes).toHaveLength(2);
    expect((faiCallTimes[1] ?? 0) - (faiCallTimes[0] ?? 0)).toBeGreaterThanOrEqual(2_000);
    const properties = await getPrivateContainer()
      .getBlobClient("igc-validation/active.json")
      .getProperties();
    const persistedStartedAt = Date.parse(
      properties.metadata?.["lastcallstartedat"] ?? "",
    );
    expect(persistedStartedAt).toBeLessThanOrEqual(faiCallTimes[1] ?? 0);
    expect((faiCallTimes[1] ?? 0) - persistedStartedAt).toBeLessThan(1_000);
  }, 10_000);

  it("throws on a config storage failure instead of finalizing the attempt as DISABLED", async () => {
    const seed = await seedValidation();
    const storageError = Object.assign(new Error("config storage unavailable"), { statusCode: 503 });
    const originalReadJson = blobJson.readJson;
    vi.spyOn(blobJson, "readJson").mockImplementation((client, schema, path) => (
      path === "config.json" ? Promise.reject(storageError) : originalReadJson(client, schema, path)
    ));

    await expect(invokeQueue("igcValidationWorker", seed.job)).rejects.toBe(storageError);

    expect(currentValidation(await persistedRound(seed))?.signature).toBe("pending");
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(faiMock.validate).not.toHaveBeenCalled();
    const guard = await acquireIgcValidationGuard();
    await releaseIgcValidationGuard(guard.leaseId);
  });

  it("GCs the durable result when the attempt is superseded before leased apply", async () => {
    const seed = await seedValidation();
    const replacementAttemptId = randomUUID();
    faiMock.validate.mockImplementationOnce(async () => {
      const replacement = await persistedRound(seed);
      const validation = currentValidation(replacement);
      if (validation === undefined) throw new Error("Validation fixture has no validation state");
      validation.validationAttemptId = replacementAttemptId;
      await writePrivateJson(seed.path, replacement);
      return { signature: "invalid", faiStatus: "FAILED" };
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "pending",
      validationAttemptId: replacementAttemptId,
    });
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("GCs the durable result when the matching flight becomes manual before leased apply", async () => {
    const seed = await seedValidation();
    let converted: Round | null = null;
    faiMock.validate.mockImplementationOnce(async () => {
      const concurrent = await persistedRound(seed);
      const flight = concurrent.teams[0]?.pilots[0]?.flight;
      if (flight === null || flight === undefined) throw new Error("Validation fixture has no flight");
      flight.isManualLog = true;
      converted = concurrent;
      await writePrivateJson(seed.path, concurrent);
      return { signature: "invalid", faiStatus: "FAILED" };
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(await persistedRound(seed)).toEqual(converted);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("marks a pending matching attempt failed and GCs its result from the poison queue", async () => {
    const seed = await seedValidation();
    await writeValidationResult(seed.job.validationAttemptId, {
      signature: "invalid",
      faiStatus: "FAILED",
    });

    await invokeQueue("igcValidationPoison", seed.job);

    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "unverified",
      faiStatus: "WORKER_FAILED",
      date: "valid",
      validationAttemptId: seed.job.validationAttemptId,
    });
    expect((await persistedRound(seed)).teams[0]?.pilots[0]?.pilotPoints).toBe(100);
    expect(await readPublicJson<Round[]>("rounds.json")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: seed.job.roundId })]),
    );
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith({
      name: "igcValidation.poisonFailed",
      properties: {
        roundId: seed.job.roundId,
        teamId: seed.job.teamId,
        place: seed.job.place,
        flightId: seed.job.flightId,
        validationAttemptId: seed.job.validationAttemptId,
      },
    });
  });

  it("keeps poison failure terminal when an in-flight worker later finishes validation", async () => {
    const seed = await seedValidation();
    faiMock.validate.mockImplementationOnce(async () => {
      await invokeQueue("igcValidationPoison", seed.job);
      return { signature: "valid", faiStatus: "PASSED" };
    });

    await invokeQueue("igcValidationWorker", seed.job);

    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "unverified",
      faiStatus: "WORKER_FAILED",
      validationAttemptId: seed.job.validationAttemptId,
    });
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
  });

  it("recomputes Complete-round results after poison failure", async () => {
    const seed = await seedValidation({ status: "Complete" });

    await invokeQueue("igcValidationPoison", seed.job);

    expect(recomputeMock.recompute).toHaveBeenCalledWith(2026);
    const results = await readPublicJson<SeasonResults>("results/2026.json");
    expect(results?.[0]?.teamResults[0]?.score).toBe(100);
  });

  it("retries Complete-round derived results after a post-commit poison failure", async () => {
    const seed = await seedValidation({ status: "Complete" });
    recomputeMock.recompute.mockRejectedValueOnce(new Error("injected recompute failure"));

    await expect(invokeQueue("igcValidationPoison", seed.job)).rejects.toThrow(
      "injected recompute failure",
    );
    expect(currentValidation(await persistedRound(seed))).toMatchObject({
      signature: "unverified",
      faiStatus: "WORKER_FAILED",
    });

    await invokeQueue("igcValidationPoison", seed.job);

    expect(recomputeMock.recompute).toHaveBeenCalledTimes(2);
    const results = await readPublicJson<SeasonResults>("results/2026.json");
    expect(results?.[0]?.teamResults[0]?.score).toBe(100);
  });

  it("reconciles derived outputs for a matching terminal attempt from the poison queue", async () => {
    const seed = await seedValidation({ status: "Complete" });
    const committed = await persistedRound(seed);
    const validation = currentValidation(committed);
    if (validation === undefined) throw new Error("Validation fixture has no validation state");
    validation.signature = "valid";
    validation.faiStatus = "PASSED";
    await writePrivateJson(seed.path, committed);
    await writeValidationResult(seed.job.validationAttemptId, validation);

    await invokeQueue("igcValidationPoison", seed.job);

    expect(currentValidation(await persistedRound(seed))).toEqual(validation);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(recomputeMock.recompute).toHaveBeenCalledWith(2026);
    expect(await readPublicJson<Round[]>("rounds.json")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: seed.job.roundId })]),
    );
  });

  it("does not mutate a superseded flight when its old attempt reaches the poison queue", async () => {
    const seed = await seedValidation();
    const superseded = await persistedRound(seed);
    const validation = currentValidation(superseded);
    if (validation === undefined) throw new Error("Validation fixture has no validation state");
    validation.validationAttemptId = randomUUID();
    await writePrivateJson(seed.path, superseded);
    await writeValidationResult(seed.job.validationAttemptId, {
      signature: "invalid",
      faiStatus: "FAILED",
    });

    await invokeQueue("igcValidationPoison", seed.job);

    expect(await persistedRound(seed)).toEqual(superseded);
    expect(await readValidationResult(seed.job.validationAttemptId)).toBeNull();
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith({
      name: "igcValidation.poisonStale",
      properties: {
        roundId: seed.job.roundId,
        teamId: seed.job.teamId,
        place: seed.job.place,
        flightId: seed.job.flightId,
        validationAttemptId: seed.job.validationAttemptId,
      },
    });
  });

  it("ACKs an unparseable poison message with redacted telemetry", async () => {
    const secret = "pilot@example.com";

    await invokeQueue("igcValidationPoison", `{\"unexpectedPii\":\"${secret}\"}`);

    expect(telemetryMock.trackEvent).toHaveBeenCalledWith({
      name: "igcValidation.poisonUnparseable",
      properties: {},
    });
    expect(JSON.stringify(telemetryMock.trackEvent.mock.calls)).not.toContain(secret);
  });

  it("re-enqueues with delay when the mandatory global guard is contended", async () => {
    const seed = await seedValidation();
    const guard = await acquireIgcValidationGuard();
    try {
      await invokeQueue("igcValidationWorker", seed.job);
    } finally {
      await releaseIgcValidationGuard(guard.leaseId);
    }

    expect(jobMock.enqueue).toHaveBeenCalledWith(seed.job, { visibilityTimeoutSeconds: 5 });
    expect(faiMock.validate).not.toHaveBeenCalled();
    expect(currentValidation(await persistedRound(seed))?.signature).toBe("pending");
  });
});
