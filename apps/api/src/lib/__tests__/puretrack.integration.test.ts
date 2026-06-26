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
} catch {
  /* skip */
}

const BASE_URL = "https://puretrack.io";
const GROUP_BLOB_PREFIX = "puretrack-groups/";

const hasCreds = !!(
  process.env["PURETRACK_API_KEY"] &&
  process.env["PURETRACK_EMAIL"] &&
  process.env["PURETRACK_PASSWORD"] &&
  process.env["PURETRACK_TEST_PILOT_IDS"]
);

const pilotIds = (process.env["PURETRACK_TEST_PILOT_IDS"] ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

type CreatedGroup = {
  readonly id: number;
  readonly slug: string;
};

type PureTrackSession = {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly cookieHeader: string;
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

function parseGroupResponseId(value: unknown): number {
  if (typeof value !== "object" || value === null || !("data" in value)) throw new Error("PureTrack group response did not include data");
  const data = value.data;
  if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "number") return data.id;
  throw new Error("PureTrack group response did not include data.id");
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

  async function expectGroupExists(headers: Record<string, string>, id: number): Promise<void> {
    const res = await realFetch(`${BASE_URL}/api/groups/${id}`, { headers });
    expect(res.status).toBe(200);
    expect(parseGroupResponseId(await res.json())).toBe(id);
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
      return res;
    };
  });

  afterAll(async () => {
    if (!hasCreds) return;
    try {
      const headers = authHeaders(await authenticate());
      const uniqueGroups = [...new Map(createdGroups.map((group) => [group.id, group])).values()];

      for (const { id, slug } of uniqueGroups) {
        const url = `${BASE_URL}/api/groups/${id}`;
        let del: Response;
        try {
          del = await realFetch(url, { method: "DELETE", headers });
        } catch (err) { console.warn("[ITEST] manual cleanup needed", { id, slug, url }); throw err; }
        expect(del.status).toBe(200);

        let after: Response;
        try {
          after = await realFetch(url, { headers });
        } catch (err) { console.warn("[ITEST] manual cleanup needed", { id, slug, url }); throw err; }
        expect(after.status).toBe(404);
        console.info("[ITEST] teardown deleted", { id, slug, url });
      }

      await realFetch(`${BASE_URL}/api/logout`, { headers }).catch(() => {});
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("creates round and team groups through the real PureTrack API when credentials are present", async () => {
    // Given: a locked round with one filled BCC slot for each supplied real PureTrack test pilot.
    expect(pilotIds.length).toBeGreaterThan(0);
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
    expect(teamResult?.groupId).toBeGreaterThan(0);

    const headers = authHeaders(await authenticate());
    await expectGroupExists(headers, createdResult.roundGroupId);
    for (const team of createdResult.teams) await expectGroupExists(headers, team.groupId);

    const expectedExternalIds = [
      String(createdResult.roundGroupId),
      ...createdResult.teams.map((team) => String(team.groupId)),
    ];
    const actualExternalIds = await readPureTrackExternalIds();
    expect(actualExternalIds).toHaveLength(expectedExternalIds.length);
    expect(new Set(actualExternalIds)).toEqual(new Set(expectedExternalIds));
  });
});
