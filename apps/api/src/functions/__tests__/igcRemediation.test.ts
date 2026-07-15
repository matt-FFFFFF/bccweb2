// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type {
  Flight,
  IgcValidationJob,
  Round,
  Season,
  SeasonResults,
  User,
} from "@bccweb/types";
import { ConfigSchema } from "@bccweb/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

const leaseHook = vi.hoisted(() => ({
  beforePrivateRenewing: null as null | ((path: string) => Promise<void>),
}));
const jobMock = vi.hoisted(() => ({ enqueue: vi.fn() }));
const recomputeMock = vi.hoisted(() => ({ recompute: vi.fn() }));

vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withPrivateLeaseRenewing: async <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withPrivateLeaseRenewing>[2] = {},
    ) => {
      const hook = leaseHook.beforePrivateRenewing;
      if (hook) {
        leaseHook.beforePrivateRenewing = null;
        await hook(path);
      }
      return actual.withPrivateLeaseRenewing(path, fn, opts);
    },
  };
});

vi.mock("../../lib/igcValidationJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/igcValidationJob.js")>()),
  enqueueIgcValidation: jobMock.enqueue,
}));

vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  recomputeMock.recompute.mockImplementation(actual.recomputeSeason);
  return { ...actual, recomputeSeason: recomputeMock.recompute };
});

import { invoke, invokeQueue, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { writeValidationResult } from "../../lib/igcValidationJob.js";
import "../igc.js";
import "../igcValidationWorker.js";

type SeededRemediation = {
  readonly roundId: string;
  readonly teamId: string;
  readonly place: number;
  readonly pilotId: string;
  readonly clubId: string;
  readonly flightId: string;
  readonly attemptId: string;
  readonly path: string;
  readonly year: number;
};

function makeRound(seed: SeededRemediation, status: Round["status"]): Round {
  return {
    id: seed.roundId,
    date: `${seed.year}-06-29`,
    status,
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    organisingClub: { id: seed.clubId, name: "North Club" },
    season: { year: seed.year },
    teams: [{
      id: seed.teamId,
      teamName: "Alpha",
      club: { id: seed.clubId, name: "North Club" },
      score: 0,
      pilots: [{
        placeInTeam: seed.place,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: true,
        noScore: false,
        pilotPoints: 0,
        pilotId: seed.pilotId,
        snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
        flight: {
          id: seed.flightId,
          distance: 42,
          scoringType: "XC",
          score: 0,
          wingFactor: 0,
          isManualLog: false,
          igcPath: `flight-igcs/${seed.roundId}/${seed.pilotId}/${seed.flightId}.igc`,
          validation: {
            signature: "invalid",
            date: "valid",
            validationAttemptId: seed.attemptId,
            faiStatus: "FAILED",
          },
        },
      }],
    }],
  };
}

async function seedRemediation(
  options: {
    readonly enabled?: boolean;
    readonly status?: Round["status"];
  } = {},
): Promise<SeededRemediation> {
  const year = 2700 + Math.floor(Math.random() * 5_000);
  const roundId = randomUUID();
  const seed: SeededRemediation = {
    roundId,
    teamId: randomUUID(),
    place: 1,
    pilotId: randomUUID(),
    clubId: randomUUID(),
    flightId: randomUUID(),
    attemptId: randomUUID(),
    path: `rounds/${roundId}.json`,
    year,
  };
  const round = makeRound(seed, options.status ?? "Locked");
  await writePrivateJson(seed.path, round);
  await writePrivateJson(
    "config.json",
    ConfigSchema.parse({
      flightSignatureValidationEnabled: options.enabled ?? true,
      flightDateValidationEnabled: true,
    }),
  );
  if (round.status === "Complete") {
    const season: Season = {
      id: `season-${year}`,
      year,
      active: true,
      rounds: [roundId],
      leagueTable: [],
    };
    await writePublicJson(`seasons/${year}.json`, season);
    await writePublicJson("pilots.json", [{ id: seed.pilotId, name: "Pilot One" }]);
  }
  return seed;
}

function paramsFor(seed: SeededRemediation): Record<string, string> {
  return {
    id: seed.roundId,
    teamId: seed.teamId,
    place: String(seed.place),
  };
}

function requestFor(seed: SeededRemediation, user: User) {
  return makeAuthRequest(user.id, user.email, {
    method: "POST",
    params: paramsFor(seed),
  });
}

async function storedRound(seed: SeededRemediation): Promise<Round> {
  const round = await readPrivateJson<Round>(seed.path);
  if (!round) throw new Error("remediation round missing");
  return round;
}

function storedFlight(round: Round): Flight {
  const flight = round.teams[0]?.pilots[0]?.flight;
  if (!flight) throw new Error("remediation flight missing");
  return flight;
}

beforeEach(() => {
  leaseHook.beforePrivateRenewing = null;
  jobMock.enqueue.mockReset().mockResolvedValue(undefined);
  recomputeMock.recompute.mockClear();
});

describe("revalidateIgc", () => {
  it("allows an Admin to mint and enqueue a fresh validation attempt", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    const flight = storedFlight(await storedRound(seed));
    expect(flight.validation?.signature).toBe("pending");
    expect(flight.validation?.validationAttemptId).not.toBe(seed.attemptId);
    expect(jobMock.enqueue).toHaveBeenCalledWith({
      roundId: seed.roundId,
      teamId: seed.teamId,
      place: seed.place,
      flightId: seed.flightId,
      validationAttemptId: flight.validation?.validationAttemptId,
    });
  });

  it("clears prior attempt metadata while preserving date and override state", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    storedFlight(round).validation = {
      signature: "invalid",
      date: "valid",
      validationAttemptId: seed.attemptId,
      checkedAt: "2026-07-14T12:00:00.000Z",
      faiStatus: "FAILED",
      faiServer: "vali.example.test",
      faiMsg: "Previous attempt failed",
      overridden: true,
      overriddenBy: user.email,
      overriddenAt: "2026-07-14T12:01:00.000Z",
    };
    await writePrivateJson(seed.path, round);

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    const validation = storedFlight(await storedRound(seed)).validation;
    expect(validation).toMatchObject({
      signature: "pending",
      date: "valid",
      overridden: true,
      overriddenBy: user.email,
      overriddenAt: "2026-07-14T12:01:00.000Z",
    });
    expect(validation?.validationAttemptId).not.toBe(seed.attemptId);
    expect(validation).not.toHaveProperty("checkedAt");
    expect(validation).not.toHaveProperty("faiStatus");
    expect(validation).not.toHaveProperty("faiServer");
    expect(validation).not.toHaveProperty("faiMsg");
  });

  it("allows a coordinator scoped to the organising club", async () => {
    const seed = await seedRemediation();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: seed.clubId });

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
  });

  it.each([
    ["another-club coordinator", ["RoundsCoord"] as const, randomUUID()],
    ["Pilot", ["Pilot"] as const, null],
  ])("rejects a %s", async (_label, roles, clubId) => {
    const seed = await seedRemediation();
    const { user } = await makeUser({ roles: [...roles], clubId });

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(403);
    expect(jobMock.enqueue).not.toHaveBeenCalled();
  });

  it("returns SIGNATURE_VALIDATION_DISABLED without enqueue when the gate is off", async () => {
    const seed = await seedRemediation({ enabled: false });
    const { user } = await bootstrapAdmin();

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("SIGNATURE_VALIDATION_DISABLED");
    expect(jobMock.enqueue).not.toHaveBeenCalled();
  });

  it("captures the replacement flight ID from inside the lease", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const replacementFlightId = randomUUID();
    leaseHook.beforePrivateRenewing = async (path) => {
      if (path !== seed.path) return;
      const round = await storedRound(seed);
      const flight = storedFlight(round);
      flight.id = replacementFlightId;
      flight.igcPath = `flight-igcs/${seed.roundId}/${seed.pilotId}/${replacementFlightId}.igc`;
      await writePrivateJson(seed.path, round);
    };

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect(jobMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      flightId: replacementFlightId,
    }));
    expect(storedFlight(await storedRound(seed)).validation?.signature).toBe("pending");
  });

  it("marks only the failed current attempt unverified when enqueue fails", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    const validation = storedFlight(round).validation;
    if (!validation) throw new Error("seeded validation missing");
    validation.checkedAt = "2026-07-14T12:00:00.000Z";
    validation.faiServer = "vali.example.test";
    validation.faiMsg = "Previous attempt failed";
    await writePrivateJson(seed.path, round);
    jobMock.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    const failedValidation = storedFlight(await storedRound(seed)).validation;
    expect(failedValidation).toMatchObject({
      signature: "unverified",
      faiStatus: "ENQUEUE_FAILED",
    });
    expect(failedValidation).not.toHaveProperty("checkedAt");
    expect(failedValidation).not.toHaveProperty("faiServer");
    expect(failedValidation).not.toHaveProperty("faiMsg");
  });

  it("re-scores and republishes a Complete round when enqueue failure makes the flight unverified", async () => {
    const seed = await seedRemediation({ status: "Complete" });
    const { user } = await bootstrapAdmin();
    jobMock.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    const round = await storedRound(seed);
    expect(storedFlight(round).validation).toMatchObject({
      signature: "unverified",
      faiStatus: "ENQUEUE_FAILED",
    });
    expect(round.teams[0]?.pilots[0]?.pilotPoints).toBeGreaterThan(0);
    expect(round.teams[0]?.score).toBeGreaterThan(0);
    expect(recomputeMock.recompute).toHaveBeenCalledWith(seed.year);
    const results = await readPublicJson<SeasonResults>(`results/${seed.year}.json`);
    expect(results?.[0]?.teamResults[0]?.score).toBeGreaterThan(0);
  });

  it("re-scores an enqueue failure using the current config", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    const validation = storedFlight(round).validation;
    if (!validation) throw new Error("seeded validation missing");
    validation.date = "invalid";
    await writePrivateJson(seed.path, round);
    jobMock.enqueue.mockImplementationOnce(async () => {
      await writePrivateJson(
        "config.json",
        ConfigSchema.parse({
          flightSignatureValidationEnabled: true,
          flightDateValidationEnabled: false,
        }),
      );
      throw new Error("queue unavailable");
    });

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect(storedFlight(await storedRound(seed)).validation).toMatchObject({
      signature: "unverified",
      date: "invalid",
      faiStatus: "ENQUEUE_FAILED",
    });
    expect((await storedRound(seed)).teams[0]?.pilots[0]?.pilotPoints).toBeGreaterThan(0);
  });

  it("does not downgrade a newer attempt when an older enqueue fails", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const newerAttemptId = randomUUID();
    jobMock.enqueue.mockImplementationOnce(async () => {
      const round = await storedRound(seed);
      const flight = storedFlight(round);
      flight.validation = {
        ...flight.validation,
        signature: "pending",
        validationAttemptId: newerAttemptId,
      };
      await writePrivateJson(seed.path, round);
      throw new Error("older enqueue failed");
    });

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect(storedFlight(await storedRound(seed)).validation).toMatchObject({
      signature: "pending",
      validationAttemptId: newerAttemptId,
    });
  });

  it("rejects a manual flight carrying a stale IGC path without mutation or enqueue", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    storedFlight(round).isManualLog = true;
    await writePrivateJson(seed.path, round);
    const before = await storedRound(seed);

    const res = await invoke("revalidateIgc", requestFor(seed, user));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("MANUAL_FLIGHT_NOT_REVALIDATABLE");
    expect(await storedRound(seed)).toEqual(before);
    expect(jobMock.enqueue).not.toHaveBeenCalled();
  });
});

describe("allowIgc", () => {
  it("returns NOT_FOUND when the round does not exist", async () => {
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id: randomUUID(), teamId: randomUUID(), place: "1" },
    });

    const res = await invoke("allowIgc", req);

    expect(res.status).toBe(404);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_FOUND");
  });

  it("allows an Admin to override an invalid flight and restore its score", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    const round = await storedRound(seed);
    const flight = storedFlight(round);
    expect(flight.validation).toMatchObject({
      overridden: true,
      overriddenBy: user.id,
      overriddenAt: expect.any(String),
    });
    expect(round.teams[0]?.pilots[0]?.pilotPoints).toBeGreaterThan(0);
    expect(round.teams[0]?.score).toBeGreaterThan(0);
    expect(round.scoring?.scoredAt).toEqual(expect.any(String));
  });

  it("scores an override using the config current inside the lease", async () => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    const team = round.teams[0];
    if (!team) throw new Error("seeded team missing");
    team.pilots.push({
      placeInTeam: 2,
      isScoring: true,
      status: "Filled",
      accountedFor: false,
      signToFly: true,
      noScore: false,
      pilotPoints: 0,
      pilotId: randomUUID(),
      snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
      flight: {
        id: randomUUID(),
        distance: 21,
        scoringType: "XC",
        score: 0,
        wingFactor: 0,
        isManualLog: false,
        validation: { signature: "invalid", date: "valid" },
      },
    });
    await writePrivateJson(seed.path, round);
    leaseHook.beforePrivateRenewing = async (path) => {
      if (path !== seed.path) return;
      await writePrivateJson(
        "config.json",
        ConfigSchema.parse({
          flightSignatureValidationEnabled: false,
          flightDateValidationEnabled: true,
        }),
      );
    };

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect((await storedRound(seed)).teams[0]?.pilots[1]?.pilotPoints).toBeGreaterThan(0);
  });

  it.each(["RoundsCoord", "Pilot"] as const)("rejects a %s override", async (role) => {
    const seed = await seedRemediation();
    const { user } = await makeUser({ roles: [role], clubId: seed.clubId });

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(403);
    expect(storedFlight(await storedRound(seed)).validation?.overridden).toBeUndefined();
  });

  it.each([
    ["valid", { signature: "valid", date: "valid" }, false],
    ["pending", { signature: "pending", date: "valid" }, false],
    ["unverified", { signature: "unverified", date: "valid" }, false],
    ["absent validation", undefined, false],
    ["manual invalid", { signature: "invalid", date: "valid" }, true],
  ] as const)("rejects a %s flight without rescore or mutation", async (_label, validation, manual) => {
    const seed = await seedRemediation();
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    const flight = storedFlight(round);
    flight.isManualLog = manual;
    flight.validation = validation === undefined ? undefined : { ...validation };
    await writePrivateJson(seed.path, round);
    const before = await storedRound(seed);

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("FLIGHT_NOT_ALLOWABLE");
    expect(await storedRound(seed)).toEqual(before);
    expect(recomputeMock.recompute).not.toHaveBeenCalled();
  });

  it("re-scores and republishes an already-overridden Complete round", async () => {
    const seed = await seedRemediation({ status: "Complete" });
    const { user } = await bootstrapAdmin();
    const round = await storedRound(seed);
    const validation = storedFlight(round).validation;
    if (!validation) throw new Error("seeded validation missing");
    validation.overridden = true;
    validation.overriddenBy = user.email;
    validation.overriddenAt = "2026-07-14T12:01:00.000Z";
    await writePrivateJson(seed.path, round);

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect(recomputeMock.recompute).toHaveBeenCalledWith(seed.year);
    expect(storedFlight(await storedRound(seed)).validation).toMatchObject({
      overridden: true,
      overriddenBy: user.email,
      overriddenAt: "2026-07-14T12:01:00.000Z",
    });
    const results = await readPublicJson<SeasonResults>(`results/${seed.year}.json`);
    expect(results?.[0]?.teamResults[0]?.score).toBeGreaterThan(0);
  });

  it("recomputes a Complete round into season results", async () => {
    const seed = await seedRemediation({ status: "Complete" });
    const { user } = await bootstrapAdmin();

    const res = await invoke("allowIgc", requestFor(seed, user));

    expect(res.status).toBe(200);
    expect(recomputeMock.recompute).toHaveBeenCalledWith(seed.year);
    const results = await readPublicJson<SeasonResults>(`results/${seed.year}.json`);
    expect(results?.[0]?.teamResults[0]?.score).toBeGreaterThan(0);
  });

  it("returns 503 after a committed override and completes recompute on retry", async () => {
    const seed = await seedRemediation({ status: "Complete" });
    const { user } = await bootstrapAdmin();
    recomputeMock.recompute.mockRejectedValueOnce(new Error("derived publication failed"));

    const failed = await invoke("allowIgc", requestFor(seed, user));

    expect(failed.status).toBe(503);
    const firstValidation = storedFlight(await storedRound(seed)).validation;
    expect(firstValidation?.overridden).toBe(true);

    recomputeMock.recompute.mockClear();
    const retried = await invoke("allowIgc", requestFor(seed, user));

    expect(retried.status).toBe(200);
    expect(storedFlight(await storedRound(seed)).validation).toMatchObject({
      overriddenBy: firstValidation?.overriddenBy,
      overriddenAt: firstValidation?.overriddenAt,
    });
    expect(recomputeMock.recompute).toHaveBeenCalledWith(seed.year);
    const results = await readPublicJson<SeasonResults>(`results/${seed.year}.json`);
    expect(results?.[0]?.teamResults[0]?.score).toBeGreaterThan(0);
  });

  it("converges when an allow overlaps a terminal worker update on a Complete round", async () => {
    const seed = await seedRemediation({ status: "Complete" });
    const { user } = await bootstrapAdmin();
    const job: IgcValidationJob = {
      roundId: seed.roundId,
      teamId: seed.teamId,
      place: seed.place,
      flightId: seed.flightId,
      validationAttemptId: seed.attemptId,
    };
    await writeValidationResult(seed.attemptId, { signature: "invalid", faiStatus: "FAILED" });
    let worker: Promise<unknown> | undefined;
    const realRecompute = recomputeMock.recompute.getMockImplementation();
    if (!realRecompute) throw new Error("real recompute implementation missing");
    recomputeMock.recompute.mockImplementationOnce(async (year: number) => {
      worker = invokeQueue("igcValidationWorker", job);
      await realRecompute(year);
    });

    const allowed = await invoke("allowIgc", requestFor(seed, user));
    await worker;

    expect(allowed.status).toBe(200);
    const round = await storedRound(seed);
    expect(storedFlight(round).validation?.overridden).toBe(true);
    expect(round.teams[0]?.score).toBeGreaterThan(0);
    const season = await readPublicJson<Season>(`seasons/${seed.year}.json`);
    const results = await readPublicJson<SeasonResults>(`results/${seed.year}.json`);
    expect(season?.leagueTable[0]?.totalScore).toBe(round.teams[0]?.score);
    expect(results?.[0]?.teamResults[0]?.score).toBe(round.teams[0]?.score);
  });
});
