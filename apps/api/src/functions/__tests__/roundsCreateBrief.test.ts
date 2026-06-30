/**
 * T5 — brief consolidation: the brief is created at ROUND CREATE, times move
 * off the Round onto the brief, and createRound forces `Proposed`.
 *
 * Covers the plan's acceptance checklist:
 *  - POST /rounds with a time → Proposed round (NO times on rounds/{id}.json)
 *    AND round-briefs/{id}.json carrying the time + site W3W + teams:[].
 *  - POST /rounds with status:"BriefComplete" → 400.
 *  - PUT /rounds/{id} with briefingTime/status does NOT mutate the Round.
 *  - A forced brief-write failure still returns 2xx (best-effort) and emits
 *    BOTH ctx.warn(...) and trackTrace("brief.eagerCreateFailed", ...).
 *  - B1: buildInitialBrief writes cleanly under BLOB_SCHEMA_MODE=enforce
 *    (generatedAt + identity fields present) and the eager path ACTUALLY wrote.
 *  - R5: buildInitialBrief is the single seed source — byte-identical for the
 *    same inputs with a frozen clock.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, Season, Site } from "@bccweb/types";
import { BriefSchema } from "@bccweb/schemas";

// Telemetry seam: spy on trackTrace so we can prove the best-effort catch emits
// `brief.eagerCreateFailed`. The client also needs trackEvent because blobJson's
// read-heal path calls getTelemetryClient()?.trackEvent(...).
const telemetryMock = vi.hoisted(() => {
  const trackTrace = vi.fn();
  const trackEvent = vi.fn();
  return { trackTrace, trackEvent, client: { trackTrace, trackEvent } };
});
vi.mock("../../lib/telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => telemetryMock.client),
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeClub,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import * as blobModule from "../../lib/blob.js";
import { getPrivateBlobClient } from "../../lib/blob.js";
import { readJson, writePrivateJson as writePrivateJsonValidated } from "../../lib/blobJson.js";
import { buildInitialBrief } from "../roundsMutate.js";
import "../roundsMutate.js";

const W3W = {
  parkingW3W: "filled.count.soap",
  briefingW3W: "brief.count.soap",
  takeOffW3W: "takeoff.count.soap",
} as const;

function makeSiteObj(id: string): Site {
  return {
    id,
    name: "Milk Hill",
    status: "Active",
    clubId: randomUUID(),
    ...W3W,
    guideUrl: "https://example.com/guide",
  };
}

async function seedSiteSeason(): Promise<{
  year: number;
  siteId: string;
  admin: { id: string; email: string };
}> {
  const { user: admin } = await bootstrapAdmin();
  const year = 4000 + Math.floor(Math.random() * 5000);
  const siteId = randomUUID();
  await writePrivateJson(`sites/${siteId}.json`, makeSiteObj(siteId));
  await writePublicJson(
    `seasons/${year}.json`,
    { id: `season-${year}`, year, active: true, rounds: [], leagueTable: [] } satisfies Season,
  );
  return { year, siteId, admin: { id: admin.id, email: admin.email } };
}

function withSchemaMode<T>(mode: "enforce" | "observe", fn: () => Promise<T>): Promise<T> {
  const original = process.env["BLOB_SCHEMA_MODE"];
  process.env["BLOB_SCHEMA_MODE"] = mode;
  return fn().finally(() => {
    if (original === undefined) delete process.env["BLOB_SCHEMA_MODE"];
    else process.env["BLOB_SCHEMA_MODE"] = original;
  });
}

describe("createRound seeds the brief and forces Proposed (T5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    telemetryMock.trackTrace.mockClear();
    telemetryMock.trackEvent.mockClear();
  });

  it("POST /rounds with times → Proposed round (no times on round) + brief with times, W3W, teams:[]", async () => {
    const { year, siteId, admin } = await seedSiteSeason();
    const club = await makeClub({ id: randomUUID(), name: "Test Org Club" });

    const res = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: {
          date: `${year}-07-15`,
          siteId,
          seasonYear: year,
          organisingClubId: club.id,
          briefingTime: "10:00",
          checkInByTime: "19:00",
          landByTime: "18:00",
        },
      }),
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Round;
    expect(created.status).toBe("Proposed");
    const id = created.id;

    // Round blob carries NO time fields and stays Proposed.
    const persisted = (await readPrivateJson<Record<string, unknown>>(`rounds/${id}.json`))!;
    expect(persisted).not.toBeNull();
    expect(persisted["status"]).toBe("Proposed");
    expect(persisted).not.toHaveProperty("briefingTime");
    expect(persisted).not.toHaveProperty("checkInByTime");
    expect(persisted).not.toHaveProperty("landByTime");

    // Brief blob exists and owns the times + copied site location.
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(true);
    const brief = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    expect(brief.roundId).toBe(id);
    expect(brief.date).toBe(`${year}-07-15`);
    expect(brief.siteName).toBe("Milk Hill");
    expect(brief.briefingTime).toBe("10:00");
    expect(brief.checkInByTime).toBe("19:00");
    expect(brief.landByTime).toBe("18:00");
    expect(brief.parkingW3W).toBe(W3W.parkingW3W);
    expect(brief.briefingW3W).toBe(W3W.briefingW3W);
    expect(brief.takeOffW3W).toBe(W3W.takeOffW3W);
    expect(brief.guideUrl).toBe("https://example.com/guide");
    expect(brief.organisingClubName).toBe("Test Org Club");
    expect(brief.teams).toEqual([]);
    expect(brief.imagePaths).toEqual([]);
    expect(brief.version).toBe(1);
    expect(brief.generatedAt).toBeTruthy();
    expect(brief.hash).toBeUndefined();
  });

  it("POST /rounds with status:\"BriefComplete\" → 400", async () => {
    const { year, siteId, admin } = await seedSiteSeason();

    const res = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { date: `${year}-07-16`, siteId, seasonYear: year, status: "BriefComplete" },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("PUT /rounds/{id} with briefingTime or status does NOT change the Round", async () => {
    const { year, siteId, admin } = await seedSiteSeason();

    const createRes = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { date: `${year}-07-17`, siteId, seasonYear: year },
      }),
    );
    expect(createRes.status).toBe(201);
    const id = (createRes.jsonBody as Round).id;

    const putRes = await invoke(
      "updateRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { id },
        body: { briefingTime: "11:11", status: "Confirmed", maxTeams: 12 },
      }),
    );
    expect(putRes.status).toBe(200);

    const persisted = (await readPrivateJson<Record<string, unknown>>(`rounds/${id}.json`))!;
    // Lifecycle is untouched by PUT and times never land on the Round.
    expect(persisted["status"]).toBe("Proposed");
    expect(persisted).not.toHaveProperty("briefingTime");
    // A non-lifecycle field still updates (proves PUT itself still works).
    expect(persisted["maxTeams"]).toBe(12);
  });

  it("is best-effort: a forced brief-write failure still returns 201 and emits warn + trackTrace", async () => {
    const { year, siteId, admin } = await seedSiteSeason();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalWritePrivateBlob = blobModule.writePrivateBlob;
    vi.spyOn(blobModule, "writePrivateBlob").mockImplementation(
      async (path, data, leaseId, options) => {
        if (path.startsWith("round-briefs/")) {
          throw new Error("simulated brief write failure");
        }
        return originalWritePrivateBlob(path, data, leaseId, options);
      },
    );

    const res = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { date: `${year}-07-18`, siteId, seasonYear: year, briefingTime: "09:00" },
      }),
    );

    expect(res.status).toBe(201);
    const id = (res.jsonBody as Round).id;

    // Round persisted Proposed; brief write failed so the blob is absent.
    const persisted = (await readPrivateJson<Round>(`rounds/${id}.json`))!;
    expect(persisted.status).toBe("Proposed");
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(false);

    // Failure is observable: ctx.warn AND trackTrace("brief.eagerCreateFailed").
    expect(warnSpy).toHaveBeenCalled();
    const eagerFail = telemetryMock.trackTrace.mock.calls.find(
      ([arg]) => (arg as { message?: string } | undefined)?.message === "brief.eagerCreateFailed",
    );
    expect(eagerFail).toBeDefined();
    expect((eagerFail?.[0] as { properties?: { roundId?: string } }).properties?.roundId).toBe(id);
  });

  it("B1: buildInitialBrief writes cleanly under BLOB_SCHEMA_MODE=enforce (generatedAt + identity present)", async () => {
    const siteId = randomUUID();
    await writePrivateJson(`sites/${siteId}.json`, makeSiteObj(siteId));
    const round: Round = {
      id: randomUUID(),
      date: "2026-08-01",
      status: "Proposed",
      isLocked: false,
      maxTeams: 8,
      minimumScore: 0,
      site: { id: siteId, name: "Milk Hill", ...W3W },
      organisingClub: { id: randomUUID(), name: "Org" },
      season: { year: 2026 },
      teams: [],
    };

    await withSchemaMode("enforce", async () => {
      const brief = await buildInitialBrief(round, { briefingTime: "10:00" });
      // The enforce write MUST NOT throw — a missing generatedAt would hard-fail.
      await expect(
        writePrivateJsonValidated(`round-briefs/${round.id}.json`, BriefSchema, brief, undefined, {
          ifNoneMatch: "*",
        }),
      ).resolves.toBeUndefined();

      const back = await readJson(
        getPrivateBlobClient(`round-briefs/${round.id}.json`),
        BriefSchema,
        `round-briefs/${round.id}.json`,
      );
      expect(back.generatedAt).toBeTruthy();
      expect(back.roundId).toBe(round.id);
      expect(back.date).toBe("2026-08-01");
      expect(back.siteName).toBe("Milk Hill");
      expect(back.briefingTime).toBe("10:00");
    });
  });

  it("B1: the eager path actually writes round-briefs/{id}.json under enforce (read it back)", async () => {
    await withSchemaMode("enforce", async () => {
      const { year, siteId, admin } = await seedSiteSeason();
      const res = await invoke(
        "createRound",
        makeAuthRequest(admin.id, admin.email, {
          method: "POST",
          body: { date: `${year}-08-02`, siteId, seasonYear: year, briefingTime: "08:30" },
        }),
      );
      expect(res.status).toBe(201);
      const id = (res.jsonBody as Round).id;

      expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(true);
      const back = await readJson(
        getPrivateBlobClient(`round-briefs/${id}.json`),
        BriefSchema,
        `round-briefs/${id}.json`,
      );
      expect(back.generatedAt).toBeTruthy();
      expect(back.roundId).toBe(id);
      expect(back.siteName).toBe("Milk Hill");
      expect(back.briefingTime).toBe("08:30");
    });
  });

  it("R5: buildInitialBrief is the single seed source — byte-identical for identical inputs (frozen clock)", async () => {
    const siteId = randomUUID();
    await writePrivateJson(`sites/${siteId}.json`, makeSiteObj(siteId));
    const round: Round = {
      id: randomUUID(),
      date: "2026-09-09",
      status: "Proposed",
      isLocked: false,
      maxTeams: 8,
      minimumScore: 0,
      site: { id: siteId, name: "Milk Hill", ...W3W },
      organisingClub: { id: randomUUID(), name: "Org" },
      season: { year: 2026 },
      teams: [],
    };
    const times = { briefingTime: "10:00", checkInByTime: "19:00", landByTime: "18:00" };

    // Freeze only Date (not setTimeout) so the Azurite SDK keeps working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const a = await buildInitialBrief(round, times);
      const b = await buildInitialBrief(round, times);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.generatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(a.teams).toEqual([]);
      expect(a.version).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
