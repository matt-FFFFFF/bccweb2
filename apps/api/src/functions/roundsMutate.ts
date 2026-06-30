/**
 * Round write endpoints — Phase 3
 *
 * POST   /api/rounds                       — create round
 * PUT    /api/rounds/{id}                  — update round metadata
 * POST   /api/rounds/{id}/confirm          — Proposed → Confirmed
 * POST   /api/rounds/{id}/brief-complete   — Confirmed → BriefComplete
 * POST   /api/rounds/{id}/lock             — BriefComplete → Locked + snapshot pilots
 * POST   /api/rounds/{id}/unlock           — Locked → Confirmed
 * POST   /api/rounds/{id}/complete         — Locked → Complete + score + recompute
 * POST   /api/rounds/{id}/narrative        — update narrative text
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type {
  CallerIdentity,
  Round,
  RoundStatus,
  Season,
  Site,
  Config,
  PilotSummary,
  PilotSnapshot,
  RoundBrief,
  BriefTeamEntry,
} from "@bccweb/types";
import { normalizeStatus } from "@bccweb/types";
import { scoreRound } from "@bccweb/scoring";
import {
  BriefSchema,
  ConfigSchema,
  PilotSchema,
  PilotSummarySchema,
  RoundSchema,
  SeasonSchema,
  SiteSchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getPrivateBlobClient,
  withLease,
  withPrivateLease,
  withPrivateLeaseRenewing,
  getPrivateBlockBlobClient,
} from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { assertCanManageRound } from "../lib/roundAuth.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { updateRoundsIndex, recomputeSeason } from "../lib/recompute.js";
import { createPureTrackGroups, type PureTrackRoundResult } from "../lib/puretrack.js";
import { generateBriefPdf } from "../lib/pdf.js";
import {
  sendEmail,
  getBriefRecipients,
  briefHtmlBody,
  briefPlainText,
} from "../lib/email.js";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

async function assertManageableRound(
  caller: CallerIdentity,
  id: string,
): Promise<void> {
  const path = `rounds/${id}.json`;
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
  assertCanManageRound(caller, round);
}

// Schemas for blobs without dedicated re-exports.
const PilotSummariesSchema = z.array(PilotSummarySchema);
const ClubRefSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strip();

type RoundWithBriefMetadata = Round & {
  brief?: {
    version?: number;
    jsonPath?: string;
    pdfPath?: string;
    generatedAt?: string;
  };
};

async function loadConfig(): Promise<Config> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
  } catch {
    // Virgin store: ConfigSchema.parse({}) yields the canonical defaults that
    // Task 20 centralised on the schema.
    return ConfigSchema.parse({});
  }
}

// ─── POST /api/rounds ─────────────────────────────────────────────────────────

async function createRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const body = (await req.json()) as {
    date?: string;
    siteId?: string;
    seasonYear?: number;
    organisingClubId?: string;
    maxTeams?: number;
    minimumScore?: number;
    briefingTime?: string;
    landByTime?: string;
    checkInByTime?: string;
    status?: string;
  };

  const { date, siteId, seasonYear } = body;
  if (!date || !siteId || !seasonYear) {
    throw new HttpError(400, "INVALID_BODY", "date, siteId, and seasonYear are required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(400, "INVALID_DATE", "date must be yyyy-MM-dd");
  }

  // A non-admin coord may only organise rounds for their own club, and must have one.
  const isAdmin = caller.roles.includes("Admin");
  if (!isAdmin && !caller.clubId) {
    return forbiddenResponse("Your account is not linked to a club");
  }
  if (!isAdmin && body.organisingClubId && body.organisingClubId !== caller.clubId) {
    return forbiddenResponse("You can only create rounds for your own club");
  }
  const organisingClubId = isAdmin ? body.organisingClubId : caller.clubId;

  await mutationRateLimit(req, caller, "createRound", "standard");

  // Load site
  let site: Site;
  try {
    const sitePath = `sites/${siteId}.json`;
    site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Load season (must exist)
  let season: Season;
  try {
    const seasonPath = `seasons/${seasonYear}.json`;
    season = await readJson(getBlobClient(seasonPath), SeasonSchema, seasonPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Season not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  let organisingClub: { id: string; name: string } | undefined;
  if (organisingClubId) {
    try {
      const clubPath = `clubs/${organisingClubId}.json`;
      const club = await readJson(getPrivateBlobClient(clubPath), ClubRefSchema, clubPath);
      organisingClub = { id: club.id, name: club.name };
    } catch {
      throw new HttpError(400, "CLUB_NOT_FOUND", "Organising club not found");
    }
  }

  const id = randomUUID();
  let roundStatus: RoundStatus;
  try {
    roundStatus = body.status === undefined ? "Proposed" : normalizeStatus(body.status);
  } catch (err: unknown) {
    const message = (err as { message?: string }).message ?? "Unknown status";
    return {
      status: 400,
      jsonBody: {
        error: "Invalid status",
        code: "INVALID_STATUS",
        detail: message,
      },
    };
  }
  const round: Round = {
    id,
    date,
    status: roundStatus,
    isLocked: false,
    maxTeams: body.maxTeams ?? 8,
    minimumScore: body.minimumScore ?? 0,
    briefingTime: body.briefingTime,
    landByTime: body.landByTime,
    checkInByTime: body.checkInByTime,
    site: {
      id: site.id,
      name: site.name,
      parkingW3W: site.parkingW3W,
      briefingW3W: site.briefingW3W,
      takeOffW3W: site.takeOffW3W,
    },
    organisingClub,
    season: { year: Number(seasonYear) },
    teams: [],
  };

  // Write primary round blob
  await writePrivateJson(`rounds/${id}.json`, RoundSchema, round);

  // Append round ID to season (with lease for atomicity)
  try {
    await withLease(`seasons/${seasonYear}.json`, async (leaseId) => {
      const seasonPath = `seasons/${seasonYear}.json`;
      const s = await readJson(getBlobClient(seasonPath), SeasonSchema, seasonPath);
      if (!s.rounds.includes(id)) {
        s.rounds.push(id);
      }
      await writeJson(seasonPath, SeasonSchema, s, leaseId);
    });
  } catch {
    // Season blob just checked to exist — this should not fail; best-effort
    season.rounds.push(id);
    await writeJson(`seasons/${seasonYear}.json`, SeasonSchema, season);
  }

  // Update rounds.json index
  await updateRoundsIndex(round);

  return { status: 201, jsonBody: round };
}

// ─── PUT /api/rounds/{id} ─────────────────────────────────────────────────────

async function updateRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  await assertManageableRound(caller, id);

  const body = (await req.json()) as {
    date?: string;
    siteId?: string;
    organisingClubId?: string;
    maxTeams?: number;
    minimumScore?: number;
    briefingTime?: string;
    landByTime?: string;
    checkInByTime?: string;
    status?: string;
  };

  if (
    !caller.roles.includes("Admin") &&
    body.organisingClubId &&
    body.organisingClubId !== caller.clubId
  ) {
    return forbiddenResponse("You can only assign rounds to your own club");
  }

  await mutationRateLimit(req, caller, "updateRound", "standard");

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      if (r.isLocked) {
        const err = new Error("Round is locked — unlock before editing");
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      if (body.date) r.date = body.date;
      if (body.maxTeams !== undefined) r.maxTeams = body.maxTeams;
      if (body.minimumScore !== undefined) r.minimumScore = body.minimumScore;
      if (body.briefingTime !== undefined) r.briefingTime = body.briefingTime;
      if (body.landByTime !== undefined) r.landByTime = body.landByTime;
      if (body.checkInByTime !== undefined)
        r.checkInByTime = body.checkInByTime;

      if (body.status !== undefined) {
        try {
          r.status = normalizeStatus(body.status);
        } catch (err: unknown) {
          const message = (err as { message?: string }).message ?? "Unknown status";
          const validation = new Error(message);
          (validation as { isValidation?: boolean }).isValidation = true;
          throw new HttpError(500, "INTERNAL");
        }
      }

      // Update site if changed
      if (body.siteId && body.siteId !== r.site.id) {
        let site: Site;
        try {
          const sitePath = `sites/${body.siteId}.json`;
          site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
        } catch {
          const err = new Error("Site not found");
          (err as { isValidation?: boolean }).isValidation = true;
          throw new HttpError(500, "INTERNAL");
        }
        r.site = {
          id: site.id,
          name: site.name,
          parkingW3W: site.parkingW3W,
          briefingW3W: site.briefingW3W,
          takeOffW3W: site.takeOffW3W,
        };
      }

      if (body.organisingClubId) {
        try {
          const clubPath = `clubs/${body.organisingClubId}.json`;
          const club = await readJson(getPrivateBlobClient(clubPath), ClubRefSchema, clubPath);
          r.organisingClub = { id: club.id, name: club.name };
        } catch {
          throw new HttpError(400, "CLUB_NOT_FOUND", "Organising club not found");
        }
      }

      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.message?.startsWith("Unknown status: ")) {
      return {
        status: 400,
        jsonBody: {
          error: "Invalid status",
          code: "INVALID_STATUS",
          detail: e.message,
        },
      };
    }
    if (e.isValidation) throw new HttpError(409, "CONFLICT", e.message);
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  await updateRoundsIndex(updated);
  return { status: 200, jsonBody: updated };
}

// ─── Generic status transition helper ────────────────────────────────────────

async function transition(
  req: HttpRequest,
  id: string,
  allowedFrom: RoundStatus[],
  to: RoundStatus,
  extra?: (round: Round) => Promise<void>
): Promise<HttpResponseInit | Round> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  await assertManageableRound(caller, id);

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      if (!allowedFrom.includes(r.status)) {
        const err = new Error(
          `Expected status ${allowedFrom.join(" or ")}, got ${r.status}`
        );
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      r.status = to;
      if (extra) await extra(r);

      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) throw new HttpError(409, "CONFLICT", e.message);
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  return updated;
}

// ─── POST /api/rounds/{id}/confirm ────────────────────────────────────────────

async function confirmRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "confirmRound", "standard");

  const result = await transition(req, id, ["Proposed"], "Confirmed");
  if ("status" in result && "jsonBody" in result) return result;
  const updated = result as Round;
  await updateRoundsIndex(updated);

  // Best-effort: write a skeleton brief blob so the brief-edit UI is usable.
  // `if-none-match: "*"` is atomic create-or-skip — never clobbers an existing
  // brief blob (Azure returns HTTP 412, which we treat as a no-op here).
  try {
    const brief = await buildRoundBrief(updated);
    await writePrivateJson(
      `round-briefs/${updated.id}.json`,
      BriefSchema,
      brief,
      undefined,
      { ifNoneMatch: "*" }
    );
  } catch (briefErr) {
    console.warn(`[confirmRound:${updated.id}] Skeleton brief creation skipped:`, briefErr);
  }

  return { status: 200, jsonBody: updated };
}

// ─── POST /api/rounds/{id}/brief-complete ─────────────────────────────────────

async function briefCompleteRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "briefCompleteRound", "standard");

  const result = await transition(req, id, ["Confirmed"], "BriefComplete");
  if ("status" in result && "jsonBody" in result) return result;
  await updateRoundsIndex(result as Round);
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/lock ───────────────────────────────────────────────

async function loadPilotPureTrackIds(round: Round): Promise<Map<string, number>> {
  const pilotIds = round.teams.flatMap((t) =>
    t.pilots
      .filter((s) => s.status === "Filled" && s.pilotId)
      .map((s) => s.pilotId!)
  );
  const uniquePilotIds = [...new Set(pilotIds)];
  const pilotPureTrackIds = new Map<string, number>();

  await Promise.all(
    uniquePilotIds.map(async (pilotId) => {
      try {
        const pilotPath = `pilots/${pilotId}.json`;
        const pilot = await readJson(
          getPrivateBlobClient(pilotPath),
          PilotSchema,
          pilotPath,
        );
        if (pilot.pureTrackId != null) pilotPureTrackIds.set(pilotId, pilot.pureTrackId);
      } catch {
        return;
      }
    })
  );

  return pilotPureTrackIds;
}

function applyPureTrackResult(round: Round, ptResult: PureTrackRoundResult): Round {
  const updated = structuredClone(round);
  updated.pureTrackGroupId = ptResult.roundGroupId;
  updated.pureTrackGroupName = ptResult.roundGroupName;
  updated.pureTrackGroupSlug = ptResult.roundGroupSlug;
  for (const team of updated.teams) {
    const tr = ptResult.teams.find((t) => t.teamId === team.id);
    if (tr) {
      team.pureTrackGroupId = tr.groupId;
      team.pureTrackGroupSlug = tr.groupSlug;
    }
  }
  return updated;
}

async function buildRoundBrief(round: Round): Promise<RoundBrief> {
  let siteGuideUrl: string | undefined;
  try {
    const sitePath = `sites/${round.site.id}.json`;
    const site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
    siteGuideUrl = site.guideUrl;
  } catch {
    siteGuideUrl = undefined;
  }

  const pilotsIndex = await readJson(
    getBlobClient("pilots.json"),
    PilotSummariesSchema,
    "pilots.json",
  ).catch(() => [] as PilotSummary[]);
  const pilotNameMap = new Map(pilotsIndex.map((p) => [p.id, p]));

  const teams: BriefTeamEntry[] = await Promise.all(
    round.teams
      .filter((t) => t.pilots.some((s) => s.status === "Filled"))
      .map(async (t) => ({
        teamName: t.teamName,
        clubName: t.club.name,
        pureTrackGroupId: t.pureTrackGroupId,
        pureTrackGroupSlug: t.pureTrackGroupSlug,
        pilots: await Promise.all(
          t.pilots
            .filter((s) => s.status === "Filled" && s.pilotId && s.snapshot)
            .map(async (s) => {
              const pilotMeta = pilotNameMap.get(s.pilotId!);
               let wingManufacturer;
               let bhpaNumber;
               let pureTrackId;
               try {
                 const pilotPath = `pilots/${s.pilotId!}.json`;
                 const pilotDoc = await readJson(
                   getPrivateBlobClient(pilotPath),
                   PilotSchema,
                   pilotPath,
                 );
                 wingManufacturer = pilotDoc.wingManufacturer;
                 bhpaNumber = pilotDoc.bhpaNumber;
                 pureTrackId = pilotDoc.pureTrackId;
               } catch {
                 wingManufacturer = undefined;
               }
               return {
                 placeInTeam: s.placeInTeam,
                 pilotId: s.pilotId!,
                 name: pilotMeta?.name ?? s.pilotId!,
                 bhpaNumber,
                 pureTrackId,
                 ...(wingManufacturer ? { wingManufacturer } : {}),
                 isScoring: s.isScoring,
                 snapshot: s.snapshot!,
               };
            })
        ),
      }))
  );

  return {
    roundId: round.id,
    generatedAt: new Date().toISOString(),
    date: round.date,
    siteName: round.site.name,
    guideUrl: siteGuideUrl,
    parkingW3W: round.site.parkingW3W,
    briefingW3W: round.site.briefingW3W,
    takeOffW3W: round.site.takeOffW3W,
    briefingTime: round.briefingTime,
    checkInByTime: round.checkInByTime,
    landByTime: round.landByTime,
    organisingClubName: round.organisingClub?.name,
    pureTrackGroupName: round.pureTrackGroupName,
    pureTrackGroupSlug: round.pureTrackGroupSlug,
    teams,
  };
}

async function uploadBriefArtifacts(brief: RoundBrief): Promise<Buffer> {
  await writePrivateJson(`round-briefs/${brief.roundId}.json`, BriefSchema, brief);
  const pdfBuffer = await generateBriefPdf(brief);
  const pdfBlobClient = getPrivateBlockBlobClient(`round-briefs/${brief.roundId}.pdf`);
  await pdfBlobClient.upload(pdfBuffer, pdfBuffer.length, {
    blobHTTPHeaders: { blobContentType: "application/pdf" },
    metadata: {
      sitename: brief.siteName,
      date: brief.date,
    },
  });
  return pdfBuffer;
}

async function readExistingBriefForLock(id: string): Promise<RoundBrief | null> {
  const path = `round-briefs/${id}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw new HttpError(500, "INTERNAL");
  }
}

async function mergeBriefForLock(
  round: Round,
  existing: RoundBrief | null
): Promise<RoundBrief> {
  const derived = await buildRoundBrief(round);
  if (!existing) return derived;
  // Preserve coordinator-authored narrative fields and version metadata while
  // refreshing every derived field. Field list mirrors RoundBrief lines 471-485
  // in packages/types/src/index.ts: any future narrative field added there must
  // be added here too or it will be silently dropped on lock.
  return {
    ...derived,
    windSpeedDirection: existing.windSpeedDirection,
    directionOfFlight: existing.directionOfFlight,
    expectedLandingArea: existing.expectedLandingArea,
    airspaceAndHazards: existing.airspaceAndHazards,
    NOTAMs: existing.NOTAMs,
    BENO_LineDescription: existing.BENO_LineDescription,
    briefersNotes: existing.briefersNotes,
    briefer: existing.briefer,
    imagePaths: existing.imagePaths,
    version: existing.version,
    versionHistory: existing.versionHistory,
  };
}

async function sendBriefIfConfigured(brief: RoundBrief, pdfBuffer: Buffer | null): Promise<void> {
  const recipients = getBriefRecipients();
  if (recipients.length === 0) return;

  const dateDisplay = new Date(brief.date + "T00:00:00Z").toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
  );

  await sendEmail({
    to: recipients,
    subject: `BCC Round Brief — ${brief.siteName} — ${dateDisplay}`,
    html: briefHtmlBody(brief.siteName, dateDisplay),
    text: briefPlainText(brief.siteName, dateDisplay),
    attachments: pdfBuffer
      ? [
          {
            name: `BCC-Brief-${brief.siteName.replace(/\s+/g, "-")}-${brief.date}.pdf`,
            contentType: "application/pdf",
            data: pdfBuffer,
          },
        ]
      : undefined,
  });
}

/**
 * BriefComplete → Locked.
 * Takes a snapshot of each registered pilot's safety/scoring data from
 * their pilot document. Resets accountedFor and signToFly for all slots.
 * After the lock is confirmed, fires async: PureTrack groups → PDF → email.
 */
async function lockRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const path = `rounds/${id}.json`;

  // Read round first (outside lease) to gather pilot IDs
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  assertCanManageRound(caller, round);
  await mutationRateLimit(req, caller, "lockRound", "heavy");

  if (round.status !== "BriefComplete") {
    return {
      status: 409,
      jsonBody: {
        error: `Round must be BriefComplete to lock (currently ${round.status})`,
      },
    };
  }

  // Load pilot snapshots in parallel (outside the lease — avoids 30s timeout)
  const pilotIds = round.teams.flatMap((t) =>
    t.pilots.filter((s) => s.pilotId && s.status === "Filled").map((s) => s.pilotId!)
  );
  const uniquePilotIds = [...new Set(pilotIds)];

  const snapshotMap = new Map<string, PilotSnapshot>();
  await Promise.all(
    uniquePilotIds.map(async (pilotId) => {
      try {
        const pilotPath = `pilots/${pilotId}.json`;
        const pilot = await readJson(
          getPrivateBlobClient(pilotPath),
          PilotSchema,
          pilotPath,
        );
        snapshotMap.set(pilotId, {
          wingClass: (pilot.wingClass ?? "EN B"),
          pilotRating: pilot.pilotRating,
          phoneNumber: pilot.person?.phoneNumber,
          helmetColour: pilot.helmetColour,
          harnessType: pilot.harnessType,
          harnessColour: pilot.harnessColour,
          wingManufacturer: pilot.wingManufacturer?.name,
          wingModel: pilot.wingModel,
          wingColours: pilot.wingColours,
          emergencyContactName: pilot.emergencyContactName,
          emergencyPhoneNumber: pilot.emergencyPhoneNumber,
          medicalInfo: pilot.medicalInfo,
        });
      } catch {
        // pilot not found — snapshot stays null; log and continue
      }
    })
  );

  let candidateRound = structuredClone(round);
  candidateRound.status = "Locked";
  candidateRound.isLocked = true;
  for (const team of candidateRound.teams) {
    for (const slot of team.pilots) {
      if (slot.pilotId && snapshotMap.has(slot.pilotId)) {
        slot.snapshot = snapshotMap.get(slot.pilotId)!;
      }
      slot.accountedFor = false;
      slot.signToFly = false;
    }
  }

  let ptResult: PureTrackRoundResult | null = null;
  try {
    const pilotPureTrackIds = await loadPilotPureTrackIds(candidateRound);
    ptResult = await createPureTrackGroups(candidateRound, pilotPureTrackIds);
    if (ptResult) {
      candidateRound = applyPureTrackResult(candidateRound, ptResult);
    }
    console.log(
      ptResult
        ? `[lockRound:${id}] PureTrack groups created: round=${ptResult.roundGroupId}, teams=${ptResult.teams.length}`
        : `[lockRound:${id}] PureTrack skipped: no pilots with pureTrackId`
    );
  } catch (ptErr) {
    console.error(`[lockRound:${id}] PureTrack group creation failed:`, ptErr);
  }

  const briefPaths = {
    jsonPath: `round-briefs/${id}.json`,
    pdfPath: `round-briefs/${id}.pdf`,
    generatedAt: undefined as string | undefined,
  };
  try {
    const existing = await readExistingBriefForLock(id);
    const brief = await mergeBriefForLock(candidateRound, existing);
    briefPaths.generatedAt = brief.generatedAt;
    const pdfBuffer = await uploadBriefArtifacts(brief);
    await sendBriefIfConfigured(brief, pdfBuffer);
    console.log(`[lockRound:${id}] Brief artifacts generated and email processed`);
  } catch (briefErr) {
    console.error(`[lockRound:${id}] Brief artifact/email processing failed:`, briefErr);
  }

  let updated: Round;
  try {
    updated = await withPrivateLeaseRenewing(path, async (leaseId) => {
      const r = (await readJson(
        getPrivateBlobClient(path),
        RoundSchema,
        path,
      )) as RoundWithBriefMetadata;

      if (r.status !== "BriefComplete") {
        const err = new Error("Round status changed concurrently");
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      r.status = "Locked";
      r.isLocked = true;

      if (ptResult) {
        r.pureTrackGroupId = ptResult.roundGroupId;
        r.pureTrackGroupName = ptResult.roundGroupName;
        r.pureTrackGroupSlug = ptResult.roundGroupSlug;
      }

      for (const team of r.teams) {
        if (ptResult) {
          const tr = ptResult.teams.find((t) => t.teamId === team.id);
          if (tr) {
            team.pureTrackGroupId = tr.groupId;
            team.pureTrackGroupSlug = tr.groupSlug;
          }
        }
        for (const slot of team.pilots) {
          if (slot.pilotId && snapshotMap.has(slot.pilotId)) {
            slot.snapshot = snapshotMap.get(slot.pilotId)!;
          }
          slot.accountedFor = false;
          slot.signToFly = false;
        }
      }

      r.brief = {
        version: (r.brief?.version ?? 0) + 1,
        jsonPath: briefPaths.jsonPath,
        pdfPath: briefPaths.pdfPath,
        generatedAt: briefPaths.generatedAt,
      };

      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) throw new HttpError(409, "CONFLICT", e.message);
    throw new HttpError(500, "INTERNAL");
  }

  await updateRoundsIndex(updated);

  return { status: 200, jsonBody: updated };
}

async function unlockRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "unlockRound", "standard");

  // eslint-disable-next-line @typescript-eslint/require-await -- transition()'s `extra` slot is typed (round: Round) => Promise<void>; this mutator is synchronous but the Promise-returning shape is required by that signature.
  const result = await transition(req, id, ["Locked"], "Confirmed", async (r) => {
    r.isLocked = false;
    // Clear snapshots so they are re-taken at next lock
    for (const team of r.teams) {
      for (const slot of team.pilots) {
        slot.snapshot = null;
      }
    }
  });

  if ("status" in result && "jsonBody" in result) return result;
  await updateRoundsIndex(result as Round);
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/complete ───────────────────────────────────────────
/**
 * Locked → Complete.
 * Runs scoreRound(), sets isLocked = false, then recomputes season derived
 * blobs (league table + results). The recompute is best-effort — the round
 * is already marked Complete before it runs.
 */
async function completeRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const path = `rounds/${id}.json`;
  let current: Round;

  try {
    current = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  assertCanManageRound(caller, current);
  await mutationRateLimit(req, caller, "completeRound", "heavy");

  const config = await loadConfig();

  if (current.status !== "Locked") {
    return {
      status: 409,
      jsonBody: {
        error: `Round must be Locked to complete (currently ${current.status})`,
      },
    };
  }

  const scoredSnapshot = scoreRound(current, config);
  let updated: Round;

  try {
    updated = await withPrivateLeaseRenewing(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      if (r.status !== "Locked") {
        const err = new Error(
          `Round must be Locked to complete (currently ${r.status})`
        );
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      const scored = structuredClone(scoredSnapshot);
      scored.status = "Complete";
      scored.isLocked = false;

      await writePrivateJson(path, RoundSchema, scored, leaseId);
      return scored;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) throw new HttpError(409, "CONFLICT", e.message);
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  // Update index first so public data is immediately correct
  await updateRoundsIndex(updated);

  // Recompute season derived blobs (best-effort — don't fail the response)
  recomputeSeason(updated.season.year).catch((err) => {
    console.error(
      `[completeRound] recomputeSeason(${updated.season.year}) failed:`,
      err
    );
  });

  return { status: 200, jsonBody: updated };
}

// ─── POST /api/rounds/{id}/narrative ─────────────────────────────────────────

async function updateNarrative(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "updateNarrative", "standard");

  const body = (await req.json()) as { narrative?: string };
  if (body.narrative === undefined) {
    throw new HttpError(400, "INVALID_BODY", "narrative is required");
  }

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      r.narrative = body.narrative;
      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  return { status: 200, jsonBody: updated };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds",
  handler: withErrorHandler(createRound),
});

app.http("updateRound", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}",
  handler: withErrorHandler(updateRound),
});

app.http("confirmRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/confirm",
  handler: withErrorHandler(confirmRound),
});

app.http("briefCompleteRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief-complete",
  handler: withErrorHandler(briefCompleteRound),
});

app.http("lockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/lock",
  handler: withErrorHandler(lockRound),
});

app.http("unlockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/unlock",
  handler: withErrorHandler(unlockRound),
});

app.http("completeRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/complete",
  handler: withErrorHandler(completeRound),
});

app.http("updateNarrative", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/narrative",
  handler: withErrorHandler(updateNarrative),
});
