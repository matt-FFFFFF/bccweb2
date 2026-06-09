/**
 * Test data factories — seed Azurite containers with realistic test data.
 *
 * Each factory writes to the correct container(s) and returns the created
 * entity so tests can assert against it.
 */

import { randomUUID } from "crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import type {
  User,
  UserIndex,
  Pilot,
  PilotSummary,
  Round,
  RoundSummary,
  Club,
  ClubSummary,
  ClubTeam,
  ClubTeamSummary,
  Site,
  SiteSummary,
  Config,
  WingClass,
} from "@bccweb/types";
import type { AuthCredential } from "../../lib/authHelpers.js";
import { getPublicContainer, getPrivateContainer } from "./azurite.js";

// ─── Low-level helpers ────────────────────────────────────────────────────────

/** Write a JSON blob to a container. */
async function writeJson<T>(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
  data: T,
): Promise<void> {
  const client: BlockBlobClient = containerFn().getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

/** Read a JSON blob from a container. Returns null if not found. */
export async function readJson<T>(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
): Promise<T | null> {
  const client = containerFn().getBlobClient(path);
  try {
    const response = await client.download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

export async function blobExists(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
): Promise<boolean> {
  return containerFn().getBlobClient(path).exists();
}

export const writePublicJson = <T>(path: string, data: T) =>
  writeJson(getPublicContainer, path, data);
export const writePrivateJson = <T>(path: string, data: T) =>
  writeJson(getPrivateContainer, path, data);
export const readPublicJson = <T>(path: string) =>
  readJson<T>(getPublicContainer, path);
export const readPrivateJson = <T>(path: string) =>
  readJson<T>(getPrivateContainer, path);
export const publicBlobExists = (path: string) =>
  blobExists(getPublicContainer, path);
export const privateBlobExists = (path: string) =>
  blobExists(getPrivateContainer, path);

// ─── Factories ────────────────────────────────────────────────────────────────

export interface SeedUserOptions {
  id?: string;
  email?: string;
  roles?: User["roles"];
  pilotId?: string | null;
  clubId?: string | null;
  password?: string;
  emailVerified?: boolean;
}

/**
 * Create a user with auth credential in private container + update user-index.
 * Returns the user, credential, and raw password.
 */
export async function makeUser(
  overrides: SeedUserOptions = {},
): Promise<{ user: User; credential: AuthCredential; password: string }> {
  // Lazy import to avoid issues if bcryptjs is resolved at module load time
  const bcrypt = await import("bcryptjs");

  const id = overrides.id ?? randomUUID();
  const email = overrides.email ?? `test-${id.slice(0, 8)}@example.com`;
  const password = overrides.password ?? "TestPass123!";

  const user: User = {
    id,
    email,
    roles: overrides.roles ?? [],
    pilotId: overrides.pilotId ?? null,
    clubId: overrides.clubId ?? null,
    createdAt: new Date().toISOString(),
  };

  const credential: AuthCredential = {
    passwordHash: await bcrypt.hash(password, 4), // low cost for speed in tests
    emailVerified: overrides.emailVerified ?? true,
    createdAt: user.createdAt,
  };

  await writePrivateJson(`users/${id}.json`, user);
  await writePrivateJson(`auth/${id}.json`, credential);

  // Update user-index.json
  const existingIndex = (await readPrivateJson<UserIndex>("user-index.json")) ?? {};
  existingIndex[email.toLowerCase()] = id;
  await writePrivateJson("user-index.json", existingIndex);

  return { user, credential, password };
}

export interface SeedPilotOptions {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  clubId?: string;
  wingClass?: WingClass;
}

/**
 * Create a pilot in private container + append to public pilots.json index.
 */
export async function makePilot(
  overrides: SeedPilotOptions = {},
): Promise<Pilot> {
  const id = overrides.id ?? randomUUID();
  const firstName = overrides.firstName ?? "Test";
  const lastName = overrides.lastName ?? "Pilot";
  const fullName = `${firstName} ${lastName}`;

  const pilot: Pilot = {
    id,
    coachType: "None",
    pilotRating: "Pilot",
    wingClass: overrides.wingClass ?? "EN B",
    person: {
      id: randomUUID(),
      firstName,
      lastName,
      fullName,
    },
    currentClub: overrides.clubId
      ? { id: overrides.clubId, name: "Test Club" }
      : undefined,
    seasonClubs: [],
    userId: null,
  };

  await writePrivateJson(`pilots/${id}.json`, pilot);

  // Update public index
  const index = (await readPublicJson<PilotSummary[]>("pilots.json")) ?? [];
  index.push({
    id,
    name: fullName,
    clubId: overrides.clubId,
    rating: "Pilot",
  });
  await writePublicJson("pilots.json", index);

  return pilot;
}

export interface SeedRoundOptions {
  id?: string;
  date?: string;
  status?: Round["status"];
  siteId?: string;
  siteName?: string;
  seasonYear?: number;
  organisingClubId?: string;
  organisingClubName?: string;
  teams?: Round["teams"];
}

/**
 * Create a round in private container + append to public rounds.json index.
 */
export async function makeRound(
  overrides: SeedRoundOptions = {},
): Promise<Round> {
  const id = overrides.id ?? randomUUID();

  const round: Round = {
    id,
    date: overrides.date ?? "2025-06-15",
    status: overrides.status ?? "Proposed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: {
      id: overrides.siteId ?? randomUUID(),
      name: overrides.siteName ?? "Test Site",
    },
    organisingClub: overrides.organisingClubId
      ? { id: overrides.organisingClubId, name: overrides.organisingClubName ?? "Test Club" }
      : undefined,
    season: { year: overrides.seasonYear ?? 2025 },
    teams: overrides.teams ?? [],
  };

  await writePrivateJson(`rounds/${id}.json`, round);

  // Update public index
  const index = (await readPublicJson<RoundSummary[]>("rounds.json")) ?? [];
  index.push({
    id,
    date: round.date,
    siteId: round.site.id,
    siteName: round.site.name,
    status: round.status,
    seasonYear: round.season.year,
  });
  await writePublicJson("rounds.json", index);

  return round;
}

export interface SeedClubOptions {
  id?: string;
  name?: string;
}

/**
 * Create a club in private container + append to public clubs.json index.
 */
export async function makeClub(
  overrides: SeedClubOptions = {},
): Promise<Club> {
  const id = overrides.id ?? randomUUID();

  const club: Club = {
    id,
    name: overrides.name ?? "Test Club",
    sites: [],
    teams: [],
  };

  await writePrivateJson(`clubs/${id}.json`, club);

  // Update public index
  const index = (await readPublicJson<ClubSummary[]>("clubs.json")) ?? [];
  index.push({ id, name: club.name });
  await writePublicJson("clubs.json", index);

  return club;
}

export interface SeedSiteOptions {
  id?: string;
  name?: string;
  clubId?: string;
}

/**
 * Create a site in private container + append to public sites.json index.
 */
export async function makeSite(
  overrides: SeedSiteOptions = {},
): Promise<Site> {
  const id = overrides.id ?? randomUUID();
  const clubId = overrides.clubId ?? randomUUID();

  const site: Site = {
    id,
    name: overrides.name ?? "Test Site",
    status: "Active",
    clubId,
  };

  await writePrivateJson(`sites/${id}.json`, site);

  // Update public index
  const index = (await readPublicJson<SiteSummary[]>("sites.json")) ?? [];
  index.push({ id, name: site.name, status: site.status, clubId });
  await writePublicJson("sites.json", index);

  return site;
}

export interface SeedClubTeamOptions {
  id?: string;
  clubId?: string;
  clubName?: string;
  seasonYear?: number;
  teamName?: string;
}

/**
 * Create a club team in private container + append to public club-teams.json index.
 */
export async function makeClubTeam(
  overrides: SeedClubTeamOptions = {},
): Promise<ClubTeam> {
  const id = overrides.id ?? randomUUID();

  const clubTeam: ClubTeam = {
    id,
    clubId: overrides.clubId ?? randomUUID(),
    clubName: overrides.clubName ?? "Test Club",
    seasonYear: overrides.seasonYear ?? 2025,
    teamName: overrides.teamName ?? "Alpha",
    createdAt: new Date().toISOString(),
  };

  await writePrivateJson(`club-teams/${id}.json`, clubTeam);

  // Update public index
  const index = (await readPublicJson<ClubTeamSummary[]>("club-teams.json")) ?? [];
  index.push({
    id,
    clubId: clubTeam.clubId,
    clubName: clubTeam.clubName,
    seasonYear: clubTeam.seasonYear,
    teamName: clubTeam.teamName,
  });
  await writePublicJson("club-teams.json", index);

  return clubTeam;
}

/**
 * Write config.json to private container.
 */
export async function makeConfig(
  overrides: Partial<Config> = {},
): Promise<Config> {
  const config: Config = {
    maxTeamsInClub: overrides.maxTeamsInClub ?? 3,
    maxPilotsInTeam: overrides.maxPilotsInTeam ?? 5,
    maxScoringPilotsInTeam: overrides.maxScoringPilotsInTeam ?? 3,
    flightDateValidationEnabled: overrides.flightDateValidationEnabled ?? true,
    wingFactors: overrides.wingFactors ?? {
      "EN A": 1.2,
      "EN B": 1.1,
      "EN C": 1.0,
      "EN C 2-liner": 0.95,
      "EN D": 0.9,
      "EN D 2-liner": 0.85,
    },
  };

  await writePrivateJson("config.json", config);
  return config;
}
