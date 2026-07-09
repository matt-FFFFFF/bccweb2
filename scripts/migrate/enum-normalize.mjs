// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
const COACH_TYPES = ["None", "ClubCoach", "SeniorCoach", "Instructor", "SeniorInstructor"];
const PILOT_RATINGS = ["Club Pilot", "Pilot", "Advanced Pilot"];
const WING_CLASSES = ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"];
const ROUND_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked", "Complete", "Cancelled"];
const SCORING_TYPES = ["XC", "Manual"];

const TALLY_KEYS = ["coachType", "pilotRating", "wingClass", "roundStatus", "scoringType"];

const COACH_TYPE_ALIASES = {
  none: "None",
  clubcoach: "ClubCoach",
  club_coach: "ClubCoach",
  "club coach": "ClubCoach",
  seniorcoach: "SeniorCoach",
  senior_coach: "SeniorCoach",
  "senior coach": "SeniorCoach",
  instructor: "Instructor",
  seniorinstructor: "SeniorInstructor",
  senior_instructor: "SeniorInstructor",
  "senior instructor": "SeniorInstructor",
};

const PILOT_RATING_ALIASES = {
  clubpilot: "Club Pilot",
  club_pilot: "Club Pilot",
  cp: "Club Pilot",
  pilot: "Pilot",
  advancedpilot: "Advanced Pilot",
  advanced_pilot: "Advanced Pilot",
};

const WING_CLASS_ALIASES = {
  en_a: "EN A",
  en_b: "EN B",
  en_c: "EN C",
  en_d: "EN D",
  en_c_2_liner: "EN C 2-liner",
  enc2liner: "EN C 2-liner",
  en_c_2_liner_lower: "EN C 2-liner",
  en_d_2_liner: "EN D 2-liner",
  end2liner: "EN D 2-liner",
  en_d_2_liner_lower: "EN D 2-liner",
};

const ROUND_STATUS_ALIASES = {
  draft: "Proposed",
  proposed: "Proposed",
  submitted: "Proposed",
  active: "Confirmed",
  confirmed: "Confirmed",
  verified: "Confirmed",
  briefingcomplete: "BriefComplete",
  briefing_complete: "BriefComplete",
  brief_complete: "BriefComplete",
  "brief complete": "BriefComplete",
  briefcomplete: "BriefComplete",
  locked: "Locked",
  completed: "Complete",
  complete: "Complete",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  deleted: "Cancelled",
  // Legacy "Inactive" → null here, so callers using `normalizeRoundStatus(raw) ?? "Proposed"`
  // relabel Inactive rounds to the "Proposed" default (the round is kept, not dropped).
  inactive: null,
};

const SCORING_TYPE_ALIASES = {
  xc: "XC",
  puretrack: "XC",
  manual: "Manual",
};

export function createTally() {
  return Object.fromEntries(
    TALLY_KEYS.map((key) => [key, { rewritten: 0, passthrough: 0, unmapped: 0 }]),
  );
}

export function normalizeCoachType(raw, tally) {
  return normalizeEnum(raw, COACH_TYPES, COACH_TYPE_ALIASES, tally?.coachType);
}

export function normalizePilotRating(raw, tally) {
  return normalizeEnum(raw, PILOT_RATINGS, PILOT_RATING_ALIASES, tally?.pilotRating);
}

export function normalizeWingClass(raw, tally) {
  return normalizeEnum(raw, WING_CLASSES, WING_CLASS_ALIASES, tally?.wingClass);
}

export function normalizeRoundStatus(raw, tally) {
  return normalizeEnum(raw, ROUND_STATUSES, ROUND_STATUS_ALIASES, tally?.roundStatus);
}

export function normalizeScoringType(raw, tally) {
  return normalizeEnum(raw, SCORING_TYPES, SCORING_TYPE_ALIASES, tally?.scoringType);
}

function normalizeEnum(raw, canonicalValues, aliasTable, tallyEntry) {
  if (raw == null) return null;

  const value = String(raw).trim();
  if (value.length === 0) return null;

  const lower = value.toLowerCase();
  const canonical = canonicalValues.find((c) => c.toLowerCase() === lower);
  if (canonical != null) {
    tallyEntry && (value === canonical ? (tallyEntry.passthrough += 1) : (tallyEntry.rewritten += 1));
    return canonical;
  }

  const normalized = aliasTable[lower];
  if (normalized == null) {
    tallyEntry && (tallyEntry.unmapped += 1);
    return null;
  }

  tallyEntry && (tallyEntry.rewritten += 1);
  return normalized;
}
