#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import {
  getPrivateContainer,
  getPublicContainer,
  readJson,
  writeJson,
  deleteBlob,
  listBlobs,
} from "./lib/blobSeed.mjs";
import {
  BCC_API_BASE_URL,
  IS_AZURE_TARGET,
  PREPARED_ROUND_PATH,
} from "./lib/loadTestConsts.mjs";
import { unlinkSync, existsSync, readFileSync } from "node:fs";

const privateContainer = getPrivateContainer();
const publicContainer = getPublicContainer();

async function main() {
  if (!existsSync(PREPARED_ROUND_PATH)) {
    console.error("[cleanup-loadtest] no prepared round; nothing to clean");
    process.exit(0);
  }

  const prepared = JSON.parse(readFileSync(PREPARED_ROUND_PATH, "utf8"));
  const roundId = prepared?.roundId;
  const seasonYear = prepared?.seasonYear;

  if (!roundId) {
    throw new Error("prepared round is missing roundId");
  }

  await deleteBlob(privateContainer, `rounds/${roundId}.json`);
  await deleteBlob(privateContainer, `round-briefs/${roundId}.json`);
  await deleteBlob(privateContainer, `round-briefs/${roundId}.pdf`);

  let signatureCount = 0;
  for await (const name of listBlobs(privateContainer, `signatures/${roundId}/`)) {
    signatureCount += 1;
    await deleteBlob(privateContainer, name);
  }

  const rounds = await readJson(publicContainer, "rounds.json");
  if (Array.isArray(rounds)) {
    const nextRounds = rounds.filter((entry) => entry?.id !== roundId);
    if (nextRounds.length !== rounds.length) {
      await writeJson(publicContainer, "rounds.json", nextRounds);
    }
  }

  if (seasonYear != null) {
    const seasonPath = `seasons/${seasonYear}.json`;
    const season = await readJson(publicContainer, seasonPath);
    if (season && Array.isArray(season.rounds)) {
      const nextSeason = {
        ...season,
        rounds: season.rounds.filter((id) => id !== roundId),
      };
      if (nextSeason.rounds.length !== season.rounds.length) {
        await writeJson(publicContainer, seasonPath, nextSeason);
      }
    }
  }

  if (existsSync(PREPARED_ROUND_PATH)) unlinkSync(PREPARED_ROUND_PATH);

  console.error(
    `[cleanup-loadtest] OK: target=${BCC_API_BASE_URL} round ${roundId} removed (signatures=${signatureCount})`,
  );

  if (IS_AZURE_TARGET) {
    console.error(
      `[cleanup-loadtest] WARNING: This deleted blobs from Azure storage at ${process.env.BLOB_CONNECTION_STRING?.slice(0, 80) ?? "(unset)"}. Verify against the intended target before re-running.`,
    );
  }
}

main().catch((err) => {
  console.error(`[cleanup-loadtest] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
