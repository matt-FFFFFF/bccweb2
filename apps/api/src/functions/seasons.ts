import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { SeasonSummary, Season, SeasonResults } from "@bccweb/types";
import {
  getBlobClient,
  getBlockBlobClient,
  readBlob,
  writeBlob,
} from "../lib/blob.js";
import {
  forbiddenResponse,
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

// ─── GET /api/seasons ─────────────────────────────────────────────────────────

async function getSeasons(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const seasons = await readBlob<SeasonSummary[]>(
      getBlobClient("seasons.json")
    );
    seasons.sort((a, b) => b.year - a.year);
    return { status: 200, jsonBody: seasons };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── GET /api/seasons/{year} ──────────────────────────────────────────────────

async function getSeasonByYear(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const year = req.params["year"];
  if (!year || !/^\d{4}$/.test(year)) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid year");
  }

  try {
    const season = await readBlob<Season>(
      getBlobClient(`seasons/${year}.json`)
    );
    return { status: 200, jsonBody: season };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Season not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── GET /api/seasons/{year}/results ─────────────────────────────────────────

async function getSeasonResults(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const year = req.params["year"];
  if (!year || !/^\d{4}$/.test(year)) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid year");
  }

  try {
    const results = await readBlob<SeasonResults>(
      getBlobClient(`results/${year}.json`)
    );
    return { status: 200, jsonBody: results };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/seasons ────────────────────────────────────────────────────────

interface CreateSeasonBody {
  year?: number;
  active?: boolean;
}

async function createSeason(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  let body: CreateSeasonBody;
  try {
    body = (await req.json()) as CreateSeasonBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new HttpError(400, "INVALID_YEAR", "year must be an integer 2000–9999");
  }

  const seasonPath = `seasons/${year}.json`;
  const existing = await getBlobClient(seasonPath).exists();
  if (existing) {
    throw new HttpError(409, "SEASON_EXISTS", `Season ${year} already exists`);
  }

  const wantActive = body.active === true;
  if (wantActive) {
    await deactivateAllSeasons();
  }

  const season: Season = {
    id: `season-${year}`,
    year,
    active: wantActive,
    rounds: [],
    leagueTable: [],
  };

  await writeBlob(seasonPath, season);
  await upsertSeasonInIndex({ id: season.id, year, active: wantActive });

  return { status: 201, jsonBody: season };
}

// ─── PUT /api/seasons/{year} ──────────────────────────────────────────────────

interface UpdateSeasonBody {
  active?: boolean;
}

async function updateSeason(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const yearStr = req.params["year"];
  if (!yearStr || !/^\d{4}$/.test(yearStr)) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid year");
  }
  const year = Number(yearStr);

  let body: UpdateSeasonBody;
  try {
    body = (await req.json()) as UpdateSeasonBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  let season: Season;
  try {
    season = await readBlob<Season>(getBlobClient(`seasons/${year}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Season not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (typeof body.active === "boolean") {
    if (body.active === true) {
      await deactivateAllSeasons(year);
    }
    season.active = body.active;
  }

  await writeBlob(`seasons/${year}.json`, season);
  await upsertSeasonInIndex({ id: season.id, year, active: season.active });

  return { status: 200, jsonBody: season };
}

// ─── DELETE /api/seasons/{year} ───────────────────────────────────────────────

async function deleteSeason(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();

  const yearStr = req.params["year"];
  if (!yearStr || !/^\d{4}$/.test(yearStr)) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid year");
  }
  const year = Number(yearStr);

  let season: Season;
  try {
    season = await readBlob<Season>(getBlobClient(`seasons/${year}.json`));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      await removeSeasonFromIndex(year);
      return { status: 204 };
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (season.rounds.length > 0) {
    throw new HttpError(
      409,
      "SEASON_HAS_ROUNDS",
      `Cannot delete ${year}: ${season.rounds.length} round(s) still reference it. Delete the rounds first.`
    );
  }

  await getBlockBlobClient(`seasons/${year}.json`).deleteIfExists();
  await getBlockBlobClient(`results/${year}.json`).deleteIfExists();
  await removeSeasonFromIndex(year);

  return { status: 204 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSeasonInIndex(summary: SeasonSummary): Promise<void> {
  let index: SeasonSummary[] = [];
  try {
    index = await readBlob<SeasonSummary[]>(getBlobClient("seasons.json"));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
  const idx = index.findIndex((s) => s.year === summary.year);
  if (idx >= 0) {
    index[idx] = summary;
  } else {
    index.push(summary);
  }
  index.sort((a, b) => b.year - a.year);
  await writeBlob("seasons.json", index);
}

async function removeSeasonFromIndex(year: number): Promise<void> {
  let index: SeasonSummary[] = [];
  try {
    index = await readBlob<SeasonSummary[]>(getBlobClient("seasons.json"));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return;
    throw err;
  }
  const filtered = index.filter((s) => s.year !== year);
  if (filtered.length === index.length) return;
  await writeBlob("seasons.json", filtered);
}

// Active flag is mutually exclusive across all seasons; flips every other to false.
async function deactivateAllSeasons(exceptYear?: number): Promise<void> {
  let index: SeasonSummary[] = [];
  try {
    index = await readBlob<SeasonSummary[]>(getBlobClient("seasons.json"));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return;
    throw err;
  }
  let mutated = false;
  for (const summary of index) {
    if (summary.year === exceptYear) continue;
    if (!summary.active) continue;
    summary.active = false;
    mutated = true;
    try {
      const full = await readBlob<Season>(
        getBlobClient(`seasons/${summary.year}.json`)
      );
      full.active = false;
      await writeBlob(`seasons/${summary.year}.json`, full);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }
  if (mutated) {
    index.sort((a, b) => b.year - a.year);
    await writeBlob("seasons.json", index);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getSeasons", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons",
  handler: withErrorHandler(getSeasons),
});

app.http("getSeasonByYear", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons/{year}",
  handler: withErrorHandler(getSeasonByYear),
});

app.http("getSeasonResults", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons/{year}/results",
  handler: withErrorHandler(getSeasonResults),
});

app.http("createSeason", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "seasons",
  handler: withErrorHandler(createSeason),
});

app.http("updateSeason", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "seasons/{year}",
  handler: withErrorHandler(updateSeason),
});

app.http("deleteSeason", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "seasons/{year}",
  handler: withErrorHandler(deleteSeason),
});
