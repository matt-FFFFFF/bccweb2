import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { SeasonSummary, Season, SeasonResults } from "@bccweb/types";
import { getBlobClient, readBlob } from "../lib/blob.js";
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
