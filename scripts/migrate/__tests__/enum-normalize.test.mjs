import assert from "node:assert/strict";
import test from "node:test";

import {
  createTally,
  normalizeCoachType,
  normalizePilotRating,
  normalizeRoundStatus,
  normalizeScoringType,
  normalizeWingClass,
} from "../enum-normalize.mjs";

const cases = [
  {
    name: "coach type",
    normalize: normalizeCoachType,
    canonical: ["None", "ClubCoach", "SeniorCoach", "Instructor", "SeniorInstructor"],
    aliases: [
      ["none", "None"],
      ["clubCoach", "ClubCoach"],
      ["club_coach", "ClubCoach"],
      ["Club Coach", "ClubCoach"],
      ["seniorCoach", "SeniorCoach"],
      ["senior_coach", "SeniorCoach"],
      ["Senior Coach", "SeniorCoach"],
      ["instructor", "Instructor"],
      ["seniorInstructor", "SeniorInstructor"],
      ["senior_instructor", "SeniorInstructor"],
      ["Senior Instructor", "SeniorInstructor"],
    ],
    unknown: "chiefCoach",
  },
  {
    name: "pilot rating",
    normalize: normalizePilotRating,
    canonical: ["Club Pilot", "Pilot", "Advanced Pilot"],
    aliases: [
      ["clubPilot", "Club Pilot"],
      ["club_pilot", "Club Pilot"],
      ["ClubPilot", "Club Pilot"],
      ["CP", "Club Pilot"],
      ["pilot", "Pilot"],
      ["advancedPilot", "Advanced Pilot"],
      ["advanced_pilot", "Advanced Pilot"],
      ["AdvancedPilot", "Advanced Pilot"],
    ],
    unknown: "expertPilot",
  },
  {
    name: "wing class",
    normalize: normalizeWingClass,
    canonical: ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"],
    aliases: [
      ["EN_A", "EN A"],
      ["EN_B", "EN B"],
      ["EN_C", "EN C"],
      ["EN_D", "EN D"],
      ["EN_C_2_LINER", "EN C 2-liner"],
      ["ENC2Liner", "EN C 2-liner"],
      ["EN_C_2_LINER_LOWER", "EN C 2-liner"],
      ["EN_D_2_LINER", "EN D 2-liner"],
      ["END2Liner", "EN D 2-liner"],
      ["EN_D_2_LINER_LOWER", "EN D 2-liner"],
    ],
    unknown: "CCC",
  },
  {
    name: "round status",
    normalize: normalizeRoundStatus,
    canonical: ["Proposed", "Confirmed", "BriefComplete", "Locked", "Complete", "Cancelled"],
    aliases: [
      ["Draft", "Proposed"],
      ["draft", "Proposed"],
      ["proposed", "Proposed"],
      ["submitted", "Proposed"],
      ["Submitted", "Proposed"],
      ["Active", "Confirmed"],
      ["active", "Confirmed"],
      ["confirmed", "Confirmed"],
      ["verified", "Confirmed"],
      ["Verified", "Confirmed"],
      ["BriefingComplete", "BriefComplete"],
      ["briefingComplete", "BriefComplete"],
      ["briefing_complete", "BriefComplete"],
      ["brief_complete", "BriefComplete"],
      ["brief complete", "BriefComplete"],
      ["briefcomplete", "BriefComplete"],
      ["Brief Complete", "BriefComplete"],
      ["locked", "Locked"],
      ["completed", "Complete"],
      ["complete", "Complete"],
      ["cancelled", "Cancelled"],
      ["canceled", "Cancelled"],
      ["deleted", "Cancelled"],
      ["Deleted", "Cancelled"],
    ],
    unknown: "postponed",
  },
  {
    name: "scoring type",
    normalize: normalizeScoringType,
    canonical: ["XC", "Manual"],
    aliases: [
      ["xc", "XC"],
      ["Xc", "XC"],
      ["puretrack", "XC"],
      ["PureTrack", "XC"],
      ["manual", "Manual"],
    ],
    unknown: "race",
  },
];

for (const { name, normalize, canonical, aliases, unknown } of cases) {
  test(`${name}: canonical values pass through unchanged`, () => {
    for (const value of canonical) {
      assert.equal(normalize(value), value);
    }
  });

  test(`${name}: aliases normalize case-insensitively`, () => {
    for (const [raw, expected] of aliases) {
      assert.equal(normalize(raw), expected);
      assert.equal(normalize(raw.toUpperCase()), expected);
    }
  });

  test(`${name}: null, empty, and unknown values return null`, () => {
    assert.equal(normalize(null), null);
    assert.equal(normalize(undefined), null);
    assert.equal(normalize(""), null);
    assert.equal(normalize("   "), null);
    assert.equal(normalize(unknown), null);
  });
}

test("specific migration aliases stay locked", () => {
  assert.equal(normalizePilotRating("CP"), "Club Pilot");
  assert.equal(normalizeCoachType("Club Coach"), "ClubCoach");
  assert.equal(normalizeRoundStatus("active"), "Confirmed");
  assert.equal(normalizeRoundStatus("Deleted"), "Cancelled");
  assert.equal(normalizeRoundStatus("Inactive"), null);
  assert.equal(normalizeScoringType("puretrack"), "XC");
  assert.equal(normalizeWingClass("EN_B"), "EN B");
});

test("tally records rewritten, passthrough, and unmapped counts per normalizer", () => {
  const tally = createTally();

  assert.equal(normalizeCoachType("None", tally), "None");
  assert.equal(normalizeCoachType("Club Coach", tally), "ClubCoach");
  assert.equal(normalizeCoachType("bogus", tally), null);
  assert.equal(normalizeCoachType(null, tally), null);

  assert.equal(normalizeRoundStatus("Confirmed", tally), "Confirmed");
  assert.equal(normalizeRoundStatus("active", tally), "Confirmed");
  assert.equal(normalizeRoundStatus("Inactive", tally), null);

  assert.deepEqual(tally, {
    coachType: { rewritten: 1, passthrough: 1, unmapped: 1 },
    pilotRating: { rewritten: 0, passthrough: 0, unmapped: 0 },
    wingClass: { rewritten: 0, passthrough: 0, unmapped: 0 },
    roundStatus: { rewritten: 1, passthrough: 1, unmapped: 1 },
    scoringType: { rewritten: 0, passthrough: 0, unmapped: 0 },
  });
});
