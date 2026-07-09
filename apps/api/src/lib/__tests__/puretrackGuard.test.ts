// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type { Round } from "@bccweb/types";
import { createPureTrackGroups } from "../puretrack.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../blob.js", () => ({
  writePrivateBlob: vi.fn().mockResolvedValue(undefined),
}));

function makeRound(roundId: string): Round {
  return {
    id: roundId,
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-1",
        teamName: "Alpha",
        club: { id: "club-1", name: "Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: "pilot-uuid-1",
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };
}

const ENV_KEYS = [
  "PURETRACK_ENABLED",
  "PURETRACK_API_KEY",
  "PURETRACK_EMAIL",
  "PURETRACK_PASSWORD",
] as const;

describe("createPureTrackGroups — PURETRACK_ENABLED guard", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    fetchMock.mockReset();
    process.env["PURETRACK_API_KEY"] = "key";
    process.env["PURETRACK_EMAIL"] = "test@example.com";
    process.env["PURETRACK_PASSWORD"] = "secret";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  it("PURETRACK_ENABLED=false short-circuits: returns null, fetch never called", async () => {
    process.env["PURETRACK_ENABLED"] = "false";

    const result = await createPureTrackGroups(
      makeRound(randomUUID()),
      new Map([["pilot-uuid-1", 123]])
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("default behavior calls PureTrack: unset env reaches fetch (authenticate)", async () => {
    expect(process.env["PURETRACK_ENABLED"]).toBeUndefined();
    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      createPureTrackGroups(
        makeRound(randomUUID()),
        new Map([["pilot-uuid-1", 123]])
      )
    ).rejects.toThrow(/PureTrack login failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://puretrack.io/api/login");
  });

  it("non-\"false\" string still enables: PURETRACK_ENABLED=\"disabled\" reaches fetch", async () => {
    process.env["PURETRACK_ENABLED"] = "disabled";
    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      createPureTrackGroups(
        makeRound(randomUUID()),
        new Map([["pilot-uuid-1", 123]])
      )
    ).rejects.toThrow(/PureTrack login failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://puretrack.io/api/login");
  });
});
