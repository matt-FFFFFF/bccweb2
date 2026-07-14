// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONN =
  process.env.BLOB_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private";

const COORD_EMAIL = "qa-coord-validation@example.test";
const COORD_PASSWORD = "test1234!";
const COORD_ID = randomUUID();

const SITE_NAME = "Validation Hill";
const ROUND_DATE = "2019-06-15";
const SEASON_YEAR = 2019;

const IGC_FIXTURE = "apps/api/src/lib/__tests__/fixtures/igc/d3p.igc";

export interface SeededValidationRound {
  roundId: string;
  siteName: string;
  coord: { email: string; password: string };
  teamId: string;
  invalidPilotId: string;
  unverifiedPilotId: string;
}

interface RoundBlob {
  teams: Array<{
    id: string;
    score: number;
    pilots: Array<{
      pilotId: string;
      pilotPoints: number;
    }>;
  }>;
}

export async function readPersistedScores(
  roundId: string,
  teamId: string,
  pilotId: string
): Promise<{ pilotPoints: number; teamScore: number }> {
  const svc = BlobServiceClient.fromConnectionString(CONN);
  const priv = svc.getContainerClient(PRIVATE_CONTAINER);
  const buffer = await priv.getBlockBlobClient(`rounds/${roundId}.json`).downloadToBuffer();
  const round = JSON.parse(buffer.toString("utf8")) as RoundBlob;

  const team = round.teams.find((t) => t.id === teamId);
  if (!team) throw new Error("Team not found in persisted blob");

  const slot = team.pilots.find((p) => p.pilotId === pilotId);
  if (!slot) throw new Error("Slot not found in persisted blob");

  return {
    pilotPoints: slot.pilotPoints ?? 0,
    teamScore: team.score ?? 0,
  };
}

async function putJson(client: ContainerClient, blobPath: string, obj: unknown): Promise<void> {
  const body = JSON.stringify(obj, null, 2);
  await client.getBlockBlobClient(blobPath).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

async function putBytes(client: ContainerClient, blobPath: string, bytes: Buffer): Promise<void> {
  await client.getBlockBlobClient(blobPath).upload(bytes, bytes.length, {
    blobHTTPHeaders: { blobContentType: "text/plain" },
  });
}

async function downloadJson(client: ContainerClient, blobPath: string): Promise<Record<string, string>> {
  const buffer = await client.getBlockBlobClient(blobPath).downloadToBuffer();
  return JSON.parse(buffer.toString("utf8")) as Record<string, string>;
}

function igcFlight(id: string, igcPath: string, signatureStatus: "invalid" | "unverified"): Record<string, unknown> {
  return {
    id,
    distance: 60.8,
    scoringType: "XC",
    score: 0,
    wingFactor: 1,
    isManualLog: false,
    igcPath,
    validation: {
      signature: signatureStatus
    }
  };
}

function filledSlot(pilotId: string, placeInTeam: number, flight: Record<string, unknown> | null): Record<string, unknown> {
  return {
    placeInTeam,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0, // Pre-seed with 0 points
    pilotId,
    snapshot: { wingClass: "EN A", pilotRating: "Pilot" },
    flight,
  };
}

export async function seedValidationRound(): Promise<SeededValidationRound> {
  const svc = BlobServiceClient.fromConnectionString(CONN);
  const priv = svc.getContainerClient(PRIVATE_CONTAINER);

  const roundId = randomUUID();
  const clubId = randomUUID();
  const teamId = randomUUID();

  const igcBytes = readFileSync(path.join(process.cwd(), IGC_FIXTURE));
  const pilotId1 = randomUUID();
  const pilotId2 = randomUUID();
  const flightId1 = randomUUID(); // invalid
  const flightId2 = randomUUID(); // unverified
  const igcPath1 = `flight-igcs/${roundId}/${pilotId1}/${flightId1}.igc`;
  const igcPath2 = `flight-igcs/${roundId}/${pilotId2}/${flightId2}.igc`;
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
    organisingClub: { id: clubId, name: "QA Validation Club" },
    season: { year: SEASON_YEAR },
    teams: [
      {
        id: teamId,
        teamName: "QA Validation Team",
        club: { id: clubId, name: "QA Validation Club" },
        score: 0, // Pre-seed with 0 team score
        pilots: [
          filledSlot(pilotId1, 1, igcFlight(flightId1, igcPath1, "invalid")),
          filledSlot(pilotId2, 2, igcFlight(flightId2, igcPath2, "unverified")),
        ],
      },
    ],
  };
  await putJson(priv, `rounds/${roundId}.json`, round);

  const now = new Date().toISOString();
  await putJson(priv, `users/${COORD_ID}.json`, {
    id: COORD_ID,
    email: COORD_EMAIL,
    roles: ["RoundsCoord"],
    pilotId: null,
    clubId: clubId, // Scoped to the organizing club so they can see Resubmit
    createdAt: now,
  });
  await putJson(priv, `auth/${COORD_ID}.json`, {
    passwordHash: await bcrypt.hash(COORD_PASSWORD, 4),
    emailVerified: true,
    createdAt: now,
  });

  const index = await downloadJson(priv, "user-index.json");
  await putJson(priv, "user-index.json", { ...index, [COORD_EMAIL]: COORD_ID });

  return {
    roundId,
    siteName: SITE_NAME,
    coord: { email: COORD_EMAIL, password: COORD_PASSWORD },
    teamId,
    invalidPilotId: pilotId1,
    unverifiedPilotId: pilotId2
  };
}
