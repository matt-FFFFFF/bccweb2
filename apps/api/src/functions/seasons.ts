import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { SeasonSummary, Season, SeasonResults } from "@bccweb/types";
import { getBlobClient, readBlob } from "../lib/blob.js";

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
    throw err;
  }
}

// ─── GET /api/seasons/{year} ──────────────────────────────────────────────────

async function getSeasonByYear(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const year = req.params["year"];
  if (!year || !/^\d{4}$/.test(year)) {
    return { status: 400, jsonBody: { error: "Invalid year" } };
  }

  try {
    const season = await readBlob<Season>(
      getBlobClient(`seasons/${year}.json`)
    );
    return { status: 200, jsonBody: season };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Season not found" } };
    }
    throw err;
  }
}

// ─── GET /api/seasons/{year}/results ─────────────────────────────────────────

async function getSeasonResults(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const year = req.params["year"];
  if (!year || !/^\d{4}$/.test(year)) {
    return { status: 400, jsonBody: { error: "Invalid year" } };
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
    throw err;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getSeasons", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons",
  handler: getSeasons,
});

app.http("getSeasonByYear", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons/{year}",
  handler: getSeasonByYear,
});

app.http("getSeasonResults", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "seasons/{year}/results",
  handler: getSeasonResults,
});
