// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";
import { SeasonSummarySchema } from "@bccweb/schemas";
import { getBlobClient } from "./blob.js";
import { readJson } from "./blobJson.js";

const SeasonsIndexSchema = z.array(SeasonSummarySchema);

export async function getActiveSeasonYear(): Promise<number> {
  try {
    const seasons = await readJson(
      getBlobClient("seasons.json"),
      SeasonsIndexSchema,
      "seasons.json",
    );
    const active = seasons.find((s) => s.active) ?? seasons[seasons.length - 1];
    return active?.year ?? new Date().getFullYear();
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return new Date().getFullYear();
    }
    throw err;
  }
}
