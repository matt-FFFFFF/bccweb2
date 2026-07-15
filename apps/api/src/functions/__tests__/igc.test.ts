// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Flight, Round } from "@bccweb/types";
import { ConfigSchema } from "@bccweb/schemas";
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

vi.mock("../../lib/igcValidationJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/igcValidationJob.js")>()),
  enqueueIgcValidation: vi.fn(),
}));

import { scoreIgc } from "../../lib/igcScoring.js";
import { enqueueIgcValidation } from "../../lib/igcValidationJob.js";
import "../igc.js";

beforeEach(async () => {
  vi.mocked(scoreIgc).mockClear();
  vi.mocked(enqueueIgcValidation).mockReset().mockResolvedValue(undefined);
  await writeConfig({});
});

// ─── Fixtures + request builders ────────────────────────────────────────────────

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../../lib/__tests__/fixtures/igc/${name}`, import.meta.url));

const D3P = fixture("d3p.igc"); // real track, ~60.8 km open-distance, first byte 'A'
const FAI_SIGNATURE_VALIDATION_MAX_BYTES = 3_000_000;

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

async function writeConfig(overrides: Partial<Config>): Promise<void> {
  await writePrivateJson("config.json", ConfigSchema.parse(overrides));
}

async function listPrivateBlobNames(prefix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const blob of getPrivateContainer().listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  return names;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("deferred promise is not initialised");
      resolvePromise(value);
    },
  };
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

  it("rejects an IGC over the FAI limit without persisting or enqueueing when signature validation is enabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: true });
    const { user } = await bootstrapAdmin();
    const bytes = new Uint8Array(FAI_SIGNATURE_VALIDATION_MAX_BYTES + 1);
    bytes[0] = 0x41;
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(bytes, "over-fai-limit.igc"),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(413);
    expect((res.jsonBody as { code: string }).code).toBe("IGC_TOO_LARGE_FOR_VALIDATION");
    expect(await listPrivateBlobNames(`flight-igcs/${r.roundId}/`)).toEqual([]);
    expect((await readPrivateJson<Round>(`rounds/${r.roundId}.json`))?.teams[0]?.pilots[0]?.flight)
      .toBeNull();
    expect(enqueueIgcValidation).not.toHaveBeenCalled();
  });

  it("accepts an IGC over the FAI limit when signature validation is disabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: false });
    const { user } = await bootstrapAdmin();
    const bytes = new Uint8Array(FAI_SIGNATURE_VALIDATION_MAX_BYTES + 1);
    bytes[0] = 0x41;
    vi.mocked(scoreIgc).mockResolvedValueOnce({
      distance: 42,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(bytes, "over-fai-limit.igc"),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(200);
    const flight = res.jsonBody as Flight;
    expect(await privateBlobExists(flight.igcPath ?? "")).toBe(true);
    expect(enqueueIgcValidation).not.toHaveBeenCalled();
  });

  it("uploads and enqueues an IGC at the FAI limit when signature validation is enabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: true });
    const { user } = await bootstrapAdmin();
    const bytes = new Uint8Array(FAI_SIGNATURE_VALIDATION_MAX_BYTES);
    bytes[0] = 0x41;
    vi.mocked(scoreIgc).mockResolvedValueOnce({
      distance: 42,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });
    const req = withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(bytes, "at-fai-limit.igc"),
    );

    const res = await invoke("uploadIgc", req);

    expect(res.status).toBe(200);
    const flight = res.jsonBody as Flight;
    expect(await privateBlobExists(flight.igcPath ?? "")).toBe(true);
    expect(enqueueIgcValidation).toHaveBeenCalledWith({
      roundId: r.roundId,
      teamId: r.teamId,
      place: r.place,
      flightId: flight.id,
      validationAttemptId: flight.validation?.validationAttemptId,
    });
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
    const expectedPath = `flight-igcs/${r.roundId}/${r.pilotId}/${flight.id}.igc`;
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

  it("a second upload uses a new immutable path and deletes the superseded blob", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
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
    const firstFlight = up1.jsonBody as Flight;
    const firstPath = firstFlight.igcPath;
    expect(firstPath).toBe(`flight-igcs/${r.roundId}/${r.pilotId}/${firstFlight.id}.igc`);
    expect((await downloadPrivate(firstPath ?? "")).equals(Buffer.from(first))).toBe(true);

    if (!firstPath) throw new Error("first upload path missing");
    const cleanupStarted = deferred<void>();
    const allowCleanup = deferred<void>();
    const originalDelete = BlockBlobClient.prototype.deleteIfExists;
    const deleteSpy = vi
      .spyOn(BlockBlobClient.prototype, "deleteIfExists")
      .mockImplementation(async function (
        this: BlockBlobClient,
        options: Parameters<BlockBlobClient["deleteIfExists"]>[0],
      ) {
        if (this.name === firstPath) {
          cleanupStarted.resolve();
          await allowCleanup.promise;
        }
        return originalDelete.call(this, options);
      });

    const secondUpload = invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(second),
      ),
    );
    let up2;
    try {
      await cleanupStarted.promise;
      const completion = await Promise.race([
        secondUpload.then(() => "returned" as const),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(completion).toBe("pending");
      allowCleanup.resolve();
      up2 = await secondUpload;
    } finally {
      allowCleanup.resolve();
      deleteSpy.mockRestore();
    }

    expect(up2.status).toBe(200);
    const secondFlight = up2.jsonBody as Flight;
    const secondPath = secondFlight.igcPath;
    expect(secondFlight.id).not.toBe(firstFlight.id);
    expect(secondPath).toBe(`flight-igcs/${r.roundId}/${r.pilotId}/${secondFlight.id}.igc`);
    expect(await privateBlobExists(firstPath ?? "")).toBe(false);
    expect((await downloadPrivate(secondPath ?? "")).equals(Buffer.from(second))).toBe(true);
  });

  it("enqueues and returns the committed flight when superseded blob cleanup fails", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: true });
    const { user } = await bootstrapAdmin();
    const request = () => withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );
    const first = await invoke("uploadIgc", request());
    const firstPath = (first.jsonBody as Flight).igcPath;
    if (!firstPath) throw new Error("first upload path missing");
    vi.mocked(enqueueIgcValidation).mockClear();
    const originalDelete = BlockBlobClient.prototype.deleteIfExists;
    const deleteSpy = vi
      .spyOn(BlockBlobClient.prototype, "deleteIfExists")
      .mockImplementation(function (
        this: BlockBlobClient,
        options: Parameters<BlockBlobClient["deleteIfExists"]>[0],
      ) {
        if (this.name === firstPath) {
          return Promise.reject(new Error("injected cleanup failure"));
        }
        return originalDelete.call(this, options);
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const second = await invoke("uploadIgc", request());

      expect(second.status).toBe(200);
      const flight = second.jsonBody as Flight;
      expect(flight.id).not.toBe((first.jsonBody as Flight).id);
      expect(flight.validation).toMatchObject({
        signature: "pending",
        validationAttemptId: expect.any(String),
      });
      expect(enqueueIgcValidation).toHaveBeenCalledWith({
        roundId: r.roundId,
        teamId: r.teamId,
        place: r.place,
        flightId: flight.id,
        validationAttemptId: flight.validation?.validationAttemptId,
      });
      const persisted = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
      expect(persisted?.teams[0]?.pilots[0]?.flight).toEqual(flight);
      expect(warnSpy).toHaveBeenCalledWith(
        "Superseded IGC cleanup failed",
        "Error",
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(firstPath);
    } finally {
      warnSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it("sets signature pending and enqueues the matching validation attempt when enabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: true });
    const { user } = await bootstrapAdmin();

    const res = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );

    expect(res.status).toBe(200);
    const flight = res.jsonBody as Flight;
    expect(flight.validation?.signature).toBe("pending");
    expect(flight.validation?.validationAttemptId).toEqual(expect.any(String));
    expect(enqueueIgcValidation).toHaveBeenCalledWith({
      roundId: r.roundId,
      teamId: r.teamId,
      place: r.place,
      flightId: flight.id,
      validationAttemptId: flight.validation?.validationAttemptId,
    });
  });

  it("omits signature validation and does not enqueue when disabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: false });
    const { user } = await bootstrapAdmin();

    const res = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Flight).validation?.signature).toBeUndefined();
    expect(enqueueIgcValidation).not.toHaveBeenCalled();
  });

  it("marks a mismatched IGC date invalid when date validation is enabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightDateValidationEnabled: true });
    const { user } = await bootstrapAdmin();
    vi.mocked(scoreIgc).mockResolvedValueOnce({
      distance: 1,
      sanityFlags: ["IGC_DATE_MISMATCH"],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });

    const res = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Flight).validation?.date).toBe("invalid");
  });

  it("omits date validation when date validation is disabled", async () => {
    const r = await seedRound();
    await writeConfig({ flightDateValidationEnabled: false });
    const { user } = await bootstrapAdmin();
    vi.mocked(scoreIgc).mockResolvedValueOnce({
      distance: 1,
      sanityFlags: ["IGC_DATE_MISMATCH"],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });

    const res = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Flight).validation?.date).toBeUndefined();
  });

  it("marks the current attempt unverified when enqueue fails", async () => {
    const r = await seedRound();
    await writeConfig({ flightSignatureValidationEnabled: true });
    const { user } = await bootstrapAdmin();
    vi.mocked(enqueueIgcValidation).mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );

    expect(res.status).toBe(200);
    const stored = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    expect(stored?.teams[0]?.pilots[0]?.flight?.validation).toMatchObject({
      signature: "unverified",
      faiStatus: "ENQUEUE_FAILED",
    });
  });

  it("rejects a round completed during scoring and removes the uncommitted IGC blob", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const scoring = deferred<Awaited<ReturnType<typeof scoreIgc>>>();
    const started = deferred<void>();
    vi.mocked(scoreIgc).mockImplementationOnce(async () => {
      started.resolve();
      return scoring.promise;
    });

    const upload = invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );
    await started.promise;
    const current = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    if (!current) throw new Error("round fixture missing");
    current.status = "Complete";
    current.isLocked = true;
    await writePrivateJson(`rounds/${r.roundId}.json`, current);
    scoring.resolve({
      distance: 1,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });

    const res = await upload;

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_NOT_LOCKED");
    expect(await listPrivateBlobNames(`flight-igcs/${r.roundId}/`)).toEqual([]);
  });

  it("rejects a slot reassigned during scoring and removes the uncommitted IGC blob", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const scoring = deferred<Awaited<ReturnType<typeof scoreIgc>>>();
    const started = deferred<void>();
    vi.mocked(scoreIgc).mockImplementationOnce(async () => {
      started.resolve();
      return scoring.promise;
    });

    const upload = invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );
    await started.promise;
    const current = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    const slot = current?.teams[0]?.pilots[0];
    if (!current || !slot) throw new Error("round fixture missing");
    slot.pilotId = randomUUID();
    await writePrivateJson(`rounds/${r.roundId}.json`, current);
    scoring.resolve({
      distance: 1,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    });

    const res = await upload;

    expect(res.status).toBe(404);
    expect(await listPrivateBlobNames(`flight-igcs/${r.roundId}/`)).toEqual([]);
  });

  it("two concurrent uploads retain only the blob referenced by the winning flight", async () => {
    const r = await seedRound();
    const { user } = await bootstrapAdmin();
    const firstScoring = deferred<Awaited<ReturnType<typeof scoreIgc>>>();
    const secondScoring = deferred<Awaited<ReturnType<typeof scoreIgc>>>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    vi.mocked(scoreIgc)
      .mockImplementationOnce(async () => {
        firstStarted.resolve();
        return firstScoring.promise;
      })
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        return secondScoring.promise;
      });
    const request = () => withFile(
      makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
      igcFile(D3P),
    );

    const firstUpload = invoke("uploadIgc", request());
    const secondUpload = invoke("uploadIgc", request());
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const result = {
      distance: 1,
      sanityFlags: [],
      scoredAt: new Date().toISOString(),
      scoredByVersion: "test",
      parserErrors: [],
    };
    firstScoring.resolve(result);
    secondScoring.resolve(result);
    const responses = await Promise.all([firstUpload, secondUpload]);

    expect(responses.some((response) => response.status === 200)).toBe(true);
    const stored = await readPrivateJson<Round>(`rounds/${r.roundId}.json`);
    const winningPath = stored?.teams[0]?.pilots[0]?.flight?.igcPath;
    expect(winningPath).toEqual(expect.any(String));
    expect(await listPrivateBlobNames(`flight-igcs/${r.roundId}/`)).toEqual([winningPath]);
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
    const up = await invoke(
      "uploadIgc",
      withFile(
        makeAuthRequest(user.id, user.email, { method: "POST", params: paramsFor(r) }),
        igcFile(D3P),
      ),
    );
    expect(up.status).toBe(200);
    const igcPath = (up.jsonBody as Flight).igcPath;
    if (!igcPath) throw new Error("uploaded IGC path missing");

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
    expect(await listPrivateBlobNames(`flight-igcs/${r.roundId}/`)).toEqual([]);
  });
});
