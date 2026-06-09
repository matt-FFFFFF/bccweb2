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
  Round,
  RoundStatus,
  Season,
  Site,
  Config,
  Pilot,
  PilotSnapshot,
  WingClass,
  RoundBrief,
  BriefTeamEntry,
} from "@bccweb/types";
import { normalizeStatus } from "@bccweb/types";
import { scoreRound } from "@bccweb/scoring";
import { getBlobClient, getPrivateBlobClient, readBlob, writeBlob, writePrivateBlob, withLease, withPrivateLease, withPrivateLeaseRenewing, getBlockBlobClient, getPrivateBlockBlobClient } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
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

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Config = {
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
};

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
    return await readBlob<Config>(getPrivateBlobClient("config.json"));
  } catch {
    return DEFAULT_CONFIG;
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

  // Load site
  let site: Site;
  try {
    site = await readBlob<Site>(getPrivateBlobClient(`sites/${siteId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Load season (must exist)
  let season: Season;
  try {
    season = await readBlob<Season>(
      getBlobClient(`seasons/${seasonYear}.json`)
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Season not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Optionally load organising club
  let organisingClub: { id: string; name: string } | undefined;
  if (body.organisingClubId) {
    try {
      const club = await readBlob<{ id: string; name: string }>(
        getPrivateBlobClient(`clubs/${body.organisingClubId}.json`)
      );
      organisingClub = { id: club.id, name: club.name };
    } catch {
      // optional — ignore if not found
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
  await writePrivateBlob(`rounds/${id}.json`, round);

  // Append round ID to season (with lease for atomicity)
  try {
    await withLease(`seasons/${seasonYear}.json`, async (leaseId) => {
      const s = await readBlob<Season>(
        getBlobClient(`seasons/${seasonYear}.json`)
      );
      if (!s.rounds.includes(id)) {
        s.rounds.push(id);
      }
      await writeBlob(`seasons/${seasonYear}.json`, s, leaseId);
    });
  } catch {
    // Season blob just checked to exist — this should not fail; best-effort
    season.rounds.push(id);
    await writeBlob(`seasons/${seasonYear}.json`, season);
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

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));

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
          site = await readBlob<Site>(
            getPrivateBlobClient(`sites/${body.siteId}.json`)
          );
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
          const club = await readBlob<{ id: string; name: string }>(
            getPrivateBlobClient(`clubs/${body.organisingClubId}.json`)
          );
          r.organisingClub = { id: club.id, name: club.name };
        } catch {
          // best-effort
        }
      }

      await writePrivateBlob(path, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
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

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));

      if (!allowedFrom.includes(r.status)) {
        const err = new Error(
          `Expected status ${allowedFrom.join(" or ")}, got ${r.status}`
        );
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      r.status = to;
      if (extra) await extra(r);

      await writePrivateBlob(path, r, leaseId);
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

  const result = await transition(req, id, ["Proposed"], "Confirmed");
  if ("status" in result && "jsonBody" in result) return result as HttpResponseInit;
  const updated = result as Round;
  await updateRoundsIndex(updated);

  // Best-effort: write a skeleton brief blob so the brief-edit UI is usable.
  // `if-none-match: "*"` is atomic create-or-skip — never clobbers an existing
  // brief blob (Azure returns HTTP 412, which we treat as a no-op here).
  try {
    const brief = await buildRoundBrief(updated);
    await writePrivateBlob(
      `round-briefs/${updated.id}.json`,
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

  const result = await transition(req, id, ["Confirmed"], "BriefComplete");
  if ("status" in result && "jsonBody" in result) return result as HttpResponseInit;
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
        const pilot = await readBlob<Pilot>(
          getPrivateBlobClient(`pilots/${pilotId}.json`)
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
  const updated = structuredClone(round) as Round;
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
    const site = await readBlob<Site>(
      getPrivateBlobClient(`sites/${round.site.id}.json`)
    );
    siteGuideUrl = site.guideUrl;
  } catch {
    siteGuideUrl = undefined;
  }

  const pilotsIndex = await readBlob<Array<{ id: string; name: string; bhpaNumber?: number; pureTrackId?: number }>>(
    getBlobClient("pilots.json")
  ).catch(() => [] as Array<{ id: string; name: string; bhpaNumber?: number; pureTrackId?: number }>);
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
              try {
                const pilotDoc = await readBlob<Pilot>(
                  getPrivateBlobClient(`pilots/${s.pilotId!}.json`)
                );
                wingManufacturer = pilotDoc.wingManufacturer;
              } catch {
                wingManufacturer = undefined;
              }
              return {
                placeInTeam: s.placeInTeam,
                pilotId: s.pilotId!,
                name: pilotMeta?.name ?? s.pilotId!,
                bhpaNumber: pilotMeta?.bhpaNumber,
                pureTrackId: pilotMeta?.pureTrackId,
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
  await writePrivateBlob(`round-briefs/${brief.roundId}.json`, brief);
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
    round = await readBlob<Round>(getPrivateBlobClient(path));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

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
        const pilot = await readBlob<Pilot>(
          getPrivateBlobClient(`pilots/${pilotId}.json`)
        );
        snapshotMap.set(pilotId, {
          wingClass: (pilot.wingClass ?? "EN B") as WingClass,
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

  let candidateRound = structuredClone(round) as Round;
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
    const brief = await buildRoundBrief(candidateRound);
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
      const r = await readBlob<RoundWithBriefMetadata>(getPrivateBlobClient(path));

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

      await writePrivateBlob(path, r, leaseId);
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

  const result = await transition(req, id, ["Locked"], "Confirmed", async (r) => {
    r.isLocked = false;
    // Clear snapshots so they are re-taken at next lock
    for (const team of r.teams) {
      for (const slot of team.pilots) {
        slot.snapshot = null;
      }
    }
  });

  if ("status" in result && "jsonBody" in result) return result as HttpResponseInit;
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

  const config = await loadConfig();
  const path = `rounds/${id}.json`;
  let current: Round;

  try {
    current = await readBlob<Round>(getPrivateBlobClient(path));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

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
      const r = await readBlob<Round>(getPrivateBlobClient(path));

      if (r.status !== "Locked") {
        const err = new Error(
          `Round must be Locked to complete (currently ${r.status})`
        );
        (err as { isValidation?: boolean }).isValidation = true;
        throw new HttpError(500, "INTERNAL");
      }

      const scored = structuredClone(scoredSnapshot) as Round;
      scored.status = "Complete";
      scored.isLocked = false;

      await writePrivateBlob(path, scored, leaseId);
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

  const body = (await req.json()) as { narrative?: string };
  if (body.narrative === undefined) {
    throw new HttpError(400, "INVALID_BODY", "narrative is required");
  }

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));
      r.narrative = body.narrative;
      await writePrivateBlob(path, r, leaseId);
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
