import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, test } from "vitest";
import type { HttpResponseInit } from "@azure/functions";

import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeClubTeam, makeUser } from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import "../clubTeams.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".omo", "evidence");

const ctx = {
  invocationId: "club-teams-rate-limit-order-test",
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

type InvokeResult = HttpResponseInit & { status: number };

function randomForwardedFor(): string {
  return `10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

async function invoke(
  handlerName: string,
  user: { id: string; email: string },
  options: NonNullable<Parameters<typeof makeAuthRequest>[2]>,
): Promise<InvokeResult> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`${handlerName} not registered`);
  const req = makeAuthRequest(user.id, user.email, {
    ...options,
    headers: {
      ...options.headers,
      "x-forwarded-for": randomForwardedFor(),
    },
  });
  const res = (await entry.handler(req, ctx)) as HttpResponseInit;
  return { ...res, status: res.status ?? 200 };
}

function responseHeader(res: HttpResponseInit, name: string): string | undefined {
  if (!res.headers) return undefined;
  if (res.headers instanceof Headers) return res.headers.get(name) ?? undefined;
  return (res.headers as Record<string, string | undefined>)[name];
}

async function writeEvidence(fileName: string, lines: string[]): Promise<void> {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, fileName), `${lines.join("\n")}\n`);
}

describe("clubTeams mutation rate-limit ordering", () => {
  test("updateClubTeam checks coord club scope before the standard mutation bucket", async () => {
    resetAllBuckets();
    const coordClubId = randomUUID();
    const otherClubId = randomUUID();
    const team = await makeClubTeam({
      clubId: otherClubId,
      seasonYear: 3900 + Math.floor(Math.random() * 1_000),
      teamName: `Other-${randomUUID().slice(0, 8)}`,
    });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: coordClubId,
      emailVerified: true,
    });
    const endpoint = { handler: "updateClubTeam", method: "PUT", params: { id: team.id } };

    const sequence: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await invoke(endpoint.handler, user, {
        method: endpoint.method,
        params: endpoint.params,
        body: { teamName: `Forbidden-${i}` },
      });
      sequence.push(res.status);
    }

    const forbidden = await invoke(endpoint.handler, user, {
      method: endpoint.method,
      params: endpoint.params,
      body: { teamName: "Still Forbidden" },
    });
    sequence.push(forbidden.status);

    await writeEvidence("task-4-updateClubTeam-403.txt", [
      "Task 4 — updateClubTeam forbidden cross-club coord after draining same endpoint",
      "Endpoint: PUT /api/club-teams/{id}; handler: updateClubTeam; tier: standard (capacity=30)",
      "PRE-fix RED proof: focused run before reorder failed with AssertionError expected 429 to be 403; final forbidden cross-club request returned 429 when rate-limit ran before existing-team scope check.",
      "GREEN expectation: final forbidden cross-club request returns 403, code FORBIDDEN, no Retry-After.",
      "",
      ...sequence.map((status, i) => `req ${String(i + 1).padStart(2, "0")}: ${status}`),
      `final-code: ${(forbidden.jsonBody as { code?: string } | undefined)?.code ?? "<missing>"}`,
      `final-retry-after: ${responseHeader(forbidden, "Retry-After") ?? "<absent>"}`,
    ]);

    expect(forbidden.status).toBe(403);
    expect((forbidden.jsonBody as { code?: string }).code).toBe("FORBIDDEN");
    expect(responseHeader(forbidden, "Retry-After")).toBeUndefined();
  });

  test("createClubTeam keeps missing clubId mapped to 400 INVALID_BODY", async () => {
    resetAllBuckets();
    const missingClubId = randomUUID();
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: missingClubId,
      emailVerified: true,
    });

    const res = await invoke("createClubTeam", user, {
      method: "POST",
      body: {
        clubId: missingClubId,
        seasonYear: 3900 + Math.floor(Math.random() * 1_000),
        teamName: `Missing Club ${randomUUID().slice(0, 8)}`,
      },
    });

    await writeEvidence("task-4-createClubTeam-400.txt", [
      "Task 4 — createClubTeam missing clubId behavior preservation",
      "Endpoint: POST /api/club-teams; handler: createClubTeam",
      `status: ${res.status}`,
      `code: ${(res.jsonBody as { code?: string } | undefined)?.code ?? "<missing>"}`,
    ]);

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("INVALID_BODY");
  });
});
