import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpResponseInit } from "@azure/functions";
import type { Round, RoundBrief } from "@bccweb/types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeRound,
  makeUser,
  readPrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";

const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 test")),
}));
vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

import "../brief.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const RED_GREEN_EVIDENCE = path.join(EVIDENCE_DIR, "task-9-updateRoundBrief-403.txt");
const PRESERVATION_EVIDENCE = path.join(EVIDENCE_DIR, "task-9-brief-409-dryrun.txt");

interface Observation {
  label: string;
  status: number;
  code?: string;
  retryAfter?: string;
}

const redGreenObservations: Observation[] = [];
const preservationObservations: Observation[] = [];

function forwardedFor(): string {
  return `10.9.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

function statusOf(res: HttpResponseInit): number {
  return res.status ?? 200;
}

function codeOf(res: HttpResponseInit): string | undefined {
  return (res.jsonBody as { code?: string } | undefined)?.code;
}

function retryAfterOf(res: HttpResponseInit): string | undefined {
  return (res.headers as Record<string, string> | undefined)?.["Retry-After"];
}

function record(target: Observation[], label: string, res: HttpResponseInit): void {
  target.push({
    label,
    status: statusOf(res),
    code: codeOf(res),
    retryAfter: retryAfterOf(res),
  });
}

function authPutBrief(
  user: { id: string; email: string },
  roundId: string,
  body: RoundBrief,
  query: Record<string, string> = {},
) {
  return makeAuthRequest(user.id, user.email, {
    method: "PUT",
    params: { id: roundId },
    query,
    body,
    headers: { "x-forwarded-for": forwardedFor() },
  });
}

async function getBrief(user: { id: string; email: string }, roundId: string): Promise<RoundBrief> {
  const res = await invoke(
    "getRoundBrief",
    makeAuthRequest(user.id, user.email, {
      method: "GET",
      params: { id: roundId },
      headers: { "x-forwarded-for": forwardedFor() },
    }),
  );
  expect(statusOf(res)).toBe(200);
  return res.jsonBody as RoundBrief;
}

async function makeEditableRoundWithBrief(clubId: string): Promise<Round> {
  const round = await makeRound({
    organisingClubId: clubId,
    status: "Confirmed",
  });
  expect(await readPrivateJson<RoundBrief>(`round-briefs/${round.id}.json`)).toBeTruthy();
  return round;
}

async function drainUpdateRoundBriefHeavyBucket(
  user: { id: string; email: string },
  roundId: string,
  brief: RoundBrief,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const res = await invoke(
      "updateRoundBrief",
      authPutBrief(user, roundId, { ...brief, briefersNotes: `drain ${i}` }, { dryRun: "true" }),
    );
    statuses.push(statusOf(res));
  }
  return statuses;
}

async function writeEvidence(): Promise<void> {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });

  const prior = await fs.readFile(RED_GREEN_EVIDENCE, "utf8").catch(() => "");
  const priorRedLine = prior.split("\n").find((line) => line.startsWith("RED pre-fix"));
  const currentRed = redGreenObservations.find((o) => o.label === "cross-club after drain");
  const redLine = priorRedLine ?? (currentRed?.status === 429
    ? `RED pre-fix: forbidden cross-club PUT after 5-call heavy drain returned status=429 code=${currentRed.code} retryAfter=${currentRed.retryAfter ?? "absent"}`
    : "RED pre-fix: not captured in this run; see earlier failing vitest output");
  const green = redGreenObservations.find((o) => o.label === "cross-club after drain");

  await fs.writeFile(
    RED_GREEN_EVIDENCE,
    [
      "Task 9 — updateRoundBrief 403 before 429 evidence",
      "Endpoint bucket drained with 5 PUT /api/rounds/{id}/brief calls (mutation:heavy:updateRoundBrief) using the same caller and random x-forwarded-for per request.",
      redLine,
      green
        ? `GREEN post-fix: forbidden cross-club PUT returned status=${green.status} code=${green.code} retryAfter=${green.retryAfter ?? "absent"}`
        : "GREEN post-fix: not observed",
      "",
      ...redGreenObservations.map((o) => `${o.label}: status=${o.status} code=${o.code ?? "n/a"} retryAfter=${o.retryAfter ?? "absent"}`),
      "",
    ].join("\n"),
  );

  await fs.writeFile(
    PRESERVATION_EVIDENCE,
    [
      "Task 9 — updateRoundBrief 409 and dryRun preservation evidence",
      ...preservationObservations.map((o) => `${o.label}: status=${o.status} code=${o.code ?? "n/a"} retryAfter=${o.retryAfter ?? "absent"}`),
      "",
    ].join("\n"),
  );
}

describe("updateRoundBrief rate-limit ordering", () => {
  beforeEach(() => {
    resetAllBuckets();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await writeEvidence();
  });

  it("forbidden cross-club RoundsCoord gets 403 without Retry-After even after heavy bucket drain", async () => {
    const clubA = randomUUID();
    const clubB = randomUUID();
    const { user: coordA } = await makeUser({ roles: ["RoundsCoord"], clubId: clubA });
    const ownRound = await makeEditableRoundWithBrief(clubA);
    const otherRound = await makeEditableRoundWithBrief(clubB);
    const ownBrief = await getBrief(coordA, ownRound.id);
    const otherBrief = await getBrief(coordA, otherRound.id);

    resetAllBuckets();
    const drainStatuses = await drainUpdateRoundBriefHeavyBucket(coordA, ownRound.id, ownBrief);
    expect(drainStatuses).toEqual([200, 200, 200, 200, 200]);

    const res = await invoke(
      "updateRoundBrief",
      authPutBrief(coordA, otherRound.id, { ...otherBrief, briefersNotes: "cross-club dry run" }, { dryRun: "true" }),
    );
    record(redGreenObservations, "cross-club after drain", res);

    expect(statusOf(res)).toBe(403);
    expect(codeOf(res)).toBe("FORBIDDEN");
    expect(retryAfterOf(res)).toBeUndefined();
  });

  it("locked round still returns 409 BRIEF_LOCKED", async () => {
    const clubId = randomUUID();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const lockedRound = await makeRound({ organisingClubId: clubId, status: "Locked" });
    const brief = await getBrief(coord, lockedRound.id);

    resetAllBuckets();
    const res = await invoke(
      "updateRoundBrief",
      authPutBrief(coord, lockedRound.id, { ...brief, briefersNotes: "locked edit" }),
    );
    record(preservationObservations, "locked round", res);

    expect(statusOf(res)).toBe(409);
    expect(codeOf(res)).toBe("BRIEF_LOCKED");
  });

  it("authorized dryRun returns 200, writes nothing, and still consumes the heavy bucket", async () => {
    const clubId = randomUUID();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const round = await makeEditableRoundWithBrief(clubId);
    const originalBrief = await getBrief(coord, round.id);

    resetAllBuckets();
    const dryRunBody = { ...originalBrief, briefersNotes: "dry-run-only mutation" };
    const first = await invoke(
      "updateRoundBrief",
      authPutBrief(coord, round.id, dryRunBody, { dryRun: "true" }),
    );
    record(preservationObservations, "authorized dryRun first call", first);

    expect(statusOf(first)).toBe(200);
    expect(await readPrivateJson<RoundBrief>(`round-briefs/${round.id}.json`)).toEqual(originalBrief);

    for (let i = 2; i <= 5; i += 1) {
      const res = await invoke(
        "updateRoundBrief",
        authPutBrief(coord, round.id, { ...dryRunBody, briefersNotes: `dry-run drain ${i}` }, { dryRun: "true" }),
      );
      expect(statusOf(res)).toBe(200);
    }

    const sixth = await invoke(
      "updateRoundBrief",
      authPutBrief(coord, round.id, { ...dryRunBody, briefersNotes: "dry-run sixth" }, { dryRun: "true" }),
    );
    record(preservationObservations, "authorized dryRun sixth call", sixth);

    expect(statusOf(sixth)).toBe(429);
    expect(codeOf(sixth)).toBe("RATE_LIMITED");
    expect(retryAfterOf(sixth)).toBeDefined();
    expect(await readPrivateJson<RoundBrief>(`round-briefs/${round.id}.json`)).toEqual(originalBrief);
  });

  it("forbidden cross-club dryRun returns 403, not 429 or 200", async () => {
    const clubA = randomUUID();
    const clubB = randomUUID();
    const { user: coordA } = await makeUser({ roles: ["RoundsCoord"], clubId: clubA });
    const ownRound = await makeEditableRoundWithBrief(clubA);
    const otherRound = await makeEditableRoundWithBrief(clubB);
    const ownBrief = await getBrief(coordA, ownRound.id);
    const otherBrief = await getBrief(coordA, otherRound.id);

    resetAllBuckets();
    await drainUpdateRoundBriefHeavyBucket(coordA, ownRound.id, ownBrief);

    const res = await invoke(
      "updateRoundBrief",
      authPutBrief(coordA, otherRound.id, { ...otherBrief, briefersNotes: "forbidden dry run" }, { dryRun: "true" }),
    );
    record(preservationObservations, "forbidden cross-club dryRun after drain", res);

    expect(statusOf(res)).toBe(403);
    expect(statusOf(res)).not.toBe(429);
    expect(statusOf(res)).not.toBe(200);
    expect(codeOf(res)).toBe("FORBIDDEN");
    expect(retryAfterOf(res)).toBeUndefined();
  });
});
