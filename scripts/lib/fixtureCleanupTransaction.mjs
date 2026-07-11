// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFile, rm } from "node:fs/promises";

import { cleanupFixtureOwnership, parseFixtureOwnership } from "./fixtureOwnership.mjs";
import {
  FIXTURE_CLEANUP_STATE_PATH,
  readCleanupState,
  writeJsonDurably,
} from "./fixtureOperation.mjs";
import {
  FIXTURE_MANIFEST_PATH,
  PREPARED_ROUND_PATH,
} from "./loadTestConsts.mjs";
import {
  readLoadTestRoundState,
  replaceSeedRoundIds,
} from "./loadTestRoundState.mjs";

function fail(message) {
  throw new Error(`FIXTURE_CLEANUP_OWNERSHIP: ${message}`);
}

async function readPreparedRoundId() {
  try {
    const value = JSON.parse(await readFile(PREPARED_ROUND_PATH, "utf8"));
    return typeof value?.roundId === "string" ? value.roundId : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function removePreparedMetadataForSeedRound() {
  const preparedRoundId = await readPreparedRoundId();
  if (preparedRoundId === null) return false;
  const state = await readLoadTestRoundState();
  if (!state.seedRoundIds.includes(preparedRoundId)) return false;
  await rm(PREPARED_ROUND_PATH, { force: true });
  return true;
}

function assertRoundProof(ownership, seedRoundIds) {
  const proven = new Set(seedRoundIds);
  const unproven = ownership.roundIds.find((roundId) => !proven.has(roundId));
  if (unproven) fail("manifest round is not present in persisted seedRoundIds");
}

export async function cleanupFixturesTransaction(
  publicContainer,
  privateContainer,
  options
) {
  const checkpoint = await readCleanupState();
  const manifest = checkpoint?.manifest ?? options.manifest;
  const retainedManifest = checkpoint?.retainedManifest ?? options.retainedManifest ?? null;
  const ownership = parseFixtureOwnership(manifest);
  const retainedOwnership = retainedManifest ? parseFixtureOwnership(retainedManifest) : undefined;
  const roundState = await readLoadTestRoundState();
  if ((checkpoint?.phase ?? 0) < 5) {
    assertRoundProof(ownership, roundState.seedRoundIds);
  }

  if (!checkpoint) {
    await writeJsonDurably(FIXTURE_CLEANUP_STATE_PATH, {
      version: 1,
      phase: 0,
      manifest,
      retainedManifest,
    });
  }
  const afterPhase = async (phase) => {
    await writeJsonDurably(FIXTURE_CLEANUP_STATE_PATH, {
      version: 1,
      phase,
      manifest,
      retainedManifest,
    });
    if (process.env.FIXTURE_CLEANUP_KILL_AFTER_PHASE === String(phase)) {
      process.kill(process.pid, "SIGKILL");
    }
  };
  await cleanupFixtureOwnership(publicContainer, privateContainer, {
    ownership,
    retainedOwnership,
    recovery: checkpoint !== null,
    afterPhase,
  });

  const ownedRounds = new Set(ownership.roundIds);
  await rm(FIXTURE_MANIFEST_PATH, { force: true });
  await afterPhase(5);
  await replaceSeedRoundIds(
    roundState.seedRoundIds.filter((roundId) => !ownedRounds.has(roundId))
  );
  const preparedRoundId = await readPreparedRoundId();
  if (preparedRoundId !== null && ownedRounds.has(preparedRoundId)) {
    await rm(PREPARED_ROUND_PATH, { force: true });
  }
  await afterPhase(6);
  await rm(FIXTURE_CLEANUP_STATE_PATH, { force: true });
  return { ownership };
}
