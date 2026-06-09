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
import { getBlobClient, getPrivateBlobClient, readBlob, writeBlob, writePrivateBlob, withLease, withPrivateLease, getBlockBlobClient, getPrivateBlockBlobClient } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { updateRoundsIndex, recomputeSeason } from "../lib/recompute.js";
import { createPureTrackGroups } from "../lib/puretrack.js";
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
    return {
      status: 400,
      jsonBody: { error: "date, siteId, and seasonYear are required" },
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { status: 400, jsonBody: { error: "date must be yyyy-MM-dd" } };
  }

  // Load site
  let site: Site;
  try {
    site = await readBlob<Site>(getPrivateBlobClient(`sites/${siteId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 400, jsonBody: { error: "Site not found" } };
    }
    throw err;
  }

  // Load season (must exist)
  let season: Season;
  try {
    season = await readBlob<Season>(
      getBlobClient(`seasons/${seasonYear}.json`)
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 400, jsonBody: { error: "Season not found" } };
    }
    throw err;
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
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

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
        throw err;
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
          throw validation;
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
          throw err;
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
    if (e.isValidation) return { status: 409, jsonBody: { error: e.message } };
    if (e.statusCode === 404) return { status: 404, jsonBody: { error: "Round not found" } };
    throw err;
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
        throw err;
      }

      r.status = to;
      if (extra) await extra(r);

      await writePrivateBlob(path, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) return { status: 409, jsonBody: { error: e.message } };
    if (e.statusCode === 404) return { status: 404, jsonBody: { error: "Round not found" } };
    throw err;
  }

  return updated;
}

// ─── POST /api/rounds/{id}/confirm ────────────────────────────────────────────

async function confirmRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  const result = await transition(req, id, ["Proposed"], "Confirmed");
  if ("status" in result && "jsonBody" in result) return result as HttpResponseInit;
  await updateRoundsIndex(result as Round);
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/brief-complete ─────────────────────────────────────

async function briefCompleteRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  const result = await transition(req, id, ["Confirmed"], "BriefComplete");
  if ("status" in result && "jsonBody" in result) return result as HttpResponseInit;
  await updateRoundsIndex(result as Round);
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/lock ───────────────────────────────────────────────

/**
 * Best-effort post-lock async work:
 *  1. Create PureTrack groups → persist IDs back onto round blob
 *  2. Build RoundBrief document
 *  3. Generate PDF
 *  4. Upload brief JSON + PDF to blob storage
 *  5. Send ACS email with PDF attachment
 *
 * Errors are logged but never propagate — the lock response has already been returned.
 */
async function postLockAsync(lockedRound: Round): Promise<void> {
  const roundId = lockedRound.id;
  const logPrefix = `[postLock:${roundId}]`;

  // ── 1. PureTrack groups ──────────────────────────────────────────────────
  let updatedRound = lockedRound;
  try {
    // Collect pilot PureTrack IDs
    const pilotIds = lockedRound.teams.flatMap((t) =>
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
          if (pilot.pureTrackId) {
            pilotPureTrackIds.set(pilotId, pilot.pureTrackId);
          }
        } catch {
          // skip missing pilots
        }
      })
    );

    const ptResult = await createPureTrackGroups(lockedRound, pilotPureTrackIds);
    console.log(
      `${logPrefix} PureTrack groups created: round=${ptResult.roundGroupId}, teams=${ptResult.teams.length}`
    );

    // Persist PureTrack IDs back onto the round blob (under lease)
    const path = `rounds/${roundId}.json`;
    try {
      updatedRound = await withPrivateLease(path, async (leaseId) => {
        const r = await readBlob<Round>(getPrivateBlobClient(path));
        r.pureTrackGroupId = ptResult.roundGroupId;
        r.pureTrackGroupName = ptResult.roundGroupName;
        r.pureTrackGroupSlug = ptResult.roundGroupSlug;
        for (const team of r.teams) {
          const tr = ptResult.teams.find((t) => t.teamId === team.id);
          if (tr) {
            team.pureTrackGroupId = tr.groupId;
            team.pureTrackGroupSlug = tr.groupSlug;
          }
        }
        await writePrivateBlob(path, r, leaseId);
        return r;
      });
    } catch (persistErr) {
      console.error(`${logPrefix} Failed to persist PureTrack IDs:`, persistErr);
      // updatedRound stays as lockedRound — brief will just lack PT slugs
    }
  } catch (ptErr) {
    console.error(`${logPrefix} PureTrack group creation failed:`, ptErr);
    // Non-fatal — continue to brief generation
  }

  // ── 2. Build RoundBrief document ─────────────────────────────────────────
  let brief: RoundBrief;
  try {
    // Try to load full site data for guideUrl / contact info
    let siteGuideUrl: string | undefined;
    try {
      const site = await readBlob<Site>(
        getPrivateBlobClient(`sites/${updatedRound.site.id}.json`)
      );
      siteGuideUrl = site.guideUrl;
    } catch {
      // site details optional
    }

    // Build pilot name map from pilots index
    const pilotsIndex = await readBlob<Array<{ id: string; name: string; bhpaNumber?: number; pureTrackId?: number }>>(
      getBlobClient("pilots.json")
    ).catch(() => [] as Array<{ id: string; name: string; bhpaNumber?: number; pureTrackId?: number }>);
    const pilotNameMap = new Map(pilotsIndex.map((p) => [p.id, p]));

    const briefTeams: BriefTeamEntry[] = updatedRound.teams
      .filter((t) => t.pilots.some((s) => s.status === "Filled"))
      .map((t) => ({
        teamName: t.teamName,
        clubName: t.club.name,
        pureTrackGroupId: t.pureTrackGroupId,
        pureTrackGroupSlug: t.pureTrackGroupSlug,
        pilots: t.pilots
          .filter((s) => s.status === "Filled" && s.pilotId && s.snapshot)
          .map((s) => {
            const pilotMeta = pilotNameMap.get(s.pilotId!);
            return {
              placeInTeam: s.placeInTeam,
              pilotId: s.pilotId!,
              name: pilotMeta?.name ?? s.pilotId!,
              bhpaNumber: pilotMeta?.bhpaNumber,
              pureTrackId: pilotMeta?.pureTrackId,
              isScoring: s.isScoring,
              snapshot: s.snapshot!,
            };
          }),
      }));

    brief = {
      roundId,
      generatedAt: new Date().toISOString(),
      date: updatedRound.date,
      siteName: updatedRound.site.name,
      guideUrl: siteGuideUrl,
      parkingW3W: updatedRound.site.parkingW3W,
      briefingW3W: updatedRound.site.briefingW3W,
      takeOffW3W: updatedRound.site.takeOffW3W,
      briefingTime: updatedRound.briefingTime,
      checkInByTime: updatedRound.checkInByTime,
      landByTime: updatedRound.landByTime,
      organisingClubName: updatedRound.organisingClub?.name,
      pureTrackGroupName: updatedRound.pureTrackGroupName,
      pureTrackGroupSlug: updatedRound.pureTrackGroupSlug,
      teams: briefTeams,
    };
  } catch (briefBuildErr) {
    console.error(`${logPrefix} Failed to build brief document:`, briefBuildErr);
    return; // cannot continue without brief
  }

  // ── 3. Upload brief JSON ──────────────────────────────────────────────────
  try {
    await writePrivateBlob(`round-briefs/${roundId}.json`, brief);
    console.log(`${logPrefix} Brief JSON uploaded`);
  } catch (jsonErr) {
    console.error(`${logPrefix} Failed to upload brief JSON:`, jsonErr);
    // continue — attempt PDF anyway
  }

  // ── 4. Generate and upload PDF ────────────────────────────────────────────
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateBriefPdf(brief);
    console.log(`${logPrefix} PDF generated (${pdfBuffer.length} bytes)`);

    const pdfBlobClient = getPrivateBlockBlobClient(`round-briefs/${roundId}.pdf`);
    await pdfBlobClient.upload(pdfBuffer, pdfBuffer.length, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
      metadata: {
        sitename: brief.siteName,
        date: brief.date,
      },
    });
    console.log(`${logPrefix} PDF uploaded`);
  } catch (pdfErr) {
    console.error(`${logPrefix} PDF generation/upload failed:`, pdfErr);
    // non-fatal — fall through to email (without attachment if PDF failed)
  }

  // ── 5. Send email ─────────────────────────────────────────────────────────
  try {
    const recipients = getBriefRecipients();
    if (recipients.length === 0) {
      console.log(`${logPrefix} No brief email recipients configured — skipping`);
      return;
    }

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
    console.log(`${logPrefix} Brief email sent to ${recipients.join(", ")}`);
  } catch (emailErr) {
    console.error(`${logPrefix} Failed to send brief email:`, emailErr);
  }
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
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

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
      return { status: 404, jsonBody: { error: "Round not found" } };
    }
    throw err;
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

  // Now apply under lease
  let updated: Round;
  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));

      if (r.status !== "BriefComplete") {
        const err = new Error("Round status changed concurrently");
        (err as { isValidation?: boolean }).isValidation = true;
        throw err;
      }

      r.status = "Locked";
      r.isLocked = true;

      for (const team of r.teams) {
        for (const slot of team.pilots) {
          if (slot.pilotId && snapshotMap.has(slot.pilotId)) {
            slot.snapshot = snapshotMap.get(slot.pilotId)!;
          }
          slot.accountedFor = false;
          slot.signToFly = false;
        }
      }

      await writePrivateBlob(path, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) return { status: 409, jsonBody: { error: e.message } };
    throw err;
  }

  await updateRoundsIndex(updated);

  // Fire post-lock async work (PureTrack + PDF + email) — best-effort, non-blocking
  postLockAsync(updated).catch((err) => {
    console.error(`[lockRound] postLockAsync(${updated.id}) threw unexpectedly:`, err);
  });

  return { status: 200, jsonBody: updated };
}

async function unlockRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

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
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const config = await loadConfig();
  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readBlob<Round>(getPrivateBlobClient(path));

      if (r.status !== "Locked") {
        const err = new Error(
          `Round must be Locked to complete (currently ${r.status})`
        );
        (err as { isValidation?: boolean }).isValidation = true;
        throw err;
      }

      const scored = scoreRound(r, config);
      scored.status = "Complete";
      scored.isLocked = false;

      await writePrivateBlob(path, scored, leaseId);
      return scored;
    });
  } catch (err: unknown) {
    const e = err as { isValidation?: boolean; statusCode?: number; message?: string };
    if (e.isValidation) return { status: 409, jsonBody: { error: e.message } };
    if (e.statusCode === 404) return { status: 404, jsonBody: { error: "Round not found" } };
    throw err;
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
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const body = (await req.json()) as { narrative?: string };
  if (body.narrative === undefined) {
    return { status: 400, jsonBody: { error: "narrative is required" } };
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
      return { status: 404, jsonBody: { error: "Round not found" } };
    }
    throw err;
  }

  return { status: 200, jsonBody: updated };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds",
  handler: createRound,
});

app.http("updateRound", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}",
  handler: updateRound,
});

app.http("confirmRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/confirm",
  handler: confirmRound,
});

app.http("briefCompleteRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief-complete",
  handler: briefCompleteRound,
});

app.http("lockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/lock",
  handler: lockRound,
});

app.http("unlockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/unlock",
  handler: unlockRound,
});

app.http("completeRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/complete",
  handler: completeRound,
});

app.http("updateNarrative", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/narrative",
  handler: updateNarrative,
});
