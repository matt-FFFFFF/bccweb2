/**
 * PureTrack API integration — Phase 4
 *
 * Implements the same flow as the existing ASP.NET app:
 *  1. Authenticate: POST /api/login → Bearer token + CSRF from login page
 *  2. Create groups: POST /api/groups
 *  3. Import pilots: POST /api/groups/{id}/import-ids
 *
 * Requires environment variables:
 *   PURETRACK_API_KEY  — API key for the BCC PureTrack account
 *   PURETRACK_EMAIL    — PureTrack login email
 *   PURETRACK_PASSWORD — PureTrack login password
 *
 * Group naming convention (matches existing app):
 *   Round group: "BCC {siteName} {ddd dd MMM yy}"
 *   Team group:  "BCC {ddd dd MMM yy} {teamName}"
 */

import { randomUUID } from "crypto";
import type { Round, Team, PureTrackGroup } from "@bccweb/types";
import { writePrivateBlob } from "./blob.js";

/** Outbound PureTrack calls disabled when PURETRACK_ENABLED env equals the
 *  literal string "false". Any other value (including unset) preserves
 *  production behavior. Fail-open by default. */
function isPureTrackEnabled(): boolean {
  return process.env["PURETRACK_ENABLED"] !== "false";
}

const BASE_URL = "https://puretrack.io";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PureTrackApiGroup {
  id: number;
  name: string;
  slug: string;
}

// ─── Session ──────────────────────────────────────────────────────────────────

interface PureTrackSession {
  accessToken: string;
  csrfToken: string;
  cookieHeader: string;
}

async function authenticate(): Promise<PureTrackSession> {
  const apiKey = process.env["PURETRACK_API_KEY"];
  const email = process.env["PURETRACK_EMAIL"];
  const password = process.env["PURETRACK_PASSWORD"];

  if (!apiKey || !email || !password) {
    throw new Error(
      "PURETRACK_API_KEY, PURETRACK_EMAIL, and PURETRACK_PASSWORD must all be set"
    );
  }

  // Step 1: POST /api/login → access_token + session cookie
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: apiKey, email, password }),
  });

  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`PureTrack login failed (${loginRes.status}): ${body}`);
  }

  const loginJson = (await loginRes.json()) as { access_token: string };
  const accessToken = loginJson.access_token;

  // Collect session cookies from the login response
  const rawCookies = loginRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = rawCookies.map((c) => c.split(";")[0]).join("; ");

  // Step 2: GET /login page to extract the XSRF-TOKEN
  const csrfRes = await fetch(`${BASE_URL}/login`, {
    headers: { Cookie: cookieHeader },
  });
  const csrfHtml = await csrfRes.text();

  // Collect any new cookies from the CSRF page
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
  const allCookies = [
    ...rawCookies,
    ...csrfCookies,
  ].map((c) => c.split(";")[0]);
  // De-duplicate by cookie name (last wins)
  const cookieMap = new Map<string, string>();
  for (const c of allCookies) {
    const [name] = c.split("=");
    cookieMap.set(name.trim(), c.trim());
  }
  const finalCookieHeader = [...cookieMap.values()].join("; ");

  // Extract XSRF-TOKEN from HTML meta tag (several patterns tried, mirrors existing app)
  const patterns = [
    /name="XSRF-TOKEN"\s+content="([^"]+)"/,
    /content="([^"]+)"\s+name="XSRF-TOKEN"/,
    /<meta\s+name=['"]XSRF-TOKEN['"]\s+content=['"]([^'"]+)['"]/,
    /<meta name="csrf-token" content="([^"]+)"/,
  ];

  let csrfToken = "";
  for (const pattern of patterns) {
    const match = csrfHtml.match(pattern);
    if (match) {
      csrfToken = match[1];
      break;
    }
  }

  // Also try to extract from cookie (PureTrack sometimes sets XSRF-TOKEN as a cookie)
  if (!csrfToken) {
    for (const c of cookieMap.values()) {
      if (c.startsWith("XSRF-TOKEN=")) {
        csrfToken = decodeURIComponent(c.replace("XSRF-TOKEN=", ""));
        break;
      }
    }
  }

  if (!csrfToken) {
    throw new Error(
      "Could not extract XSRF-TOKEN from PureTrack login page. The page may have changed."
    );
  }

  return { accessToken, csrfToken, cookieHeader: finalCookieHeader };
}

function authHeaders(session: PureTrackSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XSRF-TOKEN": session.csrfToken,
    "Content-Type": "application/json",
    Cookie: session.cookieHeader,
  };
}

// ─── Group creation ───────────────────────────────────────────────────────────

async function createGroup(
  session: PureTrackSession,
  name: string
): Promise<PureTrackApiGroup> {
  const body = {
    id: null,
    name,
    public: true,
    event: false,
    protected: false,
    password: "oshi",
    timezone: "Europe/London",
    slug: name,
    start: null,
    end: null,
  };

  const res = await fetch(`${BASE_URL}/api/groups`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `PureTrack createGroup("${name}") failed (${res.status}): ${err}`
    );
  }

  const json = (await res.json()) as { id: number; name: string; slug: string };
  return { id: json.id, name: json.name, slug: json.slug };
}

// ─── Pilot import ─────────────────────────────────────────────────────────────

async function importPilots(
  session: PureTrackSession,
  groupId: number,
  pureTrackIds: number[]
): Promise<void> {
  if (pureTrackIds.length === 0) return;

  const res = await fetch(`${BASE_URL}/api/groups/${groupId}/import-ids`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ ids: pureTrackIds.join(",") }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `PureTrack importPilots(group=${groupId}) failed (${res.status}): ${err}`
    );
  }
}

// ─── Group name helpers ───────────────────────────────────────────────────────

function formatRoundDate(isoDate: string): string {
  // "BCC Hay Bluff Sat 12 Jul 25"
  return new Date(isoDate + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function roundGroupName(siteName: string, date: string): string {
  return `BCC ${siteName} ${formatRoundDate(date)}`;
}

export function teamGroupName(date: string, teamName: string): string {
  return `BCC ${formatRoundDate(date)} ${teamName}`;
}

// ─── Blob persistence helpers ─────────────────────────────────────────────────

async function writePureTrackGroupBlob(
  group: PureTrackApiGroup,
  pilotIds: string[],
  roundId: string,
  createdAt: string,
  options: { teamId?: string; callerUserId?: string }
): Promise<string> {
  const blobId = randomUUID();
  const record: PureTrackGroup = {
    id: blobId,
    name: group.name,
    slug: group.slug,
    pilotIds,
    roundId,
    createdAt,
    externalId: String(group.id),
    externalUrl: `${BASE_URL}/group/${group.slug}`,
    ...(options.teamId ? { teamId: options.teamId } : {}),
    ...(options.callerUserId ? { createdBy: options.callerUserId } : {}),
  };
  await writePrivateBlob(`puretrack-groups/${blobId}.json`, record);
  return blobId;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PureTrackRoundResult {
  roundGroupId: number;
  roundGroupName: string;
  roundGroupSlug: string;
  teams: Array<{
    teamId: string;
    groupId: number;
    groupSlug: string;
  }>;
}

export interface CreatePureTrackGroupsOptions {
  callerUserId?: string;
}

/**
 * Create PureTrack groups for a locked round.
 *
 * Creates:
 *  - One round-level group (all pilots)
 *  - One group per team (pilots in that team)
 *  - Adds each pilot's PureTrack ID to both their team group and the round group
 *
 * After each successful group creation, persists a PureTrackGroup blob at
 * puretrack-groups/{uuid}.json in the private container.
 *
 * Returns IDs/slugs to store back on the round blob.
 */
export async function createPureTrackGroups(
  round: Round,
  /** Map from pilotId → pureTrackId (only filled pilots with a PureTrack ID) */
  pilotPureTrackIds: Map<string, number>,
  options: CreatePureTrackGroupsOptions = {}
): Promise<PureTrackRoundResult | null> {
  if (!isPureTrackEnabled()) {
    console.log("[puretrack] skipped: PURETRACK_ENABLED=false");
    return null;
  }

  const teamResults: PureTrackRoundResult["teams"] = [];
  const allPureTrackIds: number[] = [];
  const allBccPilotIds: string[] = [];
  const teamImports: Array<{
    team: Team;
    pureTrackIds: number[];
    bccPilotIds: string[];
  }> = [];

  for (const team of round.teams) {
    const filledPilots = team.pilots.filter((s) => s.status === "Filled" && s.pilotId);
    const teamPureTrackIds: number[] = [];
    const teamBccPilotIds: string[] = [];

    for (const slot of filledPilots) {
      const pureTrackId = pilotPureTrackIds.get(slot.pilotId!);
      if (pureTrackId == null || pureTrackId === 0) {
        console.warn("[METRIC] puretrack.skip pilot lacks pureTrackId", { pilotId: slot.pilotId });
        continue;
      }
      teamPureTrackIds.push(pureTrackId);
      teamBccPilotIds.push(slot.pilotId!);
    }

    if (filledPilots.length === 0) continue;

    if (teamPureTrackIds.length > 0) {
      teamImports.push({ team, pureTrackIds: teamPureTrackIds, bccPilotIds: teamBccPilotIds });
    }

    for (let i = 0; i < teamPureTrackIds.length; i++) {
      if (!allPureTrackIds.includes(teamPureTrackIds[i])) {
        allPureTrackIds.push(teamPureTrackIds[i]);
        allBccPilotIds.push(teamBccPilotIds[i]);
      }
    }
  }

  if (allPureTrackIds.length === 0) {
    console.warn("[METRIC] puretrack.skip pilot lacks pureTrackId", { roundId: round.id });
    return null;
  }

  const now = new Date().toISOString();

  let session: PureTrackSession;
  try {
    session = await authenticate();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[METRIC] puretrack.create.failed", { roundId: round.id, reason });
    throw err;
  }

  let roundGroup: PureTrackApiGroup;
  try {
    const gName = roundGroupName(round.site.name, round.date);
    roundGroup = await createGroup(session, gName);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[METRIC] puretrack.create.failed", { roundId: round.id, type: "round-group", reason });
    throw err;
  }

  await writePureTrackGroupBlob(roundGroup, allBccPilotIds, round.id, now, {
    callerUserId: options.callerUserId,
  }).catch((err) => {
    console.warn("[puretrack] Failed to write round group blob:", err);
  });

  for (const { team, pureTrackIds, bccPilotIds } of teamImports) {
    const tName = teamGroupName(round.date, team.teamName);
    // Add small delay between group creations to avoid rate-limit burst (mirrors existing app)
    await new Promise((r) => setTimeout(r, 100));

    let teamGroup: PureTrackApiGroup;
    try {
      teamGroup = await createGroup(session, tName);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[METRIC] puretrack.create.failed", { roundId: round.id, teamId: team.id, type: "team-group", reason });
      throw err;
    }

    await writePureTrackGroupBlob(teamGroup, bccPilotIds, round.id, now, {
      teamId: team.id,
      callerUserId: options.callerUserId,
    }).catch((err) => {
      console.warn("[puretrack] Failed to write team group blob:", err);
    });

    teamResults.push({
      teamId: team.id,
      groupId: teamGroup.id,
      groupSlug: teamGroup.slug,
    });

    await importPilots(session, teamGroup.id, pureTrackIds);
  }

  await importPilots(session, roundGroup.id, allPureTrackIds);

  return {
    roundGroupId: roundGroup.id,
    roundGroupName: roundGroup.name,
    roundGroupSlug: roundGroup.slug,
    teams: teamResults,
  };
}
