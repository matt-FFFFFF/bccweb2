import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import type { PilotSummary } from "@bccweb/types";
import { getOrCreateUser } from "../lib/auth.js";
import {
  makePilot,
  readPublicJson,
  writePrivateJson,
} from "./helpers/seed.js";

describe("pilot auto-link via private pilot-email-index.json", () => {
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
