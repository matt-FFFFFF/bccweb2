import { randomUUID } from "node:crypto";
import type { HttpResponseInit } from "@azure/functions";
import type { BriefPdfStatus, Round, RoundBrief, RoundStatus, User } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMock = vi.hoisted(() => ({
  enqueueBriefPdf: vi.fn<() => Promise<void>>(),
}));

const briefPdfMock = vi.hoisted(() => ({
  forceGuardMiss: false,
}));

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: queueMock.enqueueBriefPdf,
}));

vi.mock("../../lib/briefPdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/briefPdf.js")>();
  return {
    ...actual,
    setBriefPdfStatus: vi.fn<typeof actual.setBriefPdfStatus>(async (...args) => {
      const opts = args[2];
      if (briefPdfMock.forceGuardMiss && opts?.newAttemptId !== undefined) {
        return { updated: false };
      }
      return actual.setBriefPdfStatus(...args);
    }),
  };
});

import { getPrivateBlockBlobClient } from "../../lib/blob.js";
import { enqueueBriefPdf } from "../../lib/queue.js";
import { invoke, makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../brief.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PDF_BYTES = Buffer.from("%PDF-1.4 old bytes");

function statusOf(res: HttpResponseInit): number {
  return res.status ?? 200;
}

function codeOf(res: HttpResponseInit): string | undefined {
  return (res.jsonBody as { code?: string } | undefined)?.code;
}

function headerValue(res: HttpResponseInit, name: string): string | undefined {
  if (res.headers instanceof Headers) return res.headers.get(name) ?? undefined;
  return (res.headers as Record<string, string> | undefined)?.[name];
}

function makeRoundFixture(opts: {
  readonly roundId: string;
  readonly clubId: string;
  readonly status: RoundStatus;
  readonly pdfStatus?: BriefPdfStatus;
  readonly pdfAttemptId?: string;
  readonly version?: number;
}): Round {
  const version = opts.version ?? 7;
  return {
    id: opts.roundId,
    date: "2026-06-09",
    status: opts.status,
    isLocked: opts.status === "Locked" || opts.status === "Complete",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: opts.clubId, name: "Test Club" },
    season: { year: 2026 },
    teams: [],
    brief: {
      version,
      jsonPath: `round-briefs/${opts.roundId}.json`,
      pdfPath: `round-briefs/${opts.roundId}.pdf`,
      generatedAt: "2026-06-01T08:00:00.000Z",
      ...(opts.pdfStatus !== undefined ? { pdfStatus: opts.pdfStatus } : {}),
      ...(opts.pdfAttemptId !== undefined ? { pdfAttemptId: opts.pdfAttemptId } : {}),
    },
  };
}

function makeBriefFixture(roundId: string, version = 7): RoundBrief {
  return {
    roundId,
    version,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    teams: [],
    windSpeedDirection: "W 10kt",
  };
}

async function seedRoundWithBrief(opts: {
  readonly status: RoundStatus;
  readonly clubId?: string;
  readonly pdfStatus?: BriefPdfStatus;
  readonly pdfAttemptId?: string;
  readonly writeBrief?: boolean;
  readonly version?: number;
}): Promise<{ readonly roundId: string; readonly clubId: string; readonly version: number }> {
  const roundId = randomUUID();
  const clubId = opts.clubId ?? randomUUID();
  const version = opts.version ?? 7;
  await writePrivateJson(
    `rounds/${roundId}.json`,
    makeRoundFixture({
      roundId,
      clubId,
      status: opts.status,
      pdfStatus: opts.pdfStatus,
      pdfAttemptId: opts.pdfAttemptId,
      version,
    }),
  );
  if (opts.writeBrief ?? true) {
    await writePrivateJson(`round-briefs/${roundId}.json`, makeBriefFixture(roundId, version));
  }
  return { roundId, clubId, version };
}

async function seedPdf(roundId: string): Promise<void> {
  await getPrivateBlockBlobClient(`round-briefs/${roundId}.pdf`).upload(PDF_BYTES, PDF_BYTES.length, {
    blobHTTPHeaders: { blobContentType: "application/pdf" },
    metadata: { sitename: "Milk Hill", date: "2026-06-09" },
  });
}

function authReq(user: Pick<User, "id" | "email">, roundId: string, method: string): ReturnType<typeof makeAuthRequest> {
  return makeAuthRequest(user.id, user.email, {
    method,
    params: { id: roundId },
    headers: { "x-forwarded-for": `${randomUUID()}.brief-regenerate` },
  });
}

async function regenerate(user: Pick<User, "id" | "email">, roundId: string): Promise<HttpResponseInit> {
  return invoke("regenerateRoundBriefPdf", authReq(user, roundId, "POST"));
}

describe("regenerateRoundBriefPdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    briefPdfMock.forceGuardMiss = false;
    queueMock.enqueueBriefPdf.mockResolvedValue(undefined);
  });

  it("returns 202 for an Admin on a locked round and enqueues a fresh attempt without bumping brief version", async () => {
    // Given
    const previousAttemptId = randomUUID();
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const { roundId, version } = await seedRoundWithBrief({
      status: "Locked",
      pdfStatus: "ready",
      pdfAttemptId: previousAttemptId,
    });
    const before = await readPrivateJson<Round>(`rounds/${roundId}.json`);

    // When
    const res = await regenerate(admin, roundId);

    // Then
    expect(statusOf(res)).toBe(202);
    expect(res.jsonBody).toEqual({ pdfStatus: "pending" });
    const after = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    expect(after?.brief?.pdfStatus).toBe("pending");
    expect(after?.brief?.pdfAttemptId).toMatch(UUID_RE);
    expect(after?.brief?.pdfAttemptId).not.toBe(previousAttemptId);
    expect(after?.brief?.version).toBe(before?.brief?.version);
    expect(after?.brief?.version).toBe(version);
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId,
      briefVersion: version,
      pdfAttemptId: after?.brief?.pdfAttemptId,
    });
  });

  it("allows a RoundsCoord from the organising club", async () => {
    // Given
    const clubId = randomUUID();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const { roundId } = await seedRoundWithBrief({ status: "Complete", clubId, pdfStatus: "ready" });

    // When
    const res = await regenerate(coord, roundId);

    // Then
    expect(statusOf(res)).toBe(202);
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
  });

  it("rejects RoundsCoord from another club before enqueueing", async () => {
    // Given
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
    const { roundId } = await seedRoundWithBrief({ status: "Locked", clubId: randomUUID(), pdfStatus: "ready" });

    // When
    const res = await regenerate(coord, roundId);

    // Then
    expect(statusOf(res)).toBe(403);
    expect(codeOf(res)).toBe("FORBIDDEN");
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
  });

  it("rejects a Pilot before enqueueing", async () => {
    // Given
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });
    const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus: "ready" });

    // When
    const res = await regenerate(pilot, roundId);

    // Then
    expect(statusOf(res)).toBe(403);
    expect(codeOf(res)).toBe("FORBIDDEN");
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before enqueueing", async () => {
    // Given
    const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus: "ready" });

    // When
    const res = await invoke("regenerateRoundBriefPdf", makeRequest({ method: "POST", params: { id: roundId } }));

    // Then
    expect(statusOf(res)).toBe(401);
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
  });

  it.each(["Proposed", "Confirmed"] satisfies RoundStatus[])(
    "returns 409 for a %s round before enqueueing",
    async (status) => {
      // Given
      const { user: admin } = await makeUser({ roles: ["Admin"] });
      const { roundId } = await seedRoundWithBrief({ status, pdfStatus: "ready" });

      // When
      const res = await regenerate(admin, roundId);

      // Then
      expect(statusOf(res)).toBe(409);
      expect(codeOf(res)).toBe("PDF_NOT_LOCKED");
      expect(enqueueBriefPdf).not.toHaveBeenCalled();
    },
  );

  it("returns 409 when no brief blob exists", async () => {
    // Given
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus: "ready", writeBrief: false });

    // When
    const res = await regenerate(admin, roundId);

    // Then
    expect(statusOf(res)).toBe(409);
    expect(codeOf(res)).toBe("BRIEF_NOT_FOUND");
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
  });

  it("returns 409 and does not enqueue when the guarded status update detects a concurrent unlock", async () => {
    // Given
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus: "ready" });
    briefPdfMock.forceGuardMiss = true;

    // When
    const res = await regenerate(admin, roundId);

    // Then
    expect(statusOf(res)).toBe(409);
    expect(codeOf(res)).toBe("PDF_NOT_LOCKED");
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
  });

  it("marks the fresh attempt failed and preserves brief version when enqueue rejects", async () => {
    // Given
    const previousAttemptId = randomUUID();
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const { roundId, version } = await seedRoundWithBrief({
      status: "Locked",
      pdfStatus: "ready",
      pdfAttemptId: previousAttemptId,
      version: 11,
    });
    queueMock.enqueueBriefPdf.mockRejectedValueOnce(new Error("queue down"));

    // When
    const res = await regenerate(admin, roundId);

    // Then
    expect(statusOf(res)).toBe(503);
    expect(codeOf(res)).toBe("ENQUEUE_FAILED");
    const after = await readPrivateJson<Round>(`rounds/${roundId}.json`);
    expect(after?.brief?.pdfStatus).toBe("failed");
    expect(after?.brief?.pdfError).toBe("enqueue_failed");
    expect(after?.brief?.pdfAttemptId).toMatch(UUID_RE);
    expect(after?.brief?.pdfAttemptId).not.toBe(previousAttemptId);
    expect(after?.brief?.version).toBe(version);
  });
});

describe("getRoundBriefPdf freshness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMock.enqueueBriefPdf.mockResolvedValue(undefined);
  });

  it.each(["pending", undefined] satisfies Array<BriefPdfStatus | undefined>)(
    "returns 409 without streaming stale PDF bytes when pdfStatus is %s",
    async (pdfStatus) => {
      // Given
      const { user: admin } = await makeUser({ roles: ["Admin"] });
      const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus });
      await seedPdf(roundId);

      // When
      const res = await invoke("getRoundBriefPdf", authReq(admin, roundId, "GET"));

      // Then
      expect(statusOf(res)).toBe(409);
      expect(codeOf(res)).toBe("PDF_NOT_READY");
      expect(res.body).toBeUndefined();
    },
  );

  it("streams the PDF blob when pdfStatus is ready", async () => {
    // Given
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const { roundId } = await seedRoundWithBrief({ status: "Locked", pdfStatus: "ready" });
    await seedPdf(roundId);

    // When
    const res = await invoke("getRoundBriefPdf", authReq(admin, roundId, "GET"));

    // Then
    expect(statusOf(res)).toBe(200);
    expect(res.body).toEqual(PDF_BYTES);
    expect(headerValue(res, "Content-Type")).toBe("application/pdf");
  });
});
