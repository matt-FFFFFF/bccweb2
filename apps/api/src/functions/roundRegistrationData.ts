// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Config, Pilot, Round, RoundSummary } from "@bccweb/types";
import {
  ConfigSchema,
  PilotSchema,
  RoundSchema,
  RoundSummarySchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import { getBlobClient, getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import { BlobShapeError, HttpError } from "../lib/http.js";
import { isPilotInRound } from "./roundRegistrationRoster.js";

const RoundSummariesSchema = z.array(RoundSummarySchema);

export async function readRegistrationRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

export async function readRegistrationPilot(pilotId: string): Promise<Pilot> {
  const path = `pilots/${pilotId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), PilotSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(
        422,
        "PROFILE_INCOMPLETE",
        "Complete your profile first"
      );
    }
    if (err instanceof BlobShapeError) {
      throw new HttpError(
        422,
        "PROFILE_INCOMPLETE",
        "Complete your profile first"
      );
    }
    throw err;
  }
}

export async function readRegistrationConfig(): Promise<Config> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json"
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return ConfigSchema.parse({});
    }
    throw err;
  }
}

export async function ensureNotDoubleBooked(
  pilotId: string,
  targetRound: Round
): Promise<void> {
  let summaries: RoundSummary[] = [];
  try {
    summaries = await readJson(
      getBlobClient("rounds.json"),
      RoundSummariesSchema,
      "rounds.json"
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  const candidates = summaries.filter(
    (summary) =>
      summary.id !== targetRound.id &&
      summary.seasonYear === targetRound.season.year &&
      summary.status !== "Cancelled" &&
      isWithinOneLocalDate(summary.date, targetRound.date)
  );

  for (const candidate of candidates) {
    const round = await readRegistrationRound(candidate.id);
    if (round.status === "Cancelled") continue;
    if (isPilotInRound(round, pilotId)) {
      throw new HttpError(
        409,
        "DOUBLE_BOOKING",
        `Conflicting round ${round.id} on ${round.date}`
      );
    }
  }
}

function isWithinOneLocalDate(dateA: string, dateB: string): boolean {
  return Math.abs(localDateNumber(dateA) - localDateNumber(dateB)) <= 1;
}

function localDateNumber(value: string): number {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}
