// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * PUT /rounds/{id}/brief — reworked (T6). Brief edit is gated to Proposed/
 * Confirmed, authorized to Admin or the organising-club RoundsCoord, lazily
 * creates an absent brief via buildInitialBrief, and read-merges ONLY the
 * editable subset onto the stored brief (identity + derived state survive).
 *
 * Handler-driven against real Azurite (per-file container). Rounds/briefs are
 * seeded directly so brief presence/absence is controlled per case.
 */

import { randomUUID } from "node:crypto";
import type { Round, RoundBrief } from "@bccweb/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import * as blobModule from "../../lib/blob.js";
import "../brief.js";

function ip(): string {
  return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

function roundObj(id: string, status: Round["status"], clubId: string): Round {
  return {
    id,
    date: "2026-06-15",
    status,
    isLocked: status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: {
      id: randomUUID(),
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: clubId, name: "Org Club" },
    season: { year: 2026 },
    teams: [],
  };
}

function briefObj(id: string, overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: id,
    generatedAt: "2026-06-09T08:00:00.000Z",
    date: "2026-06-15",
    siteName: "Milk Hill",
    teams: [],
    version: 1,
    ...overrides,
  };
}

async function seedRound(status: Round["status"], clubId: string): Promise<string> {
  const id = randomUUID();
  await writePrivateJson(`rounds/${id}.json`, roundObj(id, status, clubId));
  return id;
}

function put(
  user: { id: string; email: string },
  id: string,
  body: unknown,
) {
  return invoke(
    "updateRoundBrief",
    makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id },
      body,
      headers: { "x-forwarded-for": ip() },
    }),
  );
}

function withSchemaMode<T>(mode: "enforce" | "observe", fn: () => Promise<T>): Promise<T> {
  const original = process.env["BLOB_SCHEMA_MODE"];
  process.env["BLOB_SCHEMA_MODE"] = mode;
  return fn().finally(() => {
    if (original === undefined) delete process.env["BLOB_SCHEMA_MODE"];
    else process.env["BLOB_SCHEMA_MODE"] = original;
  });
}

describe("updateRoundBrief — gated, authorized, read-merge (T6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Confirmed: persists airspaceAndHazards AND briefer.name AND frequencyMhz", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("Confirmed", clubId);
    await writePrivateJson(`round-briefs/${id}.json`, briefObj(id));

    const res = await put(admin, id, {
      airspaceAndHazards: "Danger area D123 active",
      briefer: { name: "Alice Briefer", bhpaCoachLevel: "Senior" },
      frequencyMhz: 143.925,
    });

    expect(res.status).toBe(200);
    const persisted = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    expect(persisted.airspaceAndHazards).toBe("Danger area D123 active");
    expect(persisted.briefer?.name).toBe("Alice Briefer");
    expect(persisted.frequencyMhz).toBe(143.925);
  });

  it("BriefComplete: rejected with 409 BRIEF_LOCKED", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("BriefComplete", clubId);
    await writePrivateJson(`round-briefs/${id}.json`, briefObj(id));

    const res = await put(admin, id, { airspaceAndHazards: "should not apply" });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("BRIEF_LOCKED");
    const persisted = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    expect(persisted.airspaceAndHazards).toBeUndefined();
  });

  it("F4: BriefComplete with NO brief blob → 409 BRIEF_LOCKED and NO side-effect brief is created", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("BriefComplete", clubId);
    // Intentionally seed NO brief blob — this is the frozen-round-without-brief edge.
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(false);

    const res = await put(admin, id, { airspaceAndHazards: "should not apply" });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("BRIEF_LOCKED");
    // The early status guard must fail fast BEFORE the lazy-create — a frozen
    // round must never gain a side-effect brief blob (F4 scope-fidelity blocker).
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(false);
  });

  it("cross-club RoundsCoord: 403 FORBIDDEN", async () => {
    const clubA = randomUUID();
    const clubB = randomUUID();
    const { user: coordA } = await makeUser({ roles: ["RoundsCoord"], clubId: clubA });
    const id = await seedRound("Confirmed", clubB);
    await writePrivateJson(`round-briefs/${id}.json`, briefObj(id));

    const res = await put(coordA, id, { airspaceAndHazards: "hijack" });

    expect(res.status).toBe(403);
    const persisted = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    expect(persisted.airspaceAndHazards).toBeUndefined();
  });

  it("same-club RoundsCoord: 200 (authorized)", async () => {
    const clubId = randomUUID();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const id = await seedRound("Confirmed", clubId);
    await writePrivateJson(`round-briefs/${id}.json`, briefObj(id));

    const res = await put(coord, id, { NOTAMs: "NOTAM A1234/26" });

    expect(res.status).toBe(200);
    expect((await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!.NOTAMs).toBe("NOTAM A1234/26");
  });

  it("lazy-create: editing a round with NO brief creates one then applies the edit", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("Confirmed", clubId);
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(false);

    const res = await put(admin, id, { windSpeedDirection: "W 12kt", briefingTime: "09:30" });

    expect(res.status).toBe(200);
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(true);
    const brief = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    // buildInitialBrief seed identity present...
    expect(brief.roundId).toBe(id);
    expect(brief.date).toBe("2026-06-15");
    expect(brief.siteName).toBe("Milk Hill");
    expect(brief.version).toBe(1);
    // ...and the edit applied on top.
    expect(brief.windSpeedDirection).toBe("W 12kt");
    expect(brief.briefingTime).toBe("09:30");
  });

  it("B2: a PARTIAL edit merges onto the stored brief — identity + derived state survive", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("Confirmed", clubId);
    const seeded = briefObj(id, {
      generatedAt: "2020-01-02T03:04:05.000Z",
      hash: "frozen-hash",
      versionHistory: [{ version: 1, hash: "h1", createdAt: "2020-01-01T00:00:00.000Z", createdBy: "admin" }],
      teams: [
        {
          teamName: "Alpha",
          clubName: "Org Club",
          pilots: [],
        },
      ],
      NOTAMs: "original NOTAM",
    });
    await writePrivateJson(`round-briefs/${id}.json`, seeded);

    const res = await put(admin, id, { airspaceAndHazards: "only-this-field" });

    expect(res.status).toBe(200);
    const after = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    // edited field applied
    expect(after.airspaceAndHazards).toBe("only-this-field");
    // identity + derived state untouched by the partial edit
    expect(after.roundId).toBe(id);
    expect(after.generatedAt).toBe("2020-01-02T03:04:05.000Z");
    expect(after.hash).toBe("frozen-hash");
    expect(after.versionHistory).toEqual(seeded.versionHistory);
    expect(after.teams).toEqual(seeded.teams);
    // a non-edited editable field is left alone too
    expect(after.NOTAMs).toBe("original NOTAM");
  });

  it("B2: a body missing ALL identity fields returns 200 (not DATA_SHAPE_INVALID 500), even under enforce", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("Confirmed", clubId);
    await writePrivateJson(`round-briefs/${id}.json`, briefObj(id));

    const res = await withSchemaMode("enforce", () => put(admin, id, { briefersNotes: "no identity in this body" }));

    expect(res.status).toBe(200);
    expect((res.jsonBody as { error?: string }).error).not.toBe("DATA_SHAPE_INVALID");
    expect((await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!.briefersNotes).toBe("no identity in this body");
  });

  it("R3: concurrent first-edit — exactly ONE create wins (CAS), both edits serialize, no field clobbered", async () => {
    const { user: admin } = await bootstrapAdmin();
    const clubId = randomUUID();
    const id = await seedRound("Confirmed", clubId);
    expect(await privateBlobExists(`round-briefs/${id}.json`)).toBe(false);

    let createWins = 0;
    let createSkips = 0;
    // Barrier: hold BOTH lazy-creates at the upload point until both have
    // arrived, so neither has taken the brief lease yet — the ifNoneMatch:"*"
    // CAS is then the SOLE gate, making the single-winner outcome deterministic.
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((r) => {
      release = r;
    });
    const orig = blobModule.writePrivateBlob;
    vi.spyOn(blobModule, "writePrivateBlob").mockImplementation(
      async (path, data, leaseId, options) => {
        const isBriefCreate = path === `round-briefs/${id}.json` && leaseId === undefined;
        if (isBriefCreate) {
          arrived += 1;
          if (arrived >= 2) release();
          await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 1000))]);
        }
        try {
          await orig(path, data, leaseId, options);
          if (isBriefCreate) createWins += 1;
        } catch (e) {
          const sc = (e as { statusCode?: number }).statusCode;
          if (isBriefCreate && (sc === 409 || sc === 412)) createSkips += 1;
          throw e;
        }
      },
    );

    const settled = await Promise.allSettled([
      put(admin, id, { airspaceAndHazards: "A" }),
      put(admin, id, { NOTAMs: "N" }),
    ]);

    // CAS: both creates released together (pre-lease) → exactly one persists.
    expect(createWins).toBe(1);
    expect(createSkips).toBe(1);

    // Retry serializes the two edits — BOTH land and identity is intact.
    const statuses = settled.map((s) => (s.status === "fulfilled" ? s.value.status : 500));
    expect(statuses).toEqual([200, 200]);
    const brief = (await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`))!;
    expect(brief.roundId).toBe(id);
    expect(brief.date).toBe("2026-06-15");
    expect(brief.siteName).toBe("Milk Hill");
    expect(brief.airspaceAndHazards).toBe("A");
    expect(brief.NOTAMs).toBe("N");
  });
});
