// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { RoundSchema, RoundSummarySchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import { getBlobClient, getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { canManageRound, redactRoundSnapshots } from "../lib/roundAuth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

const RoundsIndexSchema = z.array(RoundSummarySchema);

// ─── GET /api/rounds ──────────────────────────────────────────────────────────

async function getRounds(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const rounds = await readJson(
      getBlobClient("rounds.json"),
      RoundsIndexSchema,
      "rounds.json",
    );
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
    const round = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
    // Snapshot PII (medical/emergency/contact) is manager-only; others get it stripped.
    const body = canManageRound(caller, round)
      ? round
      : redactRoundSnapshots(round);
    return { status: 200, jsonBody: body };
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
