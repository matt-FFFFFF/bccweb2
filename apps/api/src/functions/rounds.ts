import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { RoundSummary, Round } from "@bccweb/types";
import { getBlobClient, getPrivateBlobClient, readBlob } from "../lib/blob.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

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
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── GET /api/rounds/{id} ─────────────────────────────────────────────────────

async function getRoundById(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  try {
    const round = await readBlob<Round>(getPrivateBlobClient(`rounds/${id}.json`));
    return { status: 200, jsonBody: round };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getRounds", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds",
  handler: withErrorHandler(getRounds),
});

app.http("getRoundById", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{id}",
  handler: withErrorHandler(getRoundById),
});
