import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Round } from "@bccweb/types";

const fetchMock = vi.fn();

function makeRound(): Round {
  return {
    id: "round-1",
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
          { placeInTeam: 1, isScoring: true, status: "Filled", accountedFor: false, signToFly: false, noScore: false, pilotPoints: 0, pilotId: "pilot-1", snapshot: null, flight: null },
          { placeInTeam: 2, isScoring: true, status: "Filled", accountedFor: false, signToFly: false, noScore: false, pilotPoints: 0, pilotId: "pilot-2", snapshot: null, flight: null },
        ],
      },
    ],
  };
}

describe("createPureTrackGroups", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.PURETRACK_API_KEY = "key";
    process.env.PURETRACK_EMAIL = "pilot@example.com";
    process.env.PURETRACK_PASSWORD = "secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PURETRACK_API_KEY;
    delete process.env.PURETRACK_EMAIL;
    delete process.env.PURETRACK_PASSWORD;
  });

  it("PureTrack group creation skips pilots with null pureTrackId; group created with N-1 members; warning emitted", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: any) => {
      if (typeof cb === "function") cb();
      return 0 as never;
    }) as unknown as typeof globalThis.setTimeout);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<meta name=\"csrf-token\" content=\"csrf\">", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, name: "BCC Milk Hill Sat 09 Jun 26", slug: "round" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2, name: "BCC 09 Jun 26 Alpha", slug: "team" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await createPureTrackGroups(makeRound(), new Map([
      ["pilot-1", 123],
      ["pilot-2", undefined as never],
    ]));

    expect(result?.teams).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[METRIC] puretrack.skip pilot lacks pureTrackId",
      { pilotId: "pilot-2" },
    );
  });

  it("PureTrack group creation skips pilots with pureTrackId === 0", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: any) => {
      if (typeof cb === "function") cb();
      return 0 as never;
    }) as unknown as typeof globalThis.setTimeout);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<meta name=\"csrf-token\" content=\"csrf\">", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, name: "BCC Milk Hill Sat 09 Jun 26", slug: "round" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2, name: "BCC 09 Jun 26 Alpha", slug: "team" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await createPureTrackGroups(makeRound(), new Map([
      ["pilot-1", 0],
      ["pilot-2", 456],
    ]));

    expect(result?.teams).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[METRIC] puretrack.skip pilot lacks pureTrackId",
      { pilotId: "pilot-1" },
    );
  });

  it("PureTrack group does NOT throw when ALL pilots lack pureTrackId (logs warning, returns null/empty group result)", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createPureTrackGroups(makeRound(), new Map());

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
