// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  deleteBlob,
  getPrivateContainer,
  getPublicContainer,
  listBlobs,
  readJson,
  writeJson,
} from "./blobSeed.mjs";

const DEFAULT_BLOBS = { deleteBlob, listBlobs, readJson, writeJson };

function uniqueRoundIds(roundIds) {
  if (!Array.isArray(roundIds) || !roundIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new TypeError("roundIds must contain only non-empty strings");
  }
  return [...new Set(roundIds)];
}

async function deletePrefix(container, prefix, blobs) {
  let count = 0;
  for await (const name of blobs.listBlobs(container, prefix)) {
    await blobs.deleteBlob(container, name);
    count += 1;
  }
  return count;
}

export async function cleanupOwnedRoundIds(roundIds, options = {}) {
  const ids = uniqueRoundIds(roundIds);
  if (ids.length === 0) return { roundCount: 0, signatureCount: 0 };
  const ownedIds = new Set(ids);
  const {
    blobs = DEFAULT_BLOBS,
    privateContainer = getPrivateContainer(),
    publicContainer = getPublicContainer(),
    seasonYears = [],
  } = options;
  const knownSeasonYears = new Set(seasonYears.filter(Number.isInteger));
  const rounds = await blobs.readJson(publicContainer, "rounds.json");
  if (Array.isArray(rounds)) {
    for (const round of rounds) {
      if (ownedIds.has(round?.id) && Number.isInteger(round?.seasonYear)) {
        knownSeasonYears.add(round.seasonYear);
      }
    }
  }

  for (const roundId of ids) {
    const round = await blobs.readJson(privateContainer, `rounds/${roundId}.json`);
    if (Number.isInteger(round?.season?.year)) knownSeasonYears.add(round.season.year);
  }

  let signatureCount = 0;
  for (const roundId of ids) {
    signatureCount += await deletePrefix(privateContainer, `signatures/${roundId}/`, blobs);
    signatureCount += await deletePrefix(privateContainer, `sign-to-fly/${roundId}/`, blobs);
    await deletePrefix(privateContainer, `round-briefs/${roundId}/`, blobs);
    await blobs.deleteBlob(privateContainer, `rounds/${roundId}.json`);
    await blobs.deleteBlob(privateContainer, `round-briefs/${roundId}.json`);
    await blobs.deleteBlob(privateContainer, `round-briefs/${roundId}.pdf`);
  }

  if (Array.isArray(rounds)) {
    await blobs.writeJson(
      publicContainer,
      "rounds.json",
      rounds.filter((round) => !ownedIds.has(round?.id)),
    );
  }
  for (const seasonYear of knownSeasonYears) {
    const path = `seasons/${seasonYear}.json`;
    const season = await blobs.readJson(publicContainer, path);
    if (season && Array.isArray(season.rounds)) {
      await blobs.writeJson(publicContainer, path, {
        ...season,
        rounds: season.rounds.filter((roundId) => !ownedIds.has(roundId)),
      });
    }
  }

  return { roundCount: ids.length, signatureCount };
}
