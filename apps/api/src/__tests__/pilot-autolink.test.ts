// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PilotSummary, User } from "@bccweb/types";

const blobJsonControl = vi.hoisted(() => ({
  failEmailIndexRead: false,
  failPilotRead: false,
}));

vi.mock("../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/blobJson.js")>();
  return {
    ...actual,
    readJson: vi.fn(
      (client: Parameters<typeof actual.readJson>[0], schema: Parameters<typeof actual.readJson>[1], path: string) => {
        if (blobJsonControl.failEmailIndexRead && path === "pilot-email-index.json") {
          return Promise.reject({ statusCode: 500 });
        }
        if (blobJsonControl.failPilotRead && path.startsWith("pilots/")) {
          return Promise.reject({ statusCode: 500 });
        }
        return actual.readJson(client, schema, path);
      },
    ),
  };
});

import { getOrCreateUser } from "../lib/auth.js";
import {
  makePilot,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
} from "./helpers/seed.js";

describe("pilot auto-link via private pilot-email-index.json", () => {
  afterEach(() => {
    blobJsonControl.failEmailIndexRead = false;
    blobJsonControl.failPilotRead = false;
  });

  it("links pilotId and clubId to a new user whose email matches the private index", async () => {
    const pilotId = randomUUID();
    const userId = randomUUID();
    const email = `autolink-${userId}@example.com`;

    await writePrivateJson("pilot-email-index.json", { [email]: pilotId });
    await writePrivateJson(`pilots/${pilotId}.json`, {
      id: pilotId,
      coachType: "None",
      pilotRating: "Pilot",
      person: {
        id: randomUUID(),
        firstName: "Jane",
        lastName: "Test",
        fullName: "Jane Test",
      },
      currentClub: { id: "club-1", name: "Test Club" },
      seasonClubs: [],
      userId: null,
    });

    const user = await getOrCreateUser(userId, email);

    expect(user.pilotId).toBe(pilotId);
    expect(user.clubId).toBe("club-1");
    expect(user.roles).toContain("Pilot");
  });

  it("creates user with no pilotId when email has no match in private index", async () => {
    const userId = randomUUID();
    const email = `no-match-${userId}@example.com`;

    const user = await getOrCreateUser(userId, email);

    expect(user.pilotId).toBeNull();
    expect(user.roles).toEqual([]);
  });

  it("does not adopt pilotId when the email index points at a missing pilot blob", async () => {
    const ghostPilotId = randomUUID();
    const userId = randomUUID();
    const email = `missing-pilot-${userId}@example.com`;

    await writePrivateJson("pilot-email-index.json", { [email]: ghostPilotId });

    const user = await getOrCreateUser(userId, email);

    expect(user.pilotId).toBeNull();
    expect(user.roles).toEqual([]);
  });

  it("rethrows a transient pilot blob read failure and does not persist an unlinked user", async () => {
    const pilotId = randomUUID();
    const userId = randomUUID();
    const email = `transient-pilot-read-${userId}@example.com`;

    await writePrivateJson("pilot-email-index.json", { [email]: pilotId });
    blobJsonControl.failPilotRead = true;

    await expect(getOrCreateUser(userId, email)).rejects.toMatchObject({ statusCode: 500 });
    expect(await readPrivateJson<User>(`users/${userId}.json`)).toBeNull();
  });

  it("rethrows a transient pilot-email-index read failure and does not persist an unlinked user", async () => {
    const userId = randomUUID();
    const email = `transient-index-read-${userId}@example.com`;

    blobJsonControl.failEmailIndexRead = true;

    await expect(getOrCreateUser(userId, email)).rejects.toMatchObject({ statusCode: 500 });
    expect(await readPrivateJson<User>(`users/${userId}.json`)).toBeNull();
  });

  it("public pilots.json has no email, bhpaNumber, or userId after makePilot", async () => {
    const pilot = await makePilot({});
    const index = await readPublicJson<PilotSummary[]>("pilots.json");
    const entry = index?.find((p) => p.id === pilot.id) as Record<string, unknown> | undefined;

    expect(entry).toBeDefined();
    expect(entry?.["email"]).toBeUndefined();
    expect(entry?.["bhpaNumber"]).toBeUndefined();
    expect(entry?.["userId"]).toBeUndefined();
  });
});
