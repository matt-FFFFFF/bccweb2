// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Evidence harness for Task 11 (mutationRateLimit application).
 *
 * Captures status codes for:
 *   - 31x PUT to a standard mutating handler  -> .omo/evidence/task-11-standard-burst.txt
 *   - 6x POST to a heavy mutating handler    -> .omo/evidence/task-11-heavy-burst.txt
 *
 * Asserts ≥1 429 in each burst. Run as part of `make test`.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { User } from "@bccweb/types";
import { afterAll, describe, expect, it, vi } from "vitest";

// Ensure the mutating function modules register before we look up handlers
import "../admin.js";
import "../roundsMutate.js";

import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { writePrivateBlob } from "../../lib/blob.js";
import { signAccessToken } from "../../lib/authHelpers.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";

// Resolve repo root from this file's location: …/apps/api/src/functions/__tests__/
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".omo", "evidence");

interface InvokeResult {
  status: number;
}

async function seedAdminUser(userId: string, email: string): Promise<void> {
  const user: User = {
    id: userId,
    email,
    roles: ["Admin"],
    pilotId: null,
    clubId: null,
    createdAt: new Date().toISOString(),
  };
  await writePrivateBlob(`users/${userId}.json`, user);
}

function makeReq(
  method: string,
  body: unknown,
  token: string,
  params: Record<string, string> = {},
): HttpRequest {
  // Vary the source IP each call so an IP-keyed limiter never wins; the
  // mutation limiter is identity-keyed, which is what we want to exercise.
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-forwarded-for": `10.42.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`,
  });
  return {
    method,
    headers,
    params,
    query: new URLSearchParams(),
    json: async () => body,
  } as unknown as HttpRequest;
}

const FAKE_CTX = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as InvocationContext;

async function invoke(handlerName: string, req: HttpRequest): Promise<InvokeResult> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`Handler ${handlerName} not registered`);
  try {
    const res = (await entry.handler(req, FAKE_CTX)) as HttpResponseInit;
    return { status: typeof res?.status === "number" ? res.status : 200 };
  } catch (err: unknown) {
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode;
    return { status: typeof status === "number" ? status : 500 };
  }
}

describe("Task 11 mutationRateLimit evidence harness", () => {
  const sequenceStandard: number[] = [];
  const sequenceHeavy: number[] = [];

  afterAll(async () => {
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });

    const standardSummary = [
      "Task 11 — standard-tier burst against updateConfig (PUT /api/manage/config)",
      "Tier: standard (capacity=30, refill=30/min). Expect 30x 200 + at least one 429.",
      "",
      ...sequenceStandard.map((code, i) => `req ${String(i + 1).padStart(2)}: ${code}`),
      "",
      `summary: 200x${sequenceStandard.filter((c) => c === 200).length} 429x${sequenceStandard.filter((c) => c === 429).length}`,
    ].join("\n");
    await fs.writeFile(
      path.join(EVIDENCE_DIR, "task-11-standard-burst.txt"),
      `${standardSummary}\n`,
    );

    const heavySummary = [
      "Task 11 — heavy-tier burst against lockRound (POST /api/rounds/{id}/lock)",
      "Tier: heavy (capacity=5, refill=5/min). Expect 5x non-429 + at least one 429.",
      "",
      ...sequenceHeavy.map((code, i) => `req ${String(i + 1).padStart(2)}: ${code}`),
      "",
      `summary: 429x${sequenceHeavy.filter((c) => c === 429).length} non-429x${sequenceHeavy.filter((c) => c !== 429).length}`,
    ].join("\n");
    await fs.writeFile(
      path.join(EVIDENCE_DIR, "task-11-heavy-burst.txt"),
      `${heavySummary}\n`,
    );
  });

  it("standard tier: 31x PUT updateConfig produces ≥1 429", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    try {
      resetAllBuckets();
      const adminId = randomUUID();
      const email = `admin-${adminId}@example.test`;
      await seedAdminUser(adminId, email);
      const token = signAccessToken(adminId, email, 0);

      // Seed a valid config so updateConfig succeeds with 200 on the happy path.
      await writePrivateBlob("config.json", {
        maxTeamsInClub: 2,
        maxPilotsInTeam: 12,
        maxScoringPilotsInTeam: 6,
        flightDateValidationEnabled: true,
        wingFactors: {
          "EN A": 1.0,
          "EN B": 0.9,
          "EN C": 0.8,
          "EN C 2-liner": 0.7,
          "EN D": 0.6,
          "EN D 2-liner": 0.5,
        },
      });

      for (let i = 1; i <= 31; i += 1) {
        const req = makeReq("PUT", { maxTeamsInClub: 2 }, token);
        const { status } = await invoke("updateConfig", req);
        sequenceStandard.push(status);
      }

      expect(sequenceStandard.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
      // Sanity: at least one early request must have succeeded (proves the gate
      // doesn't 429 on the first request).
      expect(sequenceStandard.slice(0, 30).filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("heavy tier: 6x POST lockRound produces ≥1 429", async () => {
    resetAllBuckets();
    const adminId = randomUUID();
    const email = `admin-${adminId}@example.test`;
    await seedAdminUser(adminId, email);
    const token = signAccessToken(adminId, email, 0);

    // lockRound scope-checks the round (read + organising-club guard) before
    // the rate limiter, consistent with the other coord handlers. Seed a
    // manageable round so each call reaches the limiter: it drains a heavy
    // token, then 409s on the status guard (the round is not BriefComplete).
    const roundId = randomUUID();
    await writePrivateBlob(`rounds/${roundId}.json`, {
      id: roundId,
      site: { id: randomUUID(), name: "Rate Limit Site" },
      season: { year: 2026 },
    });
    const params = { id: roundId };

    for (let i = 1; i <= 6; i += 1) {
      const req = makeReq("POST", {}, token, params);
      const { status } = await invoke("lockRound", req);
      sequenceHeavy.push(status);
    }

    expect(sequenceHeavy.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });
});
