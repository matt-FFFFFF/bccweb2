// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Flight, Round } from "@bccweb/types";
import {
  invoke,
  makeAuthRequest,
  makeRequest,
  MockHttpRequest,
} from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import * as blobModule from "../../lib/blob.js";

// scoreIgc is wrapped so the happy path runs the REAL solver while individual
// tests can force a rejection (IGC_PARSE_ERROR) or a fast canned result (overwrite).
vi.mock("../../lib/igcScoring.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/igcScoring.js")>();
  return { ...actual, scoreIgc: vi.fn(actual.scoreIgc) };
});

import { scoreIgc } from "../../lib/igcScoring.js";
import "../igc.js";

// ─── Fixtures + request builders ────────────────────────────────────────────────

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../../lib/__tests__/fixtures/igc/${name}`, import.meta.url));

const D3P = fixture("d3p.igc"); // real track, ~60.8 km open-distance, first byte 'A'

function igcFile(bytes: Uint8Array, name = "track.igc"): File {
  // Copy into a fresh ArrayBuffer-backed view so the bytes satisfy BlobPart
  // (a Node Buffer / Uint8Array<ArrayBufferLike> is not assignable directly).
  return new File([new Uint8Array(bytes)], name, { type: "text/plain" });
}

/** Attach a multipart body to a mock request (mirrors brief.upload.test). */
function withFile(req: MockHttpRequest, file: File | null): MockHttpRequest {
  (req as unknown as { formData: () => Promise<FormData> }).formData = async () => {
    const fd = new FormData();
    if (file) fd.append("file", file);
    return fd;
  };
  return req;
}

interface SeededRound {
  roundId: string;
  teamId: string;
  place: number;
  pilotId: string | null;
  organisingClubId: string;
}

async function seedRound(overrides: {
  status?: Round["status"];
  pilotId?: string | null;
  organisingClubId?: string;
} = {}): Promise<SeededRound> {
  const roundId = randomUUID();
  const teamId = randomUUID();
  const organisingClubId = overrides.organisingClubId ?? randomUUID();
  const pilotId = overrides.pilotId === undefined ? randomUUID() : overrides.pilotId;
  const status = overrides.status ?? "Locked";
  const round: Round = {
    id: roundId,
    date: "2019-06-15", // matches d3p.igc so the happy path carries no date-mismatch flag
    status,
    isLocked: status === "Locked" || status === "Complete",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: organisingClubId, name: "Test Club" },
    season: { year: 2019 },
    teams: [
      {
        id: teamId,
        teamName: "A",
        club: { id: randomUUID(), name: "Test Club" },
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
            pilotId,
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  return { roundId, teamId, place: 1, pilotId, organisingClubId };
}

function paramsFor(r: SeededRound, place = r.place) {
  return { id: r.roundId, teamId: r.teamId, place: String(place) };
}

async function downloadPrivate(path: string): Promise<Buffer> {
  const dl = await getPrivateContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of dl.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function igcHeaders(filename: string) {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, max-age=300",
  };
}

async function uploadFixtureIgc(r: SeededRound): Promise<void> {
  const { user } = await bootstrapAdmin();
  const req = withFile(
    makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
    igcFile(D3P),
  );

  const res = await invoke("uploadIgc", req);
  expect(res.status).toBe(200);
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe("uploadIgc — POST /rounds/{id}/teams/{teamId}/pilots/{place}/igc", () => {
  it("401 when unauthenticated", async () => {
    const r = await seedRound();
    const req = withFile(makeRequest({ method: "POST", params: paramsFor(r) }), igcFile(D3P));

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(401);
  });

  it("403 when a Pilot uploads to a slot they do not own", async () => {
    const r = await seedRound({ pilotId: randomUUID() });
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: randomUUID() });
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(403);
  });

  it("403 when a RoundsCoord is scoped to a different club", async () => {
    const r = await seedRound({ organisingClubId: randomUUID() });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(403);
  });

  it("404 when the round does not exist", async () => {
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        params: { id: randomUUID(), teamId: randomUUID(), place: "1" },
      }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(404);
  });

  it("404 when the slot (place) is not present in the team", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r, 2) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(404);
  });

  it("409 ROUND_NOT_LOCKED when the round is not Locked", async () => {
    const r = await seedRound({ status: "BriefComplete" });
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_NOT_LOCKED");
  });

  it("409 SLOT_NOT_FILLED when the slot has no pilot assigned", async () => {
    const r = await seedRound({ pilotId: null });
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("SLOT_NOT_FILLED");
  });

  it("400 BAD_REQUEST when no file part is supplied", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      null,
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("413 PAYLOAD_TOO_LARGE when the file exceeds 15MB", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const big = igcFile(new Uint8Array(15 * 1024 * 1024 + 1), "big.igc");
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      big,
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(413);
    expect((res.jsonBody as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("415 UNSUPPORTED_MEDIA_TYPE when the first byte is not 'A'", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const notIgc = igcFile(new Uint8Array([0x42, 0x43, 0x44]), "notigc.txt");
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      notIgc,
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(415);
    expect((res.jsonBody as { code: string }).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("400 IGC_PARSE_ERROR when the scorer throws unexpectedly", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    vi.mocked(scoreIgc).mockRejectedValueOnce(new Error("solver exploded"));
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("IGC_PARSE_ERROR");
  });

  it("200 scores a real IGC, stores the blob, and stamps the Flight onto the slot", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(200);
    const flight = res.jsonBody as Flight;
    const expectedPath = `flight-igcs/${r.roundId}/${r.pilotId}.igc`;
    expect(flight.distance).toBeGreaterThan(0);
    expect(flight.scoringType).toBe("XC");
    expect(flight.isManualLog).toBe(false);
    expect(flight.igcPath).toBe(expectedPath);
    expect(flight.scoredByVersion).toBeTruthy();
    expect(Array.isArray(flight.sanityFlags)).toBe(true);

    // Raw IGC blob persisted…
    expect(await privateBlobExists(expectedPath)).toBe(true);
    // …and the derived Flight is written back onto the round slot.
    const stored = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    const storedFlight = stored?.teams[0]?.pilots[0]?.flight;
    expect(storedFlight?.igcPath).toBe(expectedPath);
    expect(storedFlight?.distance).toBe(flight.distance);
  }, 60_000);

  it("a second upload overwrites the stored IGC blob", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const igcPath = `flight-igcs/${r.roundId}/${r.pilotId}.igc`;
    const canned = {
      distance: 0,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    };
    vi.mocked(scoreIgc).mockResolvedValueOnce(canned).mockResolvedValueOnce(canned);

    const first = new Uint8Array([0x41, 0x2a, 0x2a, 0x41, 0x41]); // 'A**AA'
    const second = new Uint8Array([0x41, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a]); // 'AZZZZZ'

    const up1 = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(first),
      ),
    );
    expect(up1.status).toBe(200);
    expect((await downloadPrivate(igcPath)).equals(Buffer.from(first))).toBe(true);

    const up2 = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(second),
      ),
    );
    expect(up2.status).toBe(200);
    expect((await downloadPrivate(igcPath)).equals(Buffer.from(second))).toBe(true);
  });
});

describe("getIgc — GET /rounds/{id}/teams/{teamId}/pilots/{place}/igc", () => {
  it("401 when unauthenticated", async () => {
    const r = await seedRound();
    const req = makeRequest({ method: "GET", params: paramsFor(r) });

    const res = await invoke("getIgc", req);

    expect(res.status).toBe(401);
  });

  it("200 returns the uploaded IGC bytes and headers", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const body = Buffer.from(D3P);

    const up = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(body),
      ),
    );
    expect(up.status).toBe(200);

    const req = makeAuthRequest(user.id, user.email, { method: "GET", params: paramsFor(r) });
    const res = await invoke("getIgc", req);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as ArrayBuffer)).toEqual(body);
    expect(res.headers).toMatchObject(
      igcHeaders(`bcc-${r.roundId}-team-${r.teamId}-pilot-${r.place}.igc`),
    );
  });

  it("403 when a Pilot requests another pilot's slot", async () => {
    const r = await seedRound({ pilotId: randomUUID() });
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: randomUUID() });
    const req = makeAuthRequest(user.id, user.email, { method: "GET", params: paramsFor(r) });

    const res = await invoke("getIgc", req);

    expect(res.status).toBe(403);
  });

  it("403 when a RoundsCoord is scoped to a different club", async () => {
    const r = await seedRound({ organisingClubId: randomUUID() });
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const req = makeAuthRequest(user.id, user.email, { method: "GET", params: paramsFor(r) });

    const res = await invoke("getIgc", req);

    expect(res.status).toBe(403);
  });

  it("404 when the slot has no IGC yet", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, { method: "GET", params: paramsFor(r) });

    const res = await invoke("getIgc", req);

    expect(res.status).toBe(404);
  });

  it("500 IGC_DOWNLOAD_FAILED when the stored blob download yields no readable stream", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const igcPath = `flight-igcs/${r.roundId}/${r.pilotId}.igc`;

    const up = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );
    expect(up.status).toBe(200);

    // Stub ONLY the IGC path so download() resolves without a readableStreamBody;
    // the removed non-null assertion used to crash here instead of returning 500.
    const realGetPrivateBlobClient = blobModule.getPrivateBlobClient;
    const spy = vi
      .spyOn(blobModule, "getPrivateBlobClient")
      .mockImplementation((p: string) => {
        if (p !== igcPath) return realGetPrivateBlobClient(p);
        return {
          download: async () => ({ readableStreamBody: undefined }),
        } as unknown as ReturnType<typeof realGetPrivateBlobClient>;
      });

    try {
      const req = makeAuthRequest(user.id, user.email, { method: "GET", params: paramsFor(r) });
      const res = await invoke("getIgc", req);

      expect(res.status).toBe(500);
      expect((res.jsonBody as { code: string }).code).toBe("IGC_DOWNLOAD_FAILED");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("deleteIgc — DELETE /rounds/{id}/teams/{teamId}/pilots/{place}/igc", () => {
  it("401 when unauthenticated", async () => {
    const r = await seedRound();
    const req = makeRequest({ method: "DELETE", params: paramsFor(r) });

    const res = await invoke("deleteIgc", req);

    expect(res.status).toBe(401);
  });

  it("403 when a Pilot requests deletion", async () => {
    const r = await seedRound({ pilotId: randomUUID() });
    await uploadFixtureIgc(r);
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: r.pilotId ?? randomUUID() });
    const req = makeAuthRequest(user.id, user.email, { method: "DELETE", params: paramsFor(r) });

    const res = await invoke("deleteIgc", req);

    expect(res.status).toBe(403);
  });

  it("409 ROUND_NOT_LOCKED when the round is not Locked", async () => {
    const r = await seedRound();
    await uploadFixtureIgc(r);
    const round = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    if (!round) throw new Error("round fixture missing");
    round.status = "BriefComplete";
    round.isLocked = false;
    await writePrivateJson(`rounds/${r.roundId}.json`, round);
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, { method: "DELETE", params: paramsFor(r) });

    const res = await invoke("deleteIgc", req);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_NOT_LOCKED");
  });

  it("404 when the slot has no IGC yet", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, { method: "DELETE", params: paramsFor(r) });

    const res = await invoke("deleteIgc", req);

    expect(res.status).toBe(404);
  });

  it("204 removes the slot flight, zeroes pilot points, and deletes the blob", async () => {
    const r = await seedRound();
    await uploadFixtureIgc(r);
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, { method: "DELETE", params: paramsFor(r) });

    const res = await invoke("deleteIgc", req);

    expect(res.status).toBe(204);
    const stored = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    const slot = stored?.teams[0]?.pilots[0];
    expect(slot?.flight).toBeNull();
    expect(slot?.pilotPoints).toBe(0);
    expect(await privateBlobExists(`flight-igcs/${r.roundId}/${r.pilotId}.igc`)).toBe(false);
  });
});
