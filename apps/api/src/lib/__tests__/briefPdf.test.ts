// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import { describe, expect, test } from "vitest";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { getPrivateBlobClient } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import { commitBriefPdfReady, setBriefPdfStatus } from "../briefPdf.js";

function roundFixture(overrides: Partial<Round> = {}): Round {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    date: "2026-07-05",
    status: "Locked",
    isLocked: true,
    maxTeams: 1,
    minimumScore: 0,
    site: { id: "site-1", name: "Test Site" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-1",
        teamName: "Alpha",
        club: { id: "club-1", name: "Test Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Empty",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: null,
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
    brief: {
      version: 1,
      jsonPath: `round-briefs/${id}.json`,
      pdfPath: `round-briefs/${id}.pdf`,
      generatedAt: "2026-07-05T10:00:00.000Z",
      pdfStatus: "pending",
      pdfAttemptId: "A",
    },
    ...overrides,
  };
}

async function seedRound(round: Round): Promise<void> {
  await writePrivateJson(`rounds/${round.id}.json`, RoundSchema, round);
}

async function readRound(id: string): Promise<Round> {
  return readJson(getPrivateBlobClient(`rounds/${id}.json`), RoundSchema, `rounds/${id}.json`);
}

async function readPdf(path: string): Promise<Buffer> {
  const response = await getPrivateContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("brief PDF status helpers", () => {
  test("setBriefPdfStatus updates only brief status when attempt and CAS guards match", async () => {
    const round = roundFixture();
    await seedRound(round);
    const originalTeams = structuredClone(round.teams);

    const result = await setBriefPdfStatus(round.id, "ready", {
      expectAttemptId: "A",
      fromStatuses: ["pending", "processing", "failed"],
    });

    const updated = await readRound(round.id);
    expect(result).toEqual({ updated: true, previousStatus: "pending" });
    expect(updated.brief?.pdfStatus).toBe("ready");
    expect(updated.status).toBe(round.status);
    expect(updated.isLocked).toBe(round.isLocked);
    expect(updated.teams).toEqual(originalTeams);
  });

  test("setBriefPdfStatus skips writes for superseded attempts and CAS misses", async () => {
    const round = roundFixture({ brief: { ...roundFixture().brief, pdfStatus: "ready" } });
    await seedRound(round);
    const before = await readRound(round.id);

    const superseded = await setBriefPdfStatus(round.id, "ready", { expectAttemptId: "B" });
    const casMiss = await setBriefPdfStatus(round.id, "ready", {
      expectAttemptId: "A",
      fromStatuses: ["processing"],
    });

    expect(superseded).toEqual({ updated: false, previousStatus: "ready" });
    expect(casMiss).toEqual({ updated: false, previousStatus: "ready" });
    expect(await readRound(round.id)).toEqual(before);
  });

  test("commitBriefPdfReady writes canonical PDF once and blocks stale stomps", async () => {
    const round = roundFixture();
    await seedRound(round);
    const pdfPath = `round-briefs/${round.id}.pdf`;
    const firstPdf = Buffer.from("first canonical pdf");
    const stalePdf = Buffer.from("stale pdf should not win");

    const committed = await commitBriefPdfReady(round.id, firstPdf, {
      expectAttemptId: "A",
      siteName: "Test Site",
      date: "2026-07-05",
    });
    await seedRound({
      ...round,
      brief: { ...round.brief, pdfAttemptId: "B", pdfStatus: "processing" },
    });
    const stale = await commitBriefPdfReady(round.id, stalePdf, {
      expectAttemptId: "A",
      siteName: "Test Site",
      date: "2026-07-05",
    });

    const properties = await getPrivateContainer().getBlobClient(pdfPath).getProperties();
    expect(committed).toEqual({ committed: true });
    expect(stale).toEqual({ committed: false });
    expect(await readPdf(pdfPath)).toEqual(firstPdf);
    expect(properties.contentType).toBe("application/pdf");
    expect(properties.metadata).toMatchObject({ sitename: "Test Site", date: "2026-07-05" });
  });

  test("setBriefPdfStatus starts a new attempt only when required round status still matches", async () => {
    const round = roundFixture({ status: "Confirmed", isLocked: false });
    await seedRound(round);
    const before = await readRound(round.id);

    const result = await setBriefPdfStatus(round.id, "pending", {
      newAttemptId: "C",
      requireRoundStatuses: ["Locked", "Complete"],
    });

    expect(result).toEqual({ updated: false, previousStatus: "pending" });
    expect(await readRound(round.id)).toEqual(before);
  });

  test("setBriefPdfStatus bounds and redacts persisted pdfError", async () => {
    const round = roundFixture();
    await seedRound(round);
    const error = `email matt@example.test phone 07700 900000 ${"x".repeat(300)}`;

    const result = await setBriefPdfStatus(round.id, "failed", { error });

    const updated = await readRound(round.id);
    expect(result).toEqual({ updated: true, previousStatus: "pending" });
    expect(updated.brief?.pdfError?.length).toBeLessThanOrEqual(200);
    expect(updated.brief?.pdfError).not.toContain("matt@example.test");
    expect(updated.brief?.pdfError).not.toContain("07700 900000");
  });

  test("setBriefPdfStatus preserves safe short pdfError codes", async () => {
    const round = roundFixture();
    await seedRound(round);

    const result = await setBriefPdfStatus(round.id, "failed", { error: "enqueue_failed" });

    const updated = await readRound(round.id);
    expect(result).toEqual({ updated: true, previousStatus: "pending" });
    expect(updated.brief?.pdfError).toBe("enqueue_failed");
  });
});
