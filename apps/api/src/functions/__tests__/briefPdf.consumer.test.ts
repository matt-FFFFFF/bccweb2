import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Round, RoundBrief } from "@bccweb/types";

const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn(),
}));

vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

import { invokeQueue } from "../../__tests__/helpers/api.js";
import {
  clearSentEmails,
  getSentEmails,
} from "../../__tests__/helpers/setup.js";
import {
  privateBlobExists,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { getBriefRecipients } from "../../lib/email.js";
import { getPrivateBlobClient } from "../../lib/blob.js";
import { readJson } from "../../lib/blobJson.js";
import { RoundSchema } from "@bccweb/schemas";

import "../briefPdf.js";

const PDF_A = Buffer.from("%PDF-1.4 attempt-a");
const PDF_B = Buffer.from("%PDF-1.4 attempt-b");
const PDF_STALE = Buffer.from("%PDF-1.4 stale");
const VERSION = 3;

interface SeededBriefPdfJob {
  readonly roundId: string;
  readonly briefVersion: number;
  readonly pdfAttemptId: string;
}

function makeRound(roundId: string, pdfAttemptId: string, pdfStatus: "pending" | "processing" | "ready" | "failed" = "pending"): Round {
  return {
    id: roundId,
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    season: { year: 2026 },
    teams: [],
    brief: {
      version: VERSION,
      jsonPath: `round-briefs/${roundId}.json`,
      pdfPath: `round-briefs/${roundId}.pdf`,
      generatedAt: "2026-06-01T08:00:00.000Z",
      pdfStatus,
      pdfAttemptId,
    },
  };
}

function makeBrief(roundId: string): RoundBrief {
  return {
    roundId,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    version: VERSION,
    teams: [],
    windSpeedDirection: "W 10kt",
  };
}

async function seedJob(opts: {
  readonly attemptId?: string;
  readonly status?: "pending" | "processing" | "ready" | "failed";
} = {}): Promise<SeededBriefPdfJob> {
  const roundId = randomUUID();
  const pdfAttemptId = opts.attemptId ?? "A";
  await writePrivateJson(`rounds/${roundId}.json`, makeRound(roundId, pdfAttemptId, opts.status));
  await writePrivateJson(`round-briefs/${roundId}.json`, makeBrief(roundId));
  return { roundId, briefVersion: VERSION, pdfAttemptId };
}

async function readRound(roundId: string): Promise<Round> {
  return readJson(getPrivateBlobClient(`rounds/${roundId}.json`), RoundSchema, `rounds/${roundId}.json`);
}

async function readPdf(roundId: string): Promise<Buffer> {
  const response = await getPrivateBlobClient(`round-briefs/${roundId}.pdf`).download();
  const chunks: Buffer[] = [];
  const stream = response.readableStreamBody;
  if (!stream) throw new Error("PDF blob response had no readable stream");
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("briefPdf queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSentEmails();
    pdfMock.generateBriefPdf.mockResolvedValue(PDF_A);
    vi.mocked(getBriefRecipients).mockReturnValue(["ops@example.com"]);
  });

  it("renders, commits ready status, and sends one email for a fresh pending job", async () => {
    // Given
    const job = await seedJob();

    // When
    await invokeQueue("briefPdf", job, { dequeueCount: 1 });

    // Then
    expect(await privateBlobExists(`round-briefs/${job.roundId}.pdf`)).toBe(true);
    expect(await readPdf(job.roundId)).toEqual(PDF_A);
    expect((await readRound(job.roundId)).brief?.pdfStatus).toBe("ready");
    expect(getSentEmails()).toHaveLength(1);
  });

  it("does not resend email when the same ready job is redelivered", async () => {
    // Given
    const job = await seedJob();
    await invokeQueue("briefPdf", job, { dequeueCount: 1 });

    // When
    await invokeQueue("briefPdf", job, { dequeueCount: 1 });

    // Then
    expect(getSentEmails()).toHaveLength(1);
    expect((await readRound(job.roundId)).brief?.pdfStatus).toBe("ready");
  });

  it("returns without writing PDF or email when the attempt is stale", async () => {
    // Given
    const job = await seedJob({ attemptId: "A" });

    // When
    await invokeQueue("briefPdf", { ...job, pdfAttemptId: "OLD" }, { dequeueCount: 1 });

    // Then
    expect(await privateBlobExists(`round-briefs/${job.roundId}.pdf`)).toBe(false);
    expect(getSentEmails()).toHaveLength(0);
    expect((await readRound(job.roundId)).brief?.pdfStatus).toBe("pending");
  });

  it("marks failed with a bounded safe error after the final dequeue", async () => {
    // Given
    const job = await seedJob();
    pdfMock.generateBriefPdf.mockRejectedValue(new Error("pilot@example.com 07123456789 medicalInfo"));

    // When
    await invokeQueue("briefPdf", job, { dequeueCount: 5 });

    // Then
    const round = await readRound(job.roundId);
    expect(round.brief?.pdfStatus).toBe("failed");
    expect(round.brief?.pdfError).not.toContain("pilot@example.com");
    expect(round.brief?.pdfError).not.toContain("07123456789");
    expect(round.brief?.pdfError).not.toContain("medicalInfo");
  });

  it("poison handler returns without throwing for an unparseable message", async () => {
    // Given / When / Then
    await expect(invokeQueue("briefPdfPoison", "{bad", { dequeueCount: 1 })).resolves.toBeUndefined();
  });

  it("does not let a stale attempt overwrite an already-ready PDF", async () => {
    // Given
    const job = await seedJob({ attemptId: "B", status: "pending" });
    pdfMock.generateBriefPdf.mockResolvedValueOnce(PDF_B);
    await invokeQueue("briefPdf", job, { dequeueCount: 1 });
    clearSentEmails();
    pdfMock.generateBriefPdf.mockResolvedValueOnce(PDF_STALE);

    // When
    await invokeQueue("briefPdf", { ...job, pdfAttemptId: "A" }, { dequeueCount: 5 });

    // Then
    expect(await readPdf(job.roundId)).toEqual(PDF_B);
    expect(getSentEmails()).toHaveLength(0);
    expect((await readRound(job.roundId)).brief?.pdfStatus).toBe("ready");
  });

  it("does not regress a ready round to failed when a final-dequeue duplicate throws", async () => {
    // Given
    const job = await seedJob({ attemptId: "A", status: "pending" });
    await invokeQueue("briefPdf", job, { dequeueCount: 1 });
    pdfMock.generateBriefPdf.mockRejectedValue(new Error("forced"));

    // When
    await invokeQueue("briefPdf", job, { dequeueCount: 5 });

    // Then
    const round = await readRound(job.roundId);
    expect(round.brief?.pdfStatus).toBe("ready");
    expect(round.brief?.pdfError).toBeUndefined();
  });
});
