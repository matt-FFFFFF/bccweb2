import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type { Round, PureTrackGroup } from "@bccweb/types";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const writePrivateBlobSpy = vi.hoisted(() =>
  vi.fn<(path: string, data: unknown, leaseId?: string) => Promise<void>>().mockResolvedValue(undefined)
);
vi.mock("../blob.js", () => ({
  writePrivateBlob: writePrivateBlobSpy,
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
          {
            placeInTeam: 2,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: "pilot-uuid-2",
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };
}

function mockSuccessfulPureTrackApi(roundGroupId = 99, teamGroupId = 100) {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
    )
    .mockResolvedValueOnce(
      new Response('<meta name="csrf-token" content="csrf">', { status: 200 })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: roundGroupId, name: "BCC Milk Hill Tue 09 Jun 26", slug: "bcc-milk-hill" }),
        { status: 200 }
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: teamGroupId, name: "BCC Tue 09 Jun 26 Alpha", slug: "bcc-alpha" }),
        { status: 200 }
      )
    )
    .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    .mockResolvedValueOnce(new Response("ok", { status: 200 }));
}

describe("createPureTrackGroups — blob persistence", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    writePrivateBlobSpy.mockReset();
    writePrivateBlobSpy.mockResolvedValue(undefined);
    process.env["PURETRACK_API_KEY"] = "key";
    process.env["PURETRACK_EMAIL"] = "test@example.com";
    process.env["PURETRACK_PASSWORD"] = "secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["PURETRACK_API_KEY"];
    delete process.env["PURETRACK_EMAIL"];
    delete process.env["PURETRACK_PASSWORD"];
  });

  it("successful group creation writes blob with expected shape", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      if (typeof cb === "function") cb();
      return 0 as never;
    }) as unknown as typeof setTimeout);

    mockSuccessfulPureTrackApi(99, 100);

    const roundId = randomUUID();
    await createPureTrackGroups(
      makeRound(roundId),
      new Map([
        ["pilot-uuid-1", 123],
        ["pilot-uuid-2", 456],
      ]),
      { callerUserId: "user-abc" }
    );

    expect(writePrivateBlobSpy).toHaveBeenCalledTimes(2);

    const [roundPath, roundData] = writePrivateBlobSpy.mock.calls[0];
    expect(roundPath).toMatch(/^puretrack-groups\/.+\.json$/);
    const roundBlob = roundData as PureTrackGroup;
    expect(roundBlob.roundId).toBe(roundId);
    expect(roundBlob.teamId).toBeUndefined();
    expect(roundBlob.pilotIds).toEqual(["pilot-uuid-1", "pilot-uuid-2"]);
    expect(roundBlob.externalId).toBe("99");
    expect(roundBlob.externalUrl).toContain("bcc-milk-hill");
    expect(roundBlob.slug).toBe("bcc-milk-hill");
    expect(roundBlob.createdBy).toBe("user-abc");
    expect(roundBlob.createdAt).toBeTruthy();

    const [teamPath, teamData] = writePrivateBlobSpy.mock.calls[1];
    expect(teamPath).toMatch(/^puretrack-groups\/.+\.json$/);
    const teamBlob = teamData as PureTrackGroup;
    expect(teamBlob.teamId).toBe("team-1");
    expect(teamBlob.roundId).toBe(roundId);
    expect(teamBlob.externalId).toBe("100");
    expect(teamBlob.externalUrl).toContain("bcc-alpha");
    expect(teamBlob.pilotIds).toEqual(["pilot-uuid-1", "pilot-uuid-2"]);
  });

  it("failed PureTrack API call -> no blob written", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response('<meta name="csrf-token" content="csrf">', { status: 200 })
      )
      .mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));

    const roundId = randomUUID();
    await expect(
      createPureTrackGroups(makeRound(roundId), new Map([["pilot-uuid-1", 123]]))
    ).rejects.toThrow();

    expect(writePrivateBlobSpy).not.toHaveBeenCalled();
  });

  it("null pureTrackId pilots excluded from pilotIds[] but blob still written for the rest", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      if (typeof cb === "function") cb();
      return 0 as never;
    }) as unknown as typeof setTimeout);

    mockSuccessfulPureTrackApi(99, 100);

    const roundId = randomUUID();
    await createPureTrackGroups(
      makeRound(roundId),
      new Map([["pilot-uuid-1", 123]])
    );

    expect(writePrivateBlobSpy).toHaveBeenCalled();

    const roundBlobCall = writePrivateBlobSpy.mock.calls.find(
      ([, data]) => !(data as PureTrackGroup).teamId
    );
    expect(roundBlobCall).toBeDefined();
    const roundBlob = roundBlobCall![1] as PureTrackGroup;
    expect(roundBlob.pilotIds).toEqual(["pilot-uuid-1"]);
    expect(roundBlob.pilotIds).not.toContain("pilot-uuid-2");

    expect(warnSpy).toHaveBeenCalledWith(
      "[METRIC] puretrack.skip pilot lacks pureTrackId",
      { pilotId: "pilot-uuid-2" }
    );
  });
});
