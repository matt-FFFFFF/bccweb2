import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { RoundSummary, Round } from "@bccweb/types";
import { getBlobClient, readBlob } from "../lib/blob.js";

// ─── GET /api/rounds ──────────────────────────────────────────────────────────

async function getRounds(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const rounds = await readBlob<RoundSummary[]>(getBlobClient("rounds.json"));
    // Sort newest first
    rounds.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return { status: 200, jsonBody: rounds };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw err;
  }
}

// ─── GET /api/rounds/{id} ─────────────────────────────────────────────────────

async function getRoundById(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) return { status: 400, jsonBody: { error: "Missing round id" } };

  try {
    const round = await readBlob<Round>(getBlobClient(`rounds/${id}.json`));
    return { status: 200, jsonBody: round };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 404, jsonBody: { error: "Round not found" } };
    }
    throw err;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getRounds", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds",
  handler: getRounds,
});

app.http("getRoundById", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}",
  handler: getRoundById,
});
