// SPDX-License-Identifier: MPL-2.0
/**
 * E2E seed: a Locked round with two IGC-scored slots (plus a manual-flight slot
 * and an empty slot) and a RoundsCoord user, for the admin round-rescore
 * enqueue → poll → counts flow.
 *
 * This is NOT a new harness — it EXTENDS the existing `_setup/reset-azurite.ts`
 * seed mechanism: same Azurite `BlobServiceClient`, same direct blob writes,
 * same `bcryptjs` password hashing. Call it AFTER `resetAzuriteAndSeedAdmin()`,
 * which wipes + recreates the containers and seeds the admin; this then layers
 * the round + IGC blobs + coord on top of that clean state.
 *
 * The round shape mirrors
 * `apps/api/src/functions/__tests__/rescoreQueue.test.ts` (`seedMixedRound`),
 * which is proven to drive the live `rescoreWorker`
 * (`runRescoreJob` → `scoreRound`) to a `completed` job with counts
 * `{ rescoredCount: 2, skippedManualCount: 1, skippedNoIgcCount: 1 }`. Both IGC
 * blobs are the REAL `d3p.igc` fixture (HFDTE 2019-06-15, matching the round
 * date so there is no `IGC_DATE_MISMATCH`), so the worker re-scores them for
 * real rather than against a mock.
 */
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONN =
  process.env.BLOB_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private";

const COORD_EMAIL = "qa-coord@example.test";
const COORD_PASSWORD = "test1234!";
const COORD_ID = "22222222-2222-4222-8222-222222222222";

const SITE_NAME = "Milk Hill";
// d3p.igc HFDTE is 2019-06-15 — match it so the rescore produces no IGC_DATE_MISMATCH.
const ROUND_DATE = "2019-06-15";
const SEASON_YEAR = 2019;

// Resolved against process.cwd(); `npm run e2e` runs Playwright from the repo
// root (the same base the existing specs use for `.omo/evidence`).
const IGC_FIXTURE = "apps/api/src/lib/__tests__/fixtures/igc/d3p.igc";

export interface SeededRescoreRound {
  roundId: string;
  siteName: string;
  coord: { email: string; password: string };
}

/** Upload a JSON blob (matches the `putJson` helper in reset-azurite.ts). */
async function putJson(client: ContainerClient, blobPath: string, obj: unknown): Promise<void> {
  const body = JSON.stringify(obj, null, 2);
  await client.getBlockBlobClient(blobPath).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

/** Upload raw bytes (the IGC file contents). */
async function putBytes(client: ContainerClient, blobPath: string, bytes: Buffer): Promise<void> {
  await client.getBlockBlobClient(blobPath).upload(bytes, bytes.length, {
    blobHTTPHeaders: { blobContentType: "text/plain" },
  });
}

/** Read an existing JSON blob (used to merge into the admin-seeded index). */
async function downloadJson(client: ContainerClient, blobPath: string): Promise<Record<string, string>> {
  const buffer = await client.getBlockBlobClient(blobPath).downloadToBuffer();
  return JSON.parse(buffer.toString("utf8")) as Record<string, string>;
}

/** An IGC-backed flight: the worker re-scores it from the referenced blob. */
function igcFlight(igcPath: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    distance: 0,
    scoringType: "XC",
    score: 0,
    wingFactor: 1,
    isManualLog: false,
    igcPath,
  };
}

/** A Filled pilot slot (matches the `slot()` helper in rescoreQueue.test.ts). */
function filledSlot(placeInTeam: number, flight: Record<string, unknown> | null): Record<string, unknown> {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId: randomUUID(),
    snapshot: null,
    flight,
  };
}

/**
 * Seed the round + coord on top of `resetAzuriteAndSeedAdmin()`. Returns the
 * round id, its site name (for a heading assertion) and the coord credentials.
 */
export async function seedRescoreRound(): Promise<SeededRescoreRound> {
  const svc = BlobServiceClient.fromConnectionString(CONN);
  const priv = svc.getContainerClient(PRIVATE_CONTAINER);

  const roundId = randomUUID();
  const clubId = randomUUID();

  // Two real IGC blobs at the canonical flight-igcs/{uuid}/{uuid}.igc path.
  const igcBytes = readFileSync(path.join(process.cwd(), IGC_FIXTURE));
  const igcPath1 = `flight-igcs/${randomUUID()}/${randomUUID()}.igc`;
  const igcPath2 = `flight-igcs/${randomUUID()}/${randomUUID()}.igc`;
  await putBytes(priv, igcPath1, igcBytes);
  await putBytes(priv, igcPath2, igcBytes);

  const round = {
    id: roundId,
    date: ROUND_DATE,
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: SITE_NAME },
    organisingClub: { id: clubId, name: "QA Rescore Club" },
    season: { year: SEASON_YEAR },
    teams: [
      {
        id: randomUUID(),
        teamName: "QA Rescore Team",
        club: { id: clubId, name: "QA Rescore Club" },
        score: 0,
        pilots: [
          filledSlot(1, igcFlight(igcPath1)),
          filledSlot(2, igcFlight(igcPath2)),
          filledSlot(3, {
            id: randomUUID(),
            distance: 33,
            scoringType: "XC",
            score: 0,
            wingFactor: 1,
            isManualLog: true,
            manualLogJustification: "Manual entry seeded for the QA rescore fixture.",
          }),
          filledSlot(4, null),
        ],
      },
    ],
  };
  await putJson(priv, `rounds/${roundId}.json`, round);

  // A RoundsCoord user in its OWN club (not the organising club) — it must never
  // see the admin-only rescore button. Mirrors the admin seed in reset-azurite.ts.
  const now = new Date().toISOString();
  await putJson(priv, `users/${COORD_ID}.json`, {
    id: COORD_ID,
    email: COORD_EMAIL,
    roles: ["RoundsCoord"],
    pilotId: null,
    clubId: randomUUID(),
    createdAt: now,
  });
  await putJson(priv, `auth/${COORD_ID}.json`, {
    passwordHash: await bcrypt.hash(COORD_PASSWORD, 4),
    emailVerified: true,
    createdAt: now,
  });

  // Merge the coord into the admin-seeded user-index (do NOT clobber the admin).
  const index = await downloadJson(priv, "user-index.json");
  await putJson(priv, "user-index.json", { ...index, [COORD_EMAIL]: COORD_ID });

  return { roundId, siteName: SITE_NAME, coord: { email: COORD_EMAIL, password: COORD_PASSWORD } };
}
