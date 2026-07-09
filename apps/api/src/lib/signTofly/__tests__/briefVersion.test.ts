// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import type { RoundBrief } from "@bccweb/types";
import { BRIEF_EDITABLE_KEYS } from "@bccweb/schemas";
import {
  computeBriefHash,
  diffMaterialFields,
  MATERIAL_BRIEF_FIELDS,
} from "../briefVersion.js";

describe("brief version hashing", () => {
  it("computeBriefHash deterministic: same input → same hash 100 times", () => {
    const brief = makeBrief();
    const hashes = Array.from({ length: 100 }, () => computeBriefHash(brief));

    expect(new Set(hashes).size).toBe(1);
  });

  it("computeBriefHash changes when material field changes (e.g. NOTAMs added)", () => {
    const before = makeBrief({ NOTAMs: "None" });
    const after = makeBrief({ NOTAMs: "Temporary restricted area active" });

    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("computeBriefHash does NOT change when cosmetic field changes (e.g. briefer name or phone)", () => {
    const before = makeBrief({
      briefer: { name: "Alice", phoneNumber: "07000 000000" },
    });
    const after = makeBrief({
      briefer: { name: "Bob", phoneNumber: "07111 111111" },
    });

    expect(computeBriefHash(after)).toBe(computeBriefHash(before));
  });

  it("computeBriefHash changes when frequencyMhz changes (material) and invalidates prior signatures", () => {
    const briefV1 = makeBrief({ frequencyMhz: 143.925 });
    const briefV2 = makeBrief({ frequencyMhz: 144.15 });

    const hashV1 = computeBriefHash(briefV1);
    const hashV2 = computeBriefHash(briefV2);

    expect(hashV2).not.toBe(hashV1);
    expect(diffMaterialFields(briefV1, briefV2)).toEqual(["frequencyMhz"]);
  });

  // ─── Real-bug guard: take-off / parking / briefing W3W are FLAT on RoundBrief ──
  // Changing a take-off W3W must flag the brief as changed. The historical bug
  // hashed nested `site.takeOffW3W` paths that never existed on the flat brief,
  // so W3W edits silently produced an identical hash.
  it("diffMaterialFields flags a parkingW3W-only change (W3W flat-path regression guard)", () => {
    const before = makeBrief({ parkingW3W: "alpha.bravo.charlie" });
    const after = makeBrief({ parkingW3W: "delta.echo.foxtrot" });

    expect(diffMaterialFields(before, after)).toEqual(["parkingW3W"]);
    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("diffMaterialFields flags a takeOffW3W-only change (W3W flat-path regression guard)", () => {
    const before = makeBrief({ takeOffW3W: "charlie.delta.echo" });
    const after = makeBrief({ takeOffW3W: "echo.foxtrot.golf" });

    expect(diffMaterialFields(before, after)).toEqual(["takeOffW3W"]);
    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("diffMaterialFields flags a briefingW3W-only change (W3W flat-path regression guard)", () => {
    const before = makeBrief({ briefingW3W: "bravo.charlie.delta" });
    const after = makeBrief({ briefingW3W: "foxtrot.golf.hotel" });

    expect(diffMaterialFields(before, after)).toEqual(["briefingW3W"]);
  });

  // ─── imagePaths is MATERIAL: add / remove / reorder all change the hash ───────
  it("diffMaterialFields flags an imagePaths addition", () => {
    const before = makeBrief({ imagePaths: ["round-briefs/a.jpg"] });
    const after = makeBrief({
      imagePaths: ["round-briefs/a.jpg", "round-briefs/b.jpg"],
    });

    expect(diffMaterialFields(before, after)).toEqual(["imagePaths"]);
    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("diffMaterialFields flags an imagePaths removal", () => {
    const before = makeBrief({
      imagePaths: ["round-briefs/a.jpg", "round-briefs/b.jpg"],
    });
    const after = makeBrief({ imagePaths: ["round-briefs/a.jpg"] });

    expect(diffMaterialFields(before, after)).toEqual(["imagePaths"]);
  });

  it("diffMaterialFields flags an imagePaths reorder (order is material)", () => {
    const before = makeBrief({
      imagePaths: ["round-briefs/a.jpg", "round-briefs/b.jpg"],
    });
    const after = makeBrief({
      imagePaths: ["round-briefs/b.jpg", "round-briefs/a.jpg"],
    });

    expect(diffMaterialFields(before, after)).toEqual(["imagePaths"]);
    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  // ─── Times stay material ──────────────────────────────────────────────────────
  it("diffMaterialFields flags a briefingTime-only change (times stay material)", () => {
    const before = makeBrief({ briefingTime: "10:00" });
    const after = makeBrief({ briefingTime: "10:30" });

    expect(diffMaterialFields(before, after)).toEqual(["briefingTime"]);
    expect(computeBriefHash(after)).not.toBe(computeBriefHash(before));
  });

  it("narrative is ABSENT from the material key-set", () => {
    expect([...MATERIAL_BRIEF_FIELDS]).not.toContain("narrative");
  });

  it("diffMaterialFields returns only material diffs (mixed material + non-material edit)", () => {
    const before = makeBrief({
      NOTAMs: "None",
      siteName: "Cosmetic Site Name",
      parkingW3W: "alpha.bravo.charlie",
    });
    const after = makeBrief({
      NOTAMs: "Temporary restricted area active",
      siteName: "Renamed Site",
      parkingW3W: "delta.echo.foxtrot",
    });

    expect([...diffMaterialFields(before, after)].sort()).toEqual([
      "NOTAMs",
      "parkingW3W",
    ]);
  });

  it("a non-material-only diff (siteName + teams) reports no material change", () => {
    const before = makeBrief({ siteName: "Site A", teams: [] });
    const after = makeBrief({
      siteName: "Site B",
      teams: [
        { teamName: "Team 1", clubName: "Club", pilots: [] },
      ],
    });

    expect(diffMaterialFields(before, after)).toEqual([]);
    expect(computeBriefHash(after)).toBe(computeBriefHash(before));
  });

  // ─── Stability lock: undefined vs absent material field → identical hash ───────
  it("undefined vs absent for a material field produce the SAME hash", () => {
    const absent = makeBrief();
    delete absent.NOTAMs;
    const explicitUndefined = makeBrief({ NOTAMs: undefined });

    expect(computeBriefHash(explicitUndefined)).toBe(computeBriefHash(absent));
  });

  // ─── Regression lock: a fixed brief hashes to a hard-coded sha256 ─────────────
  it("computeBriefHash of a fixed brief matches the locked sha256 (canonical regression lock)", () => {
    const fixed: RoundBrief = {
      roundId: "fixed-round",
      generatedAt: "2026-06-09T10:00:00.000Z",
      date: "2026-06-09",
      siteName: "Regression Site",
      briefingTime: "10:00",
      checkInByTime: "17:00",
      landByTime: "16:30",
      windSpeedDirection: "10kt WSW",
      directionOfFlight: "East",
      expectedLandingArea: "Goal field",
      airspaceAndHazards: "Avoid controlled airspace",
      NOTAMs: "None",
      BENO_LineDescription: "BENO line description",
      briefersNotes: "Watch sea breeze",
      frequencyMhz: 143.925,
      parkingW3W: "alpha.bravo.charlie",
      briefingW3W: "bravo.charlie.delta",
      takeOffW3W: "charlie.delta.echo",
      imagePaths: ["round-briefs/fixed-1.jpg", "round-briefs/fixed-2.jpg"],
      teams: [],
    };

    expect(computeBriefHash(fixed)).toBe(
      "b85082d085723523c1bf561fd377b096788495c42e2d63d82b6b27f10b6cb062",
    );
  });
});

// ─── B5: materiality-classification drift guard ────────────────────────────────
// Every RoundBrief key MUST be classified as either MATERIAL (safety-critical:
// edits invalidate sign-to-fly) or COSMETIC (non-material: edits do not). The
// drift that caused the W3W bug is structurally impossible if this stays green.
//
// Two layers protect the invariant:
//   1. Compile-time — FULL_BRIEF is `Required<RoundBrief>`, so a new schema field
//      forces a value here (CI typecheck fails until added).
//   2. Runtime — this test FAILS if any key on FULL_BRIEF is in neither set.
// Together: a new field cannot reach production without a conscious material
// vs cosmetic decision.
const COSMETIC_BRIEF_FIELDS = [
  "roundId",
  "generatedAt",
  "date",
  "siteName",
  "hash",
  "guideUrl",
  "organisingClubName",
  "pureTrackGroupName",
  "pureTrackGroupSlug",
  "briefer",
  "version",
  "versionHistory",
  "teams",
] as const satisfies readonly (keyof RoundBrief)[];

const FULL_BRIEF: Required<RoundBrief> = {
  roundId: "round-1",
  generatedAt: "2026-06-09T10:00:00.000Z",
  date: "2026-06-09",
  siteName: "Site",
  hash: "deadbeef",
  guideUrl: "https://example.com/guide",
  parkingW3W: "alpha.bravo.charlie",
  briefingW3W: "bravo.charlie.delta",
  takeOffW3W: "charlie.delta.echo",
  briefingTime: "10:00",
  checkInByTime: "17:00",
  landByTime: "16:30",
  organisingClubName: "Club",
  pureTrackGroupName: "PT",
  pureTrackGroupSlug: "pt",
  windSpeedDirection: "10kt WSW",
  directionOfFlight: "East",
  expectedLandingArea: "Goal field",
  airspaceAndHazards: "Avoid controlled airspace",
  NOTAMs: "None",
  BENO_LineDescription: "BENO line description",
  briefersNotes: "Watch sea breeze",
  frequencyMhz: 143.925,
  briefer: { name: "Alice" },
  imagePaths: ["round-briefs/img-1.jpg"],
  version: 1,
  versionHistory: [],
  teams: [],
};

describe("B5: RoundBrief materiality classification (drift guard)", () => {
  it("MATERIAL and COSMETIC sets are disjoint", () => {
    const material = new Set<string>(MATERIAL_BRIEF_FIELDS);
    const overlap = COSMETIC_BRIEF_FIELDS.filter((key) => material.has(key));

    expect(overlap, `keys classified as BOTH material and cosmetic: ${overlap.join(", ")}`).toEqual([]);
  });

  it("every RoundBrief key is classified material-or-cosmetic (no silent drift)", () => {
    const classified = new Set<string>([
      ...MATERIAL_BRIEF_FIELDS,
      ...COSMETIC_BRIEF_FIELDS,
    ]);
    const unclassified = Object.keys(FULL_BRIEF).filter(
      (key) => !classified.has(key),
    );

    expect(
      unclassified,
      `unclassified RoundBrief keys (add to MATERIAL_BRIEF_FIELDS or COSMETIC_BRIEF_FIELDS): ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("classification sets contain only real RoundBrief keys and cover all of them", () => {
    const allKeys = new Set(Object.keys(FULL_BRIEF));
    const ghosts = [...MATERIAL_BRIEF_FIELDS, ...COSMETIC_BRIEF_FIELDS].filter(
      (key) => !allKeys.has(key),
    );

    expect(ghosts, `classified keys that are not real RoundBrief keys: ${ghosts.join(", ")}`).toEqual([]);
    expect(MATERIAL_BRIEF_FIELDS.length + COSMETIC_BRIEF_FIELDS.length).toBe(
      allKeys.size,
    );
  });
});

describe("B5: BRIEF_EDITABLE_KEYS derives from the single MATERIAL_BRIEF_FIELDS source", () => {
  it("is exactly material-minus-imagePaths-plus-briefer (re-exported material set in lockstep)", () => {
    const derived = [
      ...MATERIAL_BRIEF_FIELDS.filter((field) => field !== "imagePaths"),
      "briefer",
    ];

    expect([...BRIEF_EDITABLE_KEYS].sort()).toEqual([...derived].sort());
    expect([...BRIEF_EDITABLE_KEYS]).not.toContain("imagePaths");
    expect([...BRIEF_EDITABLE_KEYS]).toContain("briefer");
  });
});

function makeBrief(overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: "round-1",
    generatedAt: "2026-06-09T10:00:00.000Z",
    date: "2026-06-09",
    siteName: "Cosmetic Site Name",
    briefingTime: "10:00",
    checkInByTime: "17:00",
    landByTime: "16:30",
    organisingClubName: "Cosmetic Club",
    pureTrackGroupName: "Cosmetic PureTrack",
    windSpeedDirection: "10kt WSW",
    directionOfFlight: "East",
    expectedLandingArea: "Goal field",
    airspaceAndHazards: "Avoid controlled airspace",
    NOTAMs: "None",
    BENO_LineDescription: "BENO line description",
    briefersNotes: "Watch sea breeze",
    frequencyMhz: 143.925,
    parkingW3W: "alpha.bravo.charlie",
    briefingW3W: "bravo.charlie.delta",
    takeOffW3W: "charlie.delta.echo",
    imagePaths: ["round-briefs/img-1.jpg"],
    teams: [],
    ...overrides,
  };
}
