import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HttpResponseInit } from "@azure/functions";
import type { Round, RoundBrief, Signature, User } from "@bccweb/types";
import { invoke, makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import { makeUser, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import "../signatures.js";

describe("POST /api/rounds/{roundId}/reflect-sign-to-fly", () => {
  it("returns 200 and the corrected round when an admin repairs a stale signToFly flag", async () => {
    // Given: a BriefComplete round has a stale false slot flag but a current-version signature exists.
    const ctx = await seedRoundWithCurrentSignature();
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    // When: an admin runs the synchronous operator repair endpoint.
    const res = await reflect(ctx, admin);

    // Then: the returned round already contains the repaired flag, proving sync reflection ran.
    expect(res.status).toBe(200);
    expect(roundBody(res).teams[0]?.pilots[0]?.signToFly).toBe(true);
  });

  it("returns 200 when a RoundsCoord is scoped to the round's organising club", async () => {
    // Given: a stale signed round belongs to the coordinator's club.
    const ctx = await seedRoundWithCurrentSignature();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId: ctx.clubId });

    // When: the scoped coordinator runs the repair endpoint.
    const res = await reflect(ctx, coord);

    // Then: the repair is authorised.
    expect(res.status).toBe(200);
  });

  it("returns 403 FORBIDDEN when a RoundsCoord is scoped to a different club", async () => {
    // Given: a stale signed round belongs to another club.
    const ctx = await seedRoundWithCurrentSignature();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });

    // When: the unscoped coordinator runs the repair endpoint.
    const res = await reflect(ctx, coord);

    // Then: the request is forbidden.
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("FORBIDDEN");
  });

  it("returns 403 FORBIDDEN when a Pilot calls the repair endpoint", async () => {
    // Given: a pilot caller for a stale signed round.
    const ctx = await seedRoundWithCurrentSignature();
    const { user: pilot } = await makeUser({ roles: ["Pilot"], pilotId: ctx.pilotId });

    // When: the pilot runs the repair endpoint.
    const res = await reflect(ctx, pilot);

    // Then: pilots cannot use the operator recovery path.
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("FORBIDDEN");
  });

  it("returns 409 INVALID_STATE when the round is Locked", async () => {
    // Given: a stale signed round is not BriefComplete.
    const ctx = await seedRoundWithCurrentSignature({ status: "Locked" });
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    // When: an admin runs the repair endpoint.
    const res = await reflect(ctx, admin);

    // Then: the endpoint rejects the invalid state with the status detail.
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("INVALID_STATE");
    expect(errorDetail(res)).toContain("Locked");
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    // Given: a stale signed round and no bearer token.
    const ctx = await seedRoundWithCurrentSignature();

    // When: an unauthenticated request runs the repair endpoint.
    const res = await invoke(
      "reflectSignToFly",
      makeRequest({ method: "POST", params: { roundId: ctx.roundId } }),
    );

    // Then: auth is required.
    expect(res.status).toBe(401);
  });

  it("returns 400 MISSING_ROUND_ID when the route parameter is absent", async () => {
    // Given: an authenticated admin request without the roundId route parameter.
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    // When: the handler is invoked with malformed route params.
    const res = await invoke(
      "reflectSignToFly",
      makeAuthRequest(admin.id, admin.email, { method: "POST" }),
    );

    // Then: the endpoint rejects malformed input before reading storage.
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("MISSING_ROUND_ID");
  });
});

interface ReflectContext {
  readonly roundId: string;
  readonly teamId: string;
  readonly pilotId: string;
  readonly clubId: string;
}

async function seedRoundWithCurrentSignature(
  overrides: { readonly status?: Round["status"] } = {},
): Promise<ReflectContext> {
  const roundId = randomUUID();
  const teamId = randomUUID();
  const pilotId = randomUUID();
  const clubId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: overrides.status ?? "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year: 2026 },
    teams: [{
      id: teamId,
      teamName: "A",
      club: { id: clubId, name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId,
        snapshot: null,
        flight: null,
      }],
    }],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  const briefHash = await seedBrief(roundId, 1);
  await writeSignature(makeCurrentSignature({ roundId, teamId, pilotId, briefHash }));
  return { roundId, teamId, pilotId, clubId };
}

async function seedBrief(roundId: string, version: number): Promise<string> {
  const brief: RoundBrief & { version: number } = {
    roundId,
    version,
    generatedAt: new Date().toISOString(),
    date: "2026-06-09",
    siteName: "Milk Hill",
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    windSpeedDirection: `W ${version}`,
    imagePaths: [],
    teams: [],
  };
  brief.hash = computeBriefHash(brief);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
  return brief.hash;
}

function makeCurrentSignature(ctx: {
  readonly roundId: string;
  readonly teamId: string;
  readonly pilotId: string;
  readonly briefHash: string;
}): Signature {
  return {
    id: randomUUID(),
    roundId: ctx.roundId,
    teamId: ctx.teamId,
    place: 1,
    pilotId: ctx.pilotId,
    userId: randomUUID(),
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: ctx.briefHash,
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.10",
    userAgent: "reflect-test-agent",
    source: "pilot-self",
  };
}

function reflect(ctx: ReflectContext, user: User): Promise<HttpResponseInit> {
  return invoke(
    "reflectSignToFly",
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { roundId: ctx.roundId },
    }),
  );
}

function roundBody(res: HttpResponseInit): Round {
  if (!isRound(res.jsonBody)) throw new Error("response jsonBody is not a Round");
  return res.jsonBody;
}

function errorCode(res: HttpResponseInit): string | undefined {
  return responseField(res, "code");
}

function errorDetail(res: HttpResponseInit): string {
  return responseField(res, "detail") ?? "";
}

function responseField(res: HttpResponseInit, field: "code" | "detail"): string | undefined {
  const body = res.jsonBody;
  if (typeof body !== "object" || body === null || !(field in body)) return undefined;
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

function isRound(value: unknown): value is Round {
  return typeof value === "object" &&
    value !== null &&
    "teams" in value &&
    Array.isArray(value.teams);
}
