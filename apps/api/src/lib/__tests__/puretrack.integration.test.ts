import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Round } from "@bccweb/types";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  createPureTrackGroups,
  roundGroupName,
  type PureTrackRoundResult,
} from "../puretrack.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (err) {
  // A missing .env is fine (suite self-skips); surface anything else (e.g. EACCES).
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const BASE_URL = "https://puretrack.io";
const GROUP_BLOB_PREFIX = "puretrack-groups/";

const pilotIds = [...new Set(
  (process.env["PURETRACK_TEST_PILOT_IDS"] ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
)];

const hasCreds = !!(
  process.env["PURETRACK_API_KEY"] &&
  process.env["PURETRACK_EMAIL"] &&
  process.env["PURETRACK_PASSWORD"]
) && pilotIds.length > 0;

type CreatedGroup = {
  readonly id: number;
  readonly slug: string;
};

type PureTrackSession = {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly cookieHeader: string;
};

type ImportResponse = {
  readonly groupId: number;
  readonly added: readonly string[];
  readonly failed: readonly string[];
  readonly existing: readonly string[];
  readonly found: readonly string[];
};

type GroupState = {
  readonly id: number;
  readonly membersCount: number;
};

type TeardownFailure = {
  readonly id: number;
  readonly slug: string;
  readonly reason: string;
};

type FilledSlot = Round["teams"][number]["pilots"][number];

function makeRound(runId: string): Round {
  const slotFor = (_: number, index: number): FilledSlot => ({
    placeInTeam: index + 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId: randomUUID(),
    snapshot: null,
    flight: null,
  });

  return {
    id: `itest-round-${runId}`,
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "itest-site", name: `ITEST-${runId}` },
    season: { year: 2026 },
    teams: [
      {
        id: `itest-team-${runId}`,
        teamName: `ITEST-${runId}-A`,
        club: { id: "itest-club", name: "ITEST" },
        score: 0,
        pilots: pilotIds.map(slotFor),
      },
    ],
  };
}

function isCreatedGroup(value: unknown): value is CreatedGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Record<string, unknown>;
  return Number.isInteger(group["id"]) && Number(group["id"]) > 0 && typeof group["slug"] === "string" && group["slug"].length > 0;
}

function isPureTrackGroupBlob(value: unknown): value is { readonly externalId: string } {
  return typeof value === "object" && value !== null && "externalId" in value && typeof value.externalId === "string";
}

async function readJsonBlob(blobName: string): Promise<unknown> {
  const response = await getPrivateContainer().getBlobClient(blobName).download();
  const stream = response.readableStreamBody;
  if (!stream) throw new Error(`Blob ${blobName} had no readable stream`);

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function readPureTrackExternalIds(): Promise<string[]> {
  const externalIds: string[] = [];
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix: GROUP_BLOB_PREFIX })) {
    if (!item.name.endsWith(".json")) continue;
    const data = await readJsonBlob(item.name);
    if (!isPureTrackGroupBlob(data)) {
      throw new Error(`Blob ${item.name} did not contain a PureTrack externalId`);
    }
    externalIds.push(data.externalId);
  }
  return externalIds;
}

function parseAccessToken(value: unknown): string {
  if (typeof value !== "object" || value === null || !("access_token" in value)) throw new Error("PureTrack teardown login response did not include an access token");
  if (typeof value.access_token === "string" && value.access_token.length > 0) return value.access_token;
  throw new Error("PureTrack teardown login response did not include an access token");
}

function parseGroupState(value: unknown): GroupState {
  if (typeof value !== "object" || value === null || !("data" in value)) throw new Error("PureTrack group response did not include data");
  const data = value.data;
  if (typeof data === "object" && data !== null && "id" in data && "members_count" in data && typeof data.id === "number" && typeof data.members_count === "number") {
    return { id: data.id, membersCount: data.members_count };
  }
  throw new Error("PureTrack group response did not include data.id and data.members_count");
}

function stringArrayFrom(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function parseImportResponse(groupId: number, value: unknown): ImportResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const added = stringArrayFrom(body["added"]);
  const failed = stringArrayFrom(body["failed"]);
  const existing = stringArrayFrom(body["existing"]);
  const found = stringArrayFrom(body["found"]);
  return added && failed && existing && found ? { groupId, added, failed, existing, found } : null;
}

function getSetCookies(response: Response): string[] {
  return response.headers.getSetCookie?.() ?? [];
}

function cookieHeaderFrom(cookies: readonly string[]): string {
  const cookieMap = new Map<string, string>();
  for (const cookie of cookies.map((value) => value.split(";")[0]?.trim()).filter(Boolean)) {
    const name = cookie.split("=")[0];
    if (!name) continue;
    cookieMap.set(name, cookie);
  }
  return [...cookieMap.values()].join("; ");
}

function csrfTokenFrom(html: string, cookieHeader: string): string {
  for (const pattern of [
    /name="XSRF-TOKEN"\s+content="([^"]+)"/,
    /content="([^"]+)"\s+name="XSRF-TOKEN"/,
    /<meta\s+name=['"]XSRF-TOKEN['"]\s+content=['"]([^'"]+)['"]/,
    /<meta name="csrf-token" content="([^"]+)"/,
  ]) {
    const token = html.match(pattern)?.[1];
    if (token) return token;
  }

  for (const cookie of cookieHeader.split("; ")) {
    if (cookie.startsWith("XSRF-TOKEN=")) return decodeURIComponent(cookie.replace("XSRF-TOKEN=", ""));
  }

  throw new Error("Could not extract XSRF-TOKEN from PureTrack login page");
}

function authHeaders(session: PureTrackSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XSRF-TOKEN": session.csrfToken,
    "Content-Type": "application/json",
    Cookie: session.cookieHeader,
  };
}

describe.skipIf(!hasCreds)("PureTrack live integration", () => {
  const runId = randomUUID().slice(0, 8);
  const createdGroups: CreatedGroup[] = [];
  const importResponses: ImportResponse[] = [];
  let realFetch: typeof fetch;
  let createdResult: PureTrackRoundResult | null = null;

  async function authenticate(): Promise<PureTrackSession> {
    const loginRes = await realFetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: process.env["PURETRACK_API_KEY"], email: process.env["PURETRACK_EMAIL"], password: process.env["PURETRACK_PASSWORD"] }),
    });

    if (!loginRes.ok) throw new Error(`PureTrack login failed (${loginRes.status})`);

    const accessToken = parseAccessToken(await loginRes.json());
    const rawCookies = getSetCookies(loginRes);
    const loginCookieHeader = cookieHeaderFrom(rawCookies);

    const csrfRes = await realFetch(`${BASE_URL}/login`, { headers: { Cookie: loginCookieHeader } });
    if (!csrfRes.ok) throw new Error(`PureTrack CSRF page failed (${csrfRes.status})`);

    const csrfHtml = await csrfRes.text();
    const cookieHeader = cookieHeaderFrom([...rawCookies, ...getSetCookies(csrfRes)]);
    const csrfToken = csrfTokenFrom(csrfHtml, cookieHeader);

    return { accessToken, csrfToken, cookieHeader };
  }

  async function getGroupState(headers: Record<string, string>, id: number): Promise<GroupState> {
    const res = await realFetch(`${BASE_URL}/api/groups/${id}`, { headers });
    expect(res.status).toBe(200);
    const state = parseGroupState(await res.json());
    expect(state.id).toBe(id);
    return state;
  }

  beforeAll(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith("/api/groups") && init?.method === "POST" && res.ok) {
        try {
          const data = await res.clone().json();
          if (isCreatedGroup(data)) createdGroups.push({ id: data.id, slug: data.slug });
        } catch {
          /* capture is best-effort and must never affect the live request */
        }
      }
      const importMatch = String(input).match(/\/api\/groups\/(\d+)\/import-ids$/);
      if (importMatch && init?.method === "POST" && res.ok) {
        try {
          const data = parseImportResponse(Number(importMatch[1]), await res.clone().json());
          if (data) importResponses.push(data);
        } catch {
          /* capture is best-effort and must never affect the live request */
        }
      }
      return res;
    };
  });

  afterAll(async () => {
    if (!hasCreds) return;
    try {
      const headers = authHeaders(await authenticate());
      const fromResult: CreatedGroup[] = createdResult
        ? [
            { id: createdResult.roundGroupId, slug: createdResult.roundGroupSlug },
            ...createdResult.teams.map((team) => ({ id: team.groupId, slug: team.groupSlug })),
          ]
        : [];
      const uniqueGroups = [...new Map([...createdGroups, ...fromResult].map((group) => [group.id, group])).values()];
      const failures: TeardownFailure[] = [];

      for (const { id, slug } of uniqueGroups) {
        const url = `${BASE_URL}/api/groups/${id}`;
        try {
          const del = await realFetch(url, { method: "DELETE", headers });
          if (del.status !== 200) {
            failures.push({ id, slug, reason: `DELETE ${url} returned ${del.status}` });
            console.warn("[ITEST] manual cleanup needed", { id, slug, url });
            continue;
          }

          const after = await realFetch(url, { headers });
          if (after.status !== 404) {
            failures.push({ id, slug, reason: `GET ${url} returned ${after.status}` });
            console.warn("[ITEST] manual cleanup needed", { id, slug, url });
            continue;
          }
          console.info("[ITEST] teardown deleted", { id, slug, url });
        } catch (err) {
          failures.push({ id, slug, reason: err instanceof Error ? err.message : String(err) });
          console.warn("[ITEST] manual cleanup needed", { id, slug, url });
        }
      }

      await realFetch(`${BASE_URL}/api/logout`, { headers }).catch(() => {});
      expect(failures, `PureTrack teardown left groups: ${JSON.stringify(failures)}`).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("creates round and team groups through the real PureTrack API when credentials are present", async () => {
    // Given: a locked round with one filled BCC slot for each supplied real PureTrack test pilot.
    const round = makeRound(runId);
    const slots = round.teams[0]?.pilots ?? [];
    const map = new Map<string, number>();
    for (const [index, slot] of slots.entries()) {
      if (slot.status !== "Filled" || !slot.pilotId) continue;
      const pureTrackId = pilotIds[index];
      if (pureTrackId) map.set(slot.pilotId, pureTrackId);
    }

    // When: createPureTrackGroups drives the real login, group creation, imports, and blob writes.
    createdResult = await createPureTrackGroups(round, map);

    // Then: the returned round/team groups are valid and exist in the authenticated PureTrack API.
    expect(createdResult).not.toBeNull();
    if (!createdResult) throw new Error("PureTrack createPureTrackGroups returned null");
    expect(Number.isInteger(createdResult.roundGroupId)).toBe(true);
    expect(createdResult.roundGroupId).toBeGreaterThan(0);
    expect(createdResult.roundGroupName).toBe(roundGroupName(round.site.name, round.date));
    expect(createdResult.teams).toHaveLength(1);
    const teamResult = createdResult.teams[0];
    if (!teamResult) throw new Error("PureTrack did not return a team group result");
    expect(teamResult.groupId).toBeGreaterThan(0);

    const headers = authHeaders(await authenticate());
    const roundState = await getGroupState(headers, createdResult.roundGroupId);
    const teamState = await getGroupState(headers, teamResult.groupId);

    const expectedExternalIds = [
      String(createdResult.roundGroupId),
      ...createdResult.teams.map((team) => String(team.groupId)),
    ];
    const actualExternalIds = await readPureTrackExternalIds();
    expect(actualExternalIds).toHaveLength(expectedExternalIds.length);
    expect(new Set(actualExternalIds)).toEqual(new Set(expectedExternalIds));

    const roundImport = importResponses.find((response) => response.groupId === createdResult?.roundGroupId);
    expect(roundImport).toBeDefined();
    if (!roundImport) throw new Error("PureTrack round import response was not captured");
    expect(roundImport.failed).toEqual([]);
    for (const ptId of pilotIds) {
      expect(roundImport.found.some((found) => found.split(/\s*=\s*/)[0]?.trim() === String(ptId))).toBe(true);
    }
    expect(roundState.membersCount).toBe(pilotIds.length);
    expect(teamState.membersCount).toBe(pilotIds.length);
  });
});
