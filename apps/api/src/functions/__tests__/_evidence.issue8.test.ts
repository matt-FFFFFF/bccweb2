// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { CallerIdentity, Round, Team, User, UserRole } from "@bccweb/types";
import { describe, expect, it } from "vitest";

import "../admin.js";
import "../adminWording.js";
import "../brief.js";
import "../clubTeams.js";
import "../clubs.js";
import "../flights.js";
import "../pilots.js";
import "../pilotSeasonClubs.js";
import "../puretrack.js";
import "../roundsMutate.js";
import "../seasonClubs.js";
import "../seasons.js";
import "../sites.js";
import "../teams.js";
import "../teamsCaptain.js";

import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import {
  makeClub,
  makeClubTeam,
  makePilot,
  makeRound,
  makeSite,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { signAccessToken } from "../../lib/authHelpers.js";
import { mutationRateLimit, resetAllBuckets, type MutationRateLimitTier } from "../../lib/rateLimit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const FUNCTIONS_DIR = path.resolve(HERE, "..");

const SOURCE_FILES = [
  "admin.ts",
  "adminWording.ts",
  "brief.ts",
  "clubTeams.ts",
  "clubs.ts",
  "flights.ts",
  "pilots.ts",
  "pilotSeasonClubs.ts",
  "puretrack.ts",
  "roundsMutate.ts",
  "seasonClubs.ts",
  "seasons.ts",
  "sites.ts",
  "teams.ts",
  "teamsCaptain.ts",
] as const;

interface InvokeResult {
  status: number;
  jsonBody?: unknown;
  headers?: Headers | Record<string, string>;
}

interface TestUser {
  id: string;
  email: string;
  roles: UserRole[];
  pilotId: string | null;
  clubId: string | null;
}

interface HarnessRequest {
  method: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

interface CaseContext {
  forbidden: TestUser;
  request: HarnessRequest;
}

interface CallSiteCase {
  file: (typeof SOURCE_FILES)[number];
  handler: string;
  endpoint: string;
  tier: MutationRateLimitTier;
  forbiddenKind: "admin-only" | "coord-coarse" | "coord-scope" | "self-or-admin";
  setup: () => Promise<CaseContext>;
}

const FAKE_CTX = {
  invocationId: "issue-8-rate-limit-ordering-evidence",
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as InvocationContext;

const CAPACITY_BY_TIER: Record<MutationRateLimitTier, number> = {
  standard: 30,
  heavy: 5,
  flights: 60,
};

function randomIp(): string {
  return `10.88.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

async function seedUser({
  roles,
  clubId = null,
  pilotId = null,
}: {
  roles: UserRole[];
  clubId?: string | null;
  pilotId?: string | null;
}): Promise<TestUser> {
  const id = randomUUID();
  const email = `issue8-${id.slice(0, 8)}@example.test`;
  const user: User = {
    id,
    email,
    roles,
    clubId,
    pilotId,
    createdAt: new Date().toISOString(),
  };
  await writePrivateJson(`users/${id}.json`, user);
  return { id, email, roles, clubId, pilotId };
}

function makeReq(user: TestUser, request: HarnessRequest): HttpRequest {
  return {
    method: request.method,
    headers: new Headers({
      authorization: `Bearer ${signAccessToken(user.id, user.email, 0)}`,
      "content-type": "application/json",
      "x-forwarded-for": randomIp(),
    }),
    params: request.params ?? {},
    query: new URLSearchParams(request.query ?? {}),
    json: async () => request.body ?? {},
  } as unknown as HttpRequest;
}

async function invoke(handlerName: string, req: HttpRequest): Promise<InvokeResult> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`Handler ${handlerName} not registered`);
  const res = (await entry.handler(req, FAKE_CTX)) as HttpResponseInit;
  return {
    status: res.status ?? 200,
    jsonBody: res.jsonBody,
    headers: res.headers as InvokeResult["headers"],
  };
}

function retryAfter(res: InvokeResult): string | undefined {
  if (!res.headers) return undefined;
  if (res.headers instanceof Headers) return res.headers.get("Retry-After") ?? undefined;
  return res.headers["Retry-After"] ?? res.headers["retry-after"];
}

function callerFrom(user: TestUser): CallerIdentity {
  return {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    pilotId: user.pilotId,
    clubId: user.clubId,
  };
}

async function saturateOwnBucket(row: CallSiteCase, ctx: CaseContext): Promise<void> {
  const caller = callerFrom(ctx.forbidden);
  let rejected = false;
  const maxAttempts = CAPACITY_BY_TIER[row.tier] * 2 + 10;

  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      await mutationRateLimit(makeReq(ctx.forbidden, ctx.request), caller, row.endpoint, row.tier);
    } catch (err: unknown) {
      expect((err as { status?: number }).status).toBe(429);
      rejected = true;
      break;
    }
  }

  expect(rejected).toBe(true);
}

const adminOnly = (method: string, params: Record<string, string> = {}, body: unknown = {}): (() => Promise<CaseContext>) =>
  async () => ({
    forbidden: await seedUser({ roles: ["Pilot"], pilotId: randomUUID() }),
    request: { method, params, body },
  });

const coordCoarse = (method: string, params: Record<string, string> = {}, body: unknown = {}): (() => Promise<CaseContext>) =>
  async () => ({
    forbidden: await seedUser({ roles: ["Pilot"], pilotId: randomUUID() }),
    request: { method, params, body },
  });

async function crossClubCoord(): Promise<TestUser> {
  return seedUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
}

async function roundForOtherClub(status: Round["status"] = "Proposed"): Promise<Round> {
  return makeRound({ organisingClubId: randomUUID(), status });
}

async function roundWithFlight(flightId: string, ownerPilotId: string): Promise<Round> {
  const clubId = randomUUID();
  const team: Team = {
    id: randomUUID(),
    teamName: "Flight Team",
    club: { id: clubId, name: "Flight Club" },
    score: 0,
    pilots: [
      {
        placeInTeam: 1,
        pilotId: ownerPilotId,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: {
          id: flightId,
          distance: 10,
          duration: 60,
          scoringType: "XC",
          score: 0,
          wingFactor: 1,
          isManualLog: false,
        },
      },
    ],
  };
  return makeRound({ organisingClubId: clubId, status: "Locked", teams: [team] });
}

async function seedPilotSeasonClubAssignment(seasonYear: number, clubId: string): Promise<string> {
  const club = await makeClub({ id: clubId, name: `Season Club ${clubId.slice(0, 6)}` });
  const admin = await seedUser({ roles: ["Admin"] });
  const createSeasonClub = await invoke(
    "createSeasonClub",
    makeReq(admin, {
      method: "POST",
      params: { year: String(seasonYear) },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    }),
  );
  expect([201, 409]).toContain(createSeasonClub.status);

  const pilot = await makePilot();
  const assign = await invoke(
    "assignPilotSeasonClub",
    makeReq(admin, {
      method: "POST",
      body: { pilotId: pilot.id, clubId: club.id, seasonYear },
    }),
  );
  expect(assign.status).toBe(201);
  return pilot.id;
}

const CASES: CallSiteCase[] = [
  { file: "admin.ts", handler: "recomputeRound", endpoint: "recomputeRound", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { id: randomUUID() }) },
  { file: "admin.ts", handler: "updateConfig", endpoint: "updateConfig", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", {}, { maxTeamsInClub: 2 }) },
  { file: "admin.ts", handler: "setUserRoles", endpoint: "setUserRoles", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { userId: randomUUID() }, { roles: ["Pilot"] }) },
  { file: "admin.ts", handler: "updateUserEmail", endpoint: "updateUserEmail", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { userId: randomUUID() }, { email: "issue8-new@example.test" }) },
  { file: "admin.ts", handler: "deleteUser", endpoint: "deleteUser", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { userId: randomUUID() }) },
  { file: "admin.ts", handler: "adminVerifyEmail", endpoint: "adminVerifyEmail", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { userId: randomUUID() }) },
  { file: "admin.ts", handler: "adminCreatePilotForUser", endpoint: "adminCreatePilotForUser", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { userId: randomUUID() }, { firstName: "Issue8", lastName: "Pilot" }) },
  { file: "adminWording.ts", handler: "addSignToFlyWording", endpoint: "addSignToFlyWording", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { markdown: "x" }) },

  { file: "brief.ts", handler: "updateRoundBrief", endpoint: "updateRoundBrief", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await roundForOtherClub("Confirmed")).id }, body: {} } }) },
  { file: "brief.ts", handler: "regenerateRoundBriefPdf", endpoint: "regenerateRoundBriefPdf", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Locked")).id } } }) },
  { file: "brief.ts", handler: "uploadBriefImage", endpoint: "uploadBriefImage", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Confirmed")).id } } }) },
  { file: "brief.ts", handler: "deleteBriefImage", endpoint: "deleteBriefImage", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await roundForOtherClub("Confirmed")).id, index: "1" } } }) },

  { file: "clubTeams.ts", handler: "createClubTeam", endpoint: "createClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { clubId: randomUUID(), seasonYear: 2026, teamName: "Other" } } }) },
  { file: "clubTeams.ts", handler: "updateClubTeam", endpoint: "updateClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await makeClubTeam({ clubId: randomUUID(), seasonYear: 2026, teamName: `Other-${randomUUID().slice(0, 6)}` })).id }, body: { teamName: "Nope" } } }) },
  { file: "clubTeams.ts", handler: "deleteClubTeam", endpoint: "deleteClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await makeClubTeam({ clubId: randomUUID(), seasonYear: 2026, teamName: `Delete-${randomUUID().slice(0, 6)}` })).id } } }) },

  { file: "clubs.ts", handler: "createClub", endpoint: "createClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { name: "Forbidden Club" }) },
  { file: "clubs.ts", handler: "updateClub", endpoint: "updateClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { id: randomUUID() }, { name: "Forbidden Club" }) },
  { file: "clubs.ts", handler: "deleteClub", endpoint: "deleteClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { id: randomUUID() }) },

  { file: "flights.ts", handler: "logFlight", endpoint: "logFlight", tier: "flights", forbiddenKind: "self-or-admin", setup: async () => ({ forbidden: await seedUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "POST", params: { id: randomUUID() }, body: { pilotId: randomUUID(), distance: 1 } } }) },
  { file: "flights.ts", handler: "updateFlight", endpoint: "updateFlight", tier: "flights", forbiddenKind: "self-or-admin", setup: async () => { const flightId = randomUUID(); const ownerPilotId = randomUUID(); const round = await roundWithFlight(flightId, ownerPilotId); return { forbidden: await seedUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "PUT", params: { id: round.id, flightId }, body: { distance: 11 } } }; } },
  { file: "flights.ts", handler: "deleteFlight", endpoint: "deleteFlight", tier: "flights", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), flightId: randomUUID() }) },

  { file: "pilots.ts", handler: "createPilot", endpoint: "createPilot", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { firstName: "Forbidden", lastName: "Pilot" }) },
  { file: "pilots.ts", handler: "updatePilot", endpoint: "updatePilot", tier: "standard", forbiddenKind: "self-or-admin", setup: async () => ({ forbidden: await seedUser({ roles: ["Pilot"], pilotId: randomUUID() }), request: { method: "PUT", params: { id: randomUUID() }, body: { firstName: "Nope" } } }) },

  { file: "pilotSeasonClubs.ts", handler: "assignPilotSeasonClub", endpoint: "assignPilotSeasonClub", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { pilotId: randomUUID(), clubId: randomUUID(), seasonYear: 2026 } } }) },
  { file: "pilotSeasonClubs.ts", handler: "deletePilotSeasonClub", endpoint: "deletePilotSeasonClub", tier: "standard", forbiddenKind: "coord-scope", setup: async () => { const clubId = randomUUID(); const pilotId = await seedPilotSeasonClubAssignment(2026, clubId); return { forbidden: await crossClubCoord(), request: { method: "DELETE", params: { pilotId, seasonYear: "2026" } } }; } },

  { file: "puretrack.ts", handler: "createPureTrackGroups", endpoint: "createPureTrackGroups", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Locked")).id } } }) },

  { file: "roundsMutate.ts", handler: "createRound", endpoint: "createRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", {}, { date: "2026-06-01", siteId: randomUUID(), seasonYear: 2026 }) },
  { file: "roundsMutate.ts", handler: "updateRound", endpoint: "updateRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("PUT", { id: randomUUID() }, { maxTeams: 4 }) },
  { file: "roundsMutate.ts", handler: "confirmRound", endpoint: "confirmRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "briefCompleteRound", endpoint: "briefCompleteRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "reopenBrief", endpoint: "reopenBrief", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "lockRound", endpoint: "lockRound", tier: "heavy", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "unlockRound", endpoint: "unlockRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "completeRound", endpoint: "completeRound", tier: "heavy", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "cancelRound", endpoint: "cancelRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },
  { file: "roundsMutate.ts", handler: "uncancelRound", endpoint: "uncancelRound", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }) },

  { file: "seasonClubs.ts", handler: "createSeasonClub", endpoint: "createSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", { year: "2026" }, { clubId: randomUUID(), numTeams: 1, acceptTsCs: true }) },
  { file: "seasonClubs.ts", handler: "updateSeasonClub", endpoint: "updateSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { year: "2026", seasonClubId: randomUUID() }, { numTeams: 1 }) },
  { file: "seasonClubs.ts", handler: "deleteSeasonClub", endpoint: "deleteSeasonClub", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { year: "2026", seasonClubId: randomUUID() }) },

  { file: "seasons.ts", handler: "createSeason", endpoint: "createSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("POST", {}, { year: 2026 }) },
  { file: "seasons.ts", handler: "updateSeason", endpoint: "updateSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("PUT", { year: "2026" }, { active: true }) },
  { file: "seasons.ts", handler: "deleteSeason", endpoint: "deleteSeason", tier: "standard", forbiddenKind: "admin-only", setup: adminOnly("DELETE", { year: "2026" }) },

  { file: "sites.ts", handler: "createSite", endpoint: "createSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { name: "Other Site", clubId: randomUUID() } } }) },
  { file: "sites.ts", handler: "updateSite", endpoint: "updateSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await makeSite({ clubId: randomUUID() })).id }, body: { parkingW3W: "///nope.nope.nope" } } }) },
  { file: "sites.ts", handler: "deleteSite", endpoint: "deleteSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await makeSite({ clubId: randomUUID() })).id } } }) },

  { file: "teams.ts", handler: "addTeam", endpoint: "addTeam", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID() }, { clubId: randomUUID(), teamName: "Alpha" }) },
  { file: "teams.ts", handler: "removeTeam", endpoint: "removeTeam", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), teamId: randomUUID() }) },
  { file: "teams.ts", handler: "addPilot", endpoint: "addPilot", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("POST", { id: randomUUID(), teamId: randomUUID() }, { pilotId: randomUUID() }) },
  { file: "teams.ts", handler: "removePilot", endpoint: "removePilot", tier: "standard", forbiddenKind: "coord-coarse", setup: coordCoarse("DELETE", { id: randomUUID(), teamId: randomUUID(), place: "1" }) },
  { file: "teams.ts", handler: "updateAccounted", endpoint: "updateAccounted", tier: "standard", forbiddenKind: "coord-scope", setup: async () => {
    const clubId = randomUUID();
    const team: Team = {
      id: randomUUID(),
      teamName: "Acct Team",
      club: { id: clubId, name: "Acct Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        pilotId: randomUUID(),
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: null,
      }],
    };
    const round = await makeRound({ organisingClubId: clubId, status: "Locked", teams: [team] });
    return { forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: round.id, teamId: team.id, place: "1" }, body: { accountedFor: true } } };
  } },

  { file: "teamsCaptain.ts", handler: "setTeamCaptain", endpoint: "setTeamCaptain", tier: "standard", forbiddenKind: "coord-scope", setup: async () => { const clubId = randomUUID(); const round = await makeRound({ organisingClubId: clubId, teams: [{ id: "t1", club: { id: clubId, name: "Other" }, teamName: "T", score: 0, captainPilotId: null, pilots: [] }] }); return { forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: round.id, teamId: "t1" }, body: { pilotId: null } } }; } },
];

async function sourceMutationCallSites(): Promise<Array<{ file: string; endpoint: string; tier: string }>> {
  const rows: Array<{ file: string; endpoint: string; tier: string }> = [];
  const pattern = /mutationRateLimit\(\s*req,\s*caller,\s*"([^"]+)",\s*"([^"]+)"\s*\)/g;

  for (const file of SOURCE_FILES) {
    const source = await fs.readFile(path.join(FUNCTIONS_DIR, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      rows.push({ file, endpoint: match[1], tier: match[2] });
    }
  }

  return rows;
}

function sortKey(row: { file: string; endpoint: string; tier: string }): string {
  return `${row.file}:${row.endpoint}:${row.tier}`;
}

describe("Issue 8 mutationRateLimit ordering evidence", () => {
  it("enumerates every source mutationRateLimit call site", async () => {
    const sourceRows = await sourceMutationCallSites();
    const enumeratedRows = CASES.map(({ file, endpoint, tier }) => ({ file, endpoint, tier }));

    expect(enumeratedRows).toHaveLength(sourceRows.length);
    expect(enumeratedRows.map(sortKey).sort()).toEqual(sourceRows.map(sortKey).sort());
  });

  for (const row of CASES) {
    it(`${row.file} ${row.handler} (${row.endpoint}/${row.tier}) returns 403 before saturated same-endpoint 429`, async () => {
      const ctx = await row.setup();
      resetAllBuckets();
      await saturateOwnBucket(row, ctx);

      const res = await invoke(row.handler, makeReq(ctx.forbidden, ctx.request));

      expect(res.status).toBe(403);
      expect(res.status).not.toBe(429);
      expect((res.jsonBody as { code?: string } | undefined)?.code).toBe("FORBIDDEN");
      expect(retryAfter(res)).toBeUndefined();
    });
  }
});

export const issue8MutationRateLimitEvidence = {
  cases: CASES,
  repoRoot: REPO_ROOT,
};
