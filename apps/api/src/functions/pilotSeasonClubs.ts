import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Pilot, PilotSeasonClub } from "@bccweb/types";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
  writePrivateBlob,
  withPrivateLease,
} from "../lib/blob.js";
import {
  forbiddenResponse,
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

interface PilotClubMap {
  [pilotId: string]: string;
}

interface AssignBody {
  pilotId: string;
  clubId: string;
  seasonYear: number;
}

function parseYear(req: HttpRequest): number {
  const raw = req.query.get("year");
  if (!raw) throw new HttpError(400, "MISSING_YEAR", "Missing year parameter");
  const year = Number.parseInt(raw, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid season year");
  }
  return year;
}

async function getPilotSeasonClubs(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");
  if (!isAdmin && !isCoord) return forbiddenResponse();

  const year = parseYear(req);
  
  let map: PilotClubMap;
  try {
    map = await readBlob<PilotClubMap>(getPrivateBlobClient(`seasons/${year}/pilot-club-map.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      _ctx.warn(`[pilotSeasonClubs] pilot-club-map.json not found for ${year}, returning empty or scanning`);
      map = {};
    } else {
      throw err;
    }
  }

  const results = Object.entries(map).map(([pilotId, clubId]) => ({ pilotId, clubId, seasonYear: year }));

  if (isCoord && !isAdmin) {
    const visible = results.filter(r => r.clubId === caller.clubId);
    return { status: 200, jsonBody: visible };
  }

  return { status: 200, jsonBody: results };
}

async function assignPilotSeasonClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");
  if (!isAdmin && !isCoord) return forbiddenResponse();

  const reassign = req.query.get("reassign") === "true";

  let body: AssignBody;
  try {
    body = await req.json() as AssignBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.pilotId || !body.clubId || !body.seasonYear) {
    throw new HttpError(400, "INVALID_BODY", "pilotId, clubId, seasonYear required");
  }

  if (isCoord && !isAdmin && body.clubId !== caller.clubId) {
    return forbiddenResponse();
  }

  // Validate SeasonClub exists
  try {
    await readBlob(getPrivateBlobClient(`season-clubs/${body.seasonYear}/${body.clubId}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(409, "CLUB_NOT_REGISTERED_FOR_SEASON", "Club is not registered for this season");
    }
    throw err;
  }

  // We need pilot lease to check and update pilot
  return withPrivateLease(`pilots/${body.pilotId}.json`, async (pilotLease) => {
    let pilot: Pilot;
    try {
      pilot = await readBlob<Pilot>(getPrivateBlobClient(`pilots/${body.pilotId}.json`));
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "PILOT_NOT_FOUND", "Pilot not found");
      }
      throw err;
    }

    const existing = pilot.seasonClubs.find(sc => sc.seasonYear === body.seasonYear);
    if (existing) {
      if (!reassign) {
        throw new HttpError(409, "PILOT_ALREADY_ASSIGNED", `Pilot already assigned to club: ${existing.clubId}`);
      }
      // If reassigned by a coord, wait, can a coord reassign a pilot that is in ANOTHER club? No, unless they are admin.
      if (!isAdmin && existing.clubId !== caller.clubId) {
         // coord can only steal from another club if...? Legacy behavior: Admin only initially. Wait, instruction says:
         // "POST /api/manage/pilot-season-clubs (Admin only initially; RoundsCoord can assign to their OWN club only)"
         // Actually, if a pilot is already assigned to a DIFFERENT club, should a coord be able to reassign them to their own club?
         // Let's restrict reassigning from another club to Admin only to be safe, or just return 403.
         // Actually, the legacy behavior usually means coord can assign to their own club. If the pilot is in another club, 403.
         throw new HttpError(403, "FORBIDDEN", "Cannot reassign pilot from another club");
      }
      
      pilot.seasonClubs = pilot.seasonClubs.filter(sc => sc.seasonYear !== body.seasonYear);
    }

    // Get club name (we can get it from clubs or just from seasonClub, wait, seasonClub doesn't have clubName. Let's read club)
    let clubName = body.clubId;
    try {
      const club = await readBlob<{ name: string }>(getPrivateBlobClient(`clubs/${body.clubId}.json`));
      clubName = club.name;
    } catch {
      // ignore
    }

    const newAssignment: PilotSeasonClub = {
      seasonYear: body.seasonYear,
      clubId: body.clubId,
      clubName: clubName
    };

    pilot.seasonClubs.push(newAssignment);
    
    // Update Pilot
    await writePrivateBlob(`pilots/${body.pilotId}.json`, pilot, pilotLease);

    // Update denorm map
    const mapPath = `seasons/${body.seasonYear}/pilot-club-map.json`;
    await ensureSentinel(mapPath);
    await withPrivateLease(mapPath, async (mapLease) => {
      let map: PilotClubMap = {};
      try {
        map = await readBlob<PilotClubMap>(getPrivateBlobClient(mapPath));
      } catch (err: unknown) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
      map[body.pilotId] = body.clubId;
      
      await writePrivateBlob(mapPath, map, mapLease);
    });

    return { status: 201, jsonBody: newAssignment };
  });
}

async function ensureSentinel(path: string): Promise<void> {
    const client = getPrivateBlockBlobClient(path);
    try {
        await client.upload(Buffer.from("{}"), 2, {
            blobHTTPHeaders: { blobContentType: "application/json" },
            conditions: { ifNoneMatch: "*" }
        });
    } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode !== 409 && statusCode !== 412) throw err;
    }
}

async function deletePilotSeasonClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  const isAdmin = caller.roles.includes("Admin");
  const isCoord = caller.roles.includes("RoundsCoord");
  if (!isAdmin && !isCoord) return forbiddenResponse();

  const pilotId = req.params["pilotId"];
  const seasonYearRaw = req.params["seasonYear"];
  if (!pilotId || !seasonYearRaw) throw new HttpError(400, "BAD_REQUEST", "Missing params");
  const seasonYear = Number.parseInt(seasonYearRaw, 10);

  return withPrivateLease(`pilots/${pilotId}.json`, async (pilotLease) => {
    let pilot: Pilot;
    try {
      pilot = await readBlob<Pilot>(getPrivateBlobClient(`pilots/${pilotId}.json`));
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "PILOT_NOT_FOUND", "Pilot not found");
      }
      throw err;
    }

    const existing = pilot.seasonClubs.find(sc => sc.seasonYear === seasonYear);
    if (!existing) return { status: 204 };

    if (isCoord && !isAdmin && existing.clubId !== caller.clubId) {
      return forbiddenResponse();
    }

    pilot.seasonClubs = pilot.seasonClubs.filter(sc => sc.seasonYear !== seasonYear);
    
    await writePrivateBlob(`pilots/${pilotId}.json`, pilot, pilotLease);

    const mapPath = `seasons/${seasonYear}/pilot-club-map.json`;
    await ensureSentinel(mapPath);
    await withPrivateLease(mapPath, async (mapLease) => {
      let map: PilotClubMap = {};
      try {
        map = await readBlob<PilotClubMap>(getPrivateBlobClient(mapPath));
      } catch (err: unknown) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
      
      delete map[pilotId];
      
      await writePrivateBlob(mapPath, map, mapLease);
    });

    return { status: 204 };
  });
}

app.http("getPilotSeasonClubs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/pilot-season-clubs",
  handler: withErrorHandler(getPilotSeasonClubs),
});

app.http("assignPilotSeasonClub", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/pilot-season-clubs",
  handler: withErrorHandler(assignPilotSeasonClub),
});

app.http("deletePilotSeasonClub", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "manage/pilot-season-clubs/{pilotId}/{seasonYear}",
  handler: withErrorHandler(deletePilotSeasonClub),
});
