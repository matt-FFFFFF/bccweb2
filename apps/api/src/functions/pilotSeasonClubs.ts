import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Pilot, PilotSeasonClub } from "@bccweb/types";
import { ClubSchema, PilotSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  forbiddenResponse,
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

interface PilotClubMap {
  [pilotId: string]: string;
}

// PilotClubMap is a denormalised pilotId→clubId index private to the API.
// No schema in @bccweb/schemas; defined inline so observe-mode validates
// the shape without stripping unknown pilot ids.
const PilotClubMapSchema = z.record(z.string().min(1), z.string().min(1));

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
  const mapPath = `seasons/${year}/pilot-club-map.json`;
  try {
    map = await readJson(
      getPrivateBlobClient(mapPath),
      PilotClubMapSchema,
      mapPath,
    );
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

  // Validate SeasonClub exists. We only need existence here, not the parsed
  // shape — keep this an existence check rather than a schema read so seed
  // fixtures with a partial SeasonClub document (legitimate during migration)
  // still light up the assignment path.
  const seasonClubPath = `season-clubs/${body.seasonYear}/${body.clubId}.json`;
  if (!(await getPrivateBlobClient(seasonClubPath).exists())) {
    throw new HttpError(409, "CLUB_NOT_REGISTERED_FOR_SEASON", "Club is not registered for this season");
  }

  let pilotForScope: Pilot;
  try {
    pilotForScope = await readJson(
      getPrivateBlobClient(`pilots/${body.pilotId}.json`),
      PilotSchema,
      `pilots/${body.pilotId}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "PILOT_NOT_FOUND", "Pilot not found");
    }
    throw err;
  }

  const existingForScope = pilotForScope.seasonClubs.find(sc => sc.seasonYear === body.seasonYear);
  if (existingForScope && reassign && !isAdmin && existingForScope.clubId !== caller.clubId) {
    throw new HttpError(403, "FORBIDDEN", "Cannot reassign pilot from another club");
  }

  await mutationRateLimit(req, caller, "assignPilotSeasonClub", "standard");

  // We need pilot lease to check and update pilot
  return withPrivateLease(`pilots/${body.pilotId}.json`, async (pilotLease) => {
    let pilot: Pilot;
    try {
      pilot = await readJson(
        getPrivateBlobClient(`pilots/${body.pilotId}.json`),
        PilotSchema,
        `pilots/${body.pilotId}.json`,
      );
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
      const club = await readJson(
        getPrivateBlobClient(`clubs/${body.clubId}.json`),
        ClubSchema,
        `clubs/${body.clubId}.json`,
      );
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
    await writePrivateJson(
      `pilots/${body.pilotId}.json`,
      PilotSchema,
      pilot,
      pilotLease,
    );

    // Update denorm map
    const mapPath = `seasons/${body.seasonYear}/pilot-club-map.json`;
    await ensureSentinel(mapPath);
    await withPrivateLease(mapPath, async (mapLease) => {
      let map: PilotClubMap = {};
      try {
        map = await readJson(
          getPrivateBlobClient(mapPath),
          PilotClubMapSchema,
          mapPath,
        );
      } catch (err: unknown) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
      map[body.pilotId] = body.clubId;
      
      await writePrivateJson(mapPath, PilotClubMapSchema, map, mapLease);
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

  let pilotForScope: Pilot;
  try {
    pilotForScope = await readJson(
      getPrivateBlobClient(`pilots/${pilotId}.json`),
      PilotSchema,
      `pilots/${pilotId}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "PILOT_NOT_FOUND", "Pilot not found");
    }
    throw err;
  }

  const existingForScope = pilotForScope.seasonClubs.find(sc => sc.seasonYear === seasonYear);
  if (!existingForScope) return { status: 204 };

  if (isCoord && !isAdmin && existingForScope.clubId !== caller.clubId) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "deletePilotSeasonClub", "standard");

  return withPrivateLease(`pilots/${pilotId}.json`, async (pilotLease) => {
    let pilot: Pilot;
    try {
      pilot = await readJson(
        getPrivateBlobClient(`pilots/${pilotId}.json`),
        PilotSchema,
        `pilots/${pilotId}.json`,
      );
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
    
    await writePrivateJson(
      `pilots/${pilotId}.json`,
      PilotSchema,
      pilot,
      pilotLease,
    );

    const mapPath = `seasons/${seasonYear}/pilot-club-map.json`;
    await ensureSentinel(mapPath);
    await withPrivateLease(mapPath, async (mapLease) => {
      let map: PilotClubMap = {};
      try {
        map = await readJson(
          getPrivateBlobClient(mapPath),
          PilotClubMapSchema,
          mapPath,
        );
      } catch (err: unknown) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }
      
      delete map[pilotId];
      
      await writePrivateJson(mapPath, PilotClubMapSchema, map, mapLease);
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
