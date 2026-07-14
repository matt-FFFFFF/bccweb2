// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
// ─── Primitives & Enums ──────────────────────────────────────────────────────

export type UserRole = "Admin" | "RoundsCoord" | "Pilot";

export const COACH_TYPES = [
  "None",
  "ClubCoach",
  "SeniorCoach",
  "Instructor",
  "SeniorInstructor",
] as const;
export type CoachType = (typeof COACH_TYPES)[number];

export const COACH_TYPE_LABELS: Record<CoachType, string> = {
  None: "Not a coach",
  ClubCoach: "Club Coach",
  SeniorCoach: "Senior Coach",
  Instructor: "Instructor",
  SeniorInstructor: "Senior Instructor",
};

export const PILOT_RATINGS = [
  "Club Pilot",
  "Pilot",
  "Advanced Pilot",
] as const;
export type PilotRatingValue = (typeof PILOT_RATINGS)[number];

export const WING_CLASSES = [
  "EN A",
  "EN B",
  "EN C",
  "EN C 2-liner",
  "EN D",
  "EN D 2-liner",
] as const;
export type WingClass = (typeof WING_CLASSES)[number];

export const ROUND_STATUSES = [
  "Proposed",
  "Confirmed",
  "BriefComplete",
  "Locked",
  "Complete",
  "Cancelled",
] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export { normalizeStatus, isRosterFrozen, rosterFrozenReason } from "./status.js";
export type { FrozenRoundStatus } from "./status.js";

export const PILOT_SLOT_STATUSES = ["Empty", "Filled"] as const;
export type PilotSlotStatus = (typeof PILOT_SLOT_STATUSES)[number];

export const SCORING_TYPES = ["XC", "Manual"] as const;
export type ScoringType = (typeof SCORING_TYPES)[number];

// ─── Config ──────────────────────────────────────────────────────────────────

export interface Config {
  maxTeamsInClub: number;
  maxPilotsInTeam: number;
  /**
   * Number of ISSCORING-ELIGIBLE SLOTS in a team — how many team places may
   * carry `isScoring: true` (intended default 6). This is the eligible-slot
   * count, NOT the number of pilot scores summed into the working score.
   * Legacy: `Config.cs:15` / `Web.config:98` (`MaxScoringPilotsInTeam = 6`).
   * ⚠️ Collision guard — do NOT conflate with:
   *   • `maxPilotScoresCountedPerTeam` (4 — pilot scores summed per round), or
   *   • `leagueRoundScoresCounted` (6 — rounds counted in the season league).
   */
  maxScoringPilotsInTeam: number;
  /**
   * Number of PILOT SCORES COUNTED toward a team's working score — the team's
   * top-N pilot points are summed each round (intended default 4).
   * Legacy: `BaseController.cs:2359` (`GetWorkingTeamScore` sums the 4 highest
   * `PilotPoints`, `int topNScoresInTeam = 4`).
   * ⚠️ Collision guard — this counts PILOTS (4), distinct from:
   *   • `maxScoringPilotsInTeam` (6 — eligible scoring slots), and
   *   • `leagueRoundScoresCounted` (6 — rounds counted in the season league).
   */
  maxPilotScoresCountedPerTeam: number;
  /**
   * Number of ROUNDS COUNTED in the season league — a team's season total is
   * the sum of its best N round scores (intended default 6).
   * Legacy: `LeagueTeamSeasonViewModel.cs:27` (`numRoundsInTotal = 6`).
   * ⚠️ Collision guard — this counts ROUNDS (6), distinct from:
   *   • `maxScoringPilotsInTeam` (6 — eligible scoring slots, same number but
   *     different meaning), and
   *   • `maxPilotScoresCountedPerTeam` (4 — pilot scores summed per round).
   */
  leagueRoundScoresCounted: number;
  flightDateValidationEnabled: boolean;
  wingFactors: Record<WingClass, number>;
  /** Max points a round awards before pilot/club/distance factors (intended default 1000). */
  taskMaxPoints: number;
  /**
   * Per-pilot-rating scoring multiplier, keyed by exactly the `PilotRatingValue`
   * union. Legacy: `BaseController.cs:1661-1678` (`GetPilotFactor` — Club Pilot
   * = 1, Pilot = 1, Advanced Pilot = 0.9).
   */
  pilotFactors: Record<PilotRatingValue, number>;
  /** Round-score multiplier bucketed by the number of clubs attending the round. */
  clubsAttendingFactors: {
    fewerThanThreeClubs: number;
    exactlyThreeClubs: number;
    moreThanThreeClubs: number;
  };
  /** Round-score multiplier bucketed by the number of scoring flights in the round. */
  minDistanceFactors: {
    oneFlight: number;
    twoFlights: number;
    threeFlights: number;
    fourFlights: number;
    fiveOrMoreFlights: number;
  };
}

// ─── Users / Auth ─────────────────────────────────────────────────────────────

export interface User {
  id: string; // UUID generated at registration
  email: string;
  roles: UserRole[];
  pilotId: string | null;
  clubId: string | null;
  createdAt: string; // ISO date string
  acceptedTsCsAt?: string;
  acceptedTsCsIp?: string | null;
  acceptedTsCsVersion?: number;
  /** live access-token/session invalidation counter; distinct from auth.tokenVersion */
  sessionVersion?: number;
}

export interface AdminUserView extends User {
  emailVerified: boolean;
}

/** email → user UUID */
export type UserIndex = Record<string, string>;

export interface CallerIdentity {
  userId: string;
  email: string;
  roles: UserRole[];
  pilotId: string | null;
  clubId: string | null;
  tsCsAcceptanceRequired?: boolean;
  firstLoginOfSeason?: boolean;
  activeSeasonYear?: number;
}

// ─── Reference Entities ───────────────────────────────────────────────────────

export interface ClubRef {
  id: string;
  name: string;
}

export interface SiteRef {
  id: string;
  name: string;
  parkingW3W?: string;
  briefingW3W?: string;
  takeOffW3W?: string;
}

export interface ManufacturerRef {
  id: string;
  name: string;
  websiteUrl?: string;
}

// ─── Club ─────────────────────────────────────────────────────────────────────

export interface ClubSummary {
  id: string;
  name: string;
}

export interface Club extends ClubSummary {
  legacyId?: number;
  sites: string[]; // site uuids
  /** @deprecated Use ClubTeam entities instead */
  teams?: string[];
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// ─── Club Team ────────────────────────────────────────────────────────────────

export interface ClubTeamSummary {
  id: string;
  clubId: string;
  clubName: string;
  seasonYear: number;
  teamName: string;
}

export interface ClubTeam extends ClubTeamSummary {
  createdAt: string; // ISO date string
  legacyId?: number;
}

// ─── Site ─────────────────────────────────────────────────────────────────────

export type SiteStatus = "Active" | "Inactive";

export interface SiteSummary {
  id: string;
  name: string;
  status: SiteStatus;
  clubId: string;
}

export interface Site extends SiteSummary {
  legacyId?: number;
  parkingW3W?: string;
  briefingW3W?: string;
  takeOffW3W?: string;
  guideUrl?: string;
  contactInfo?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// ─── Manufacturer ─────────────────────────────────────────────────────────────

export interface Manufacturer {
  id: string;
  legacyId?: number;
  name: string;
  websiteUrl?: string;
}

// ─── Pilot Rating ─────────────────────────────────────────────────────────────

export interface PilotRating {
  id: string;
  description: PilotRatingValue;
  legacyId?: number;
}

// ─── Pilot Club Membership ────────────────────────────────────────────────────

export interface PilotClubMembership {
  pilotId: string;
  clubId: string;
  clubName: string;
  joinedAt?: string | null;
  leftAt?: string | null;
  source: "legacy" | "current";
  legacyId?: number;
}

// ─── Pilot ────────────────────────────────────────────────────────────────────

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phoneNumber?: string;
}

export interface PilotSeasonClub {
  seasonYear: number;
  clubId: string;
  clubName: string;
}

export interface SeasonClub {
  id: string;
  seasonYear: number;
  clubId: string;
  numTeams: number;
  acceptedTsCs: boolean;
  acceptedTsCsAt?: string;
  acceptedTsCsBy?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  legacyId?: number;
}

export interface PilotSummary {
  id: string;
  legacyId: number | null;
  name: string; // fullName for index lookups
  clubId?: string;
  rating?: PilotRatingValue;
}

/**
 * Private blob `pilot-email-index.json` in the data-private container.
 * Maps lowercase pilot email → pilotId. Used for auto-linking at registration.
 * Never written to any public container.
 */
export type PilotEmailIndex = Record<string, string>;

export interface Pilot {
  id: string;
  legacyId: number | null;
  bhpaNumber?: number;
  coachType: CoachType;
  pilotRating: PilotRatingValue;
  pureTrackId?: number;
  pureTrackLink?: string;
  helmetColour?: string;
  harnessType?: string;
  harnessColour?: string;
  emergencyContactName?: string;
  emergencyPhoneNumber?: string;
  medicalInfo?: string;
  wingClass?: WingClass;
  wingManufacturer?: ManufacturerRef;
  wingModel?: string;
  wingColours?: string;
  person: Person;
  currentClub?: ClubRef;
  profileUpdatedAt?: string;
  seasonClubs: PilotSeasonClub[];
  userId: string | null; // B2C oid, null until linked
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// ─── Season ───────────────────────────────────────────────────────────────────

export interface SeasonSummary {
  id: string;
  year: number;
  active: boolean;
}

export interface LeagueEntry {
  rank: number;
  clubId: string;
  clubName: string;
  teamName: string;
  totalScore: number;
  roundScores: Record<string, number>; // roundId → score
  countedRounds: number;
}

export interface Season extends SeasonSummary {
  rounds: string[]; // round uuids
  leagueTable: LeagueEntry[];
  legacyId?: number;
}

// ─── Round ────────────────────────────────────────────────────────────────────

export interface RoundSummary {
  id: string;
  legacyId?: number;
  date: string; // ISO date yyyy-MM-dd
  siteId: string;
  siteName: string;
  status: RoundStatus;
  seasonYear: number;
}

/** Snapshot of pilot safety/scoring data frozen at round lock time */
export interface PilotSnapshot {
  wingClass: WingClass;
  pilotRating: PilotRatingValue;
  phoneNumber?: string;
  helmetColour?: string;
  harnessType?: string;
  harnessColour?: string;
  wingManufacturer?: string;
  wingModel?: string;
  wingColours?: string;
  emergencyContactName?: string;
  emergencyPhoneNumber?: string;
  medicalInfo?: string;
}

export interface Flight {
  id: string;
  /** Raw kilometres from the IGC solver, before pilot-rating, wing-class, and normalization. */
  distance: number;
  duration?: number; // minutes
  url?: string;
  dateTime?: string; // ISO datetime
  scoringType: ScoringType;
  /** Raw float32 pilot score (distance × pilotFactor × wingFactor), PRE-normalization. */
  score: number;
  /** The wing factor applied to this flight. */
  wingFactor: number;
  isManualLog: boolean;
  manualLogJustification?: string;
  /** Blob path under data-private: flight-igcs/{roundId}/{pilotId}.igc */
  igcPath?: string;
  /** Advisory tags from IGC scoring; non-fatal warnings */
  sanityFlags?: string[];
  /** ISO datetime of last successful scoring */
  scoredAt?: string;
  /** semver of igc-xc-score package at scoring time, for rescore audit */
  scoredByVersion?: string;
  isFirstXC?: boolean;
  isFirstUKXC?: boolean;
  isUKPersonalBest?: boolean;
  isOverallPB?: boolean;
  awardedFirstXC?: boolean;
  awardedFirstUKXC?: boolean;
  awardedUKPB?: boolean;
  awardedOverallPB?: boolean;
}

export interface PilotSlot {
  placeInTeam: number;
  isScoring: boolean;
  status: PilotSlotStatus;
  accountedFor: boolean;
  signToFly: boolean;
  noScore: boolean;
  /** Normalized round points (unrounded float32). */
  pilotPoints: number;
  pilotId: string | null;
  snapshot: PilotSnapshot | null; // null until locked
  flight: Flight | null;
}

export interface Team {
  id: string;
  teamName: string;
  club: ClubRef;
  /** Normalized league points (0dp integer). */
  score: number;
  pureTrackGroupId?: number;
  pureTrackGroupSlug?: string;
  pilots: PilotSlot[];
  captainPilotId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  legacyId?: number;
}

export type BriefPdfStatus = "pending" | "processing" | "ready" | "failed";
export type PureTrackStatus = "pending" | "processing" | "ready" | "failed";

/**
 * Everything `scoreRound` derives while scoring a round — enough to re-derive
 * EVERY `Team.score` AND every `PilotSlot.pilotPoints` after the fact, even once
 * an admin has since edited the factor `Config`. W2.2's `scoreRound(round, config)`
 * returns this; W3.1 stamps it onto `Round.scoring` inside the completion lease.
 *
 * The three normalization DENOMINATORS are the audit-critical values (a stored
 * score is unexplainable without the divisor it was produced with):
 *   - `maxPilotScoreInRound` — highest raw pilot score in the round; the per-pilot
 *     divisor (`pilotPoints = maxPointsForRound × pilotScore / maxPilotScoreInRound`).
 *     Legacy: `BaseController.cs:2330` (applied at `:2336`).
 *   - `maxTeamScore` — highest working team score; the per-team divisor
 *     (`team.score = round(maxPointsForRound × workingTeamScore / maxTeamScore)`).
 *     Legacy: `BaseController.cs:2384` (`GetMaxTeamScore`, applied at `:2424`).
 *   - `maxPointsForRound` — `taskMaxPoints × clubsAttendingFactor × minDistanceFactor`.
 *     Legacy: `BaseController.cs:2465` (inside `ScoreRound`, `:2458`).
 */
export interface RoundScoringDerivation {
  /** Base points before any factor. Legacy: `BaseController.cs:2461` (`taskMaxPoints = 1000`). */
  taskMaxPoints: number;
  /** Clubs attending the round — bucket input to `clubsAttendingFactor`. */
  clubsAttendingCount: number;
  /** Clubs-attending multiplier. Legacy: `BaseController.cs:2254-2275` (`GetClubsAttendingFactor`). */
  clubsAttendingFactor: number;
  /** Flights at/over the round minimum distance — bucket input to `minDistanceFactor`. */
  minDistanceFlightCount: number;
  /** Scoring-flight-count multiplier. Legacy: `BaseController.cs:2277-2309` (`GetMinDistanceFactor`). */
  minDistanceFactor: number;
  /** `taskMaxPoints × clubsAttendingFactor × minDistanceFactor`. Legacy: `BaseController.cs:2465`. */
  maxPointsForRound: number;
  /** Per-pilot normalization denominator (highest raw pilot score). Legacy: `BaseController.cs:2330`. */
  maxPilotScoreInRound: number;
  /** Per-team normalization denominator (highest working team score). Legacy: `BaseController.cs:2384`. */
  maxTeamScore: number;
  /** Pilot scores summed into a team's working score (top-N). Legacy: `BaseController.cs:2359` (4). */
  maxPilotScoresCountedPerTeam: number;
  /** Rounds counted in the season league. Legacy: `LeagueTeamSeasonViewModel.cs:27` (6). */
  leagueRoundScoresCounted: number;
  /** Per-pilot-rating multiplier applied. Legacy: `BaseController.cs:1661-1678` (`GetPilotFactor`). */
  pilotFactors: Record<PilotRatingValue, number>;
  /** Per-wing-class multiplier applied. */
  wingFactors: Record<WingClass, number>;
  /** Per-team pre-normalization working score (sum of top-N pilot points). Legacy: `BaseController.cs:2357-2380`. */
  teams: { teamId: string; workingTeamScore: number }[];
}

/**
 * Private round-blob audit snapshot: the full scoring derivation plus the instant
 * it was taken. Persisted to the PRIVATE `rounds/{uuid}.json` blob ONLY — it
 * encodes per-team internals, so it MUST NEVER reach a public `data/` blob
 * (privacy-scan gate). Absent on rounds that have never been scored.
 */
export type RoundScoringSnapshot = RoundScoringDerivation & { scoredAt: string };

export interface Round {
  id: string;
  legacyId?: number;
  date: string; // ISO date yyyy-MM-dd
  status: RoundStatus;
  isLocked: boolean;
  maxTeams: number;
  minimumScore: number;
  pureTrackGroupId?: number;
  pureTrackGroupName?: string;
  pureTrackGroupSlug?: string;
  site: SiteRef;
  organisingClub?: ClubRef;
  season: { year: number };
  teams: Team[];
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  brief?: {
    version?: number;
    jsonPath?: string;
    pdfPath?: string;
    generatedAt?: string;
    pdfStatus?: BriefPdfStatus;
    pdfError?: string;
    pdfUpdatedAt?: string;
    pdfAttemptId?: string;
  };
  pureTrack?: {
    status?: PureTrackStatus;
    attemptId?: string;
    requestedBy?: string;
    ownerToken?: string;
    error?: string;
    updatedAt?: string;
  };
  /** Private round-blob audit snapshot of the scoring derivation (denominators
   * `maxPilotScoreInRound`, `maxTeamScore`, `maxPointsForRound` — legacy
   * `BaseController.cs:2330,2384,2465`). Private-only; absent until scored. */
  scoring?: RoundScoringSnapshot;
}

export type RescoreJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export interface RescoreJobCounts {
  rescoredCount: number;
  skippedManualCount: number;
  skippedNoIgcCount: number;
  skippedBudgetCount: number;
  errorCount: number;
}

export interface RescoreJob {
  jobId: string;
  roundId: string;
  status: RescoreJobStatus;
  requestedByEmail: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  counts?: RescoreJobCounts;
  errors?: Array<{ teamId: string; place: number; error: string }>;
  scoredByVersion?: string;
}

export interface RescoreJobMessage {
  jobId: string;
  roundId: string;
  requestedAt: string;
}

// ─── Sign-to-Fly / Audit ─────────────────────────────────────────────────────

export interface Signature {
  id: string;
  roundId: string;
  teamId: string;
  place: number;
  pilotId: string;
  userId: string;
  signedAt: string | null;
  briefVersion: number | null;
  briefHash: string | null;
  wordingVersion: number | null;
  wordingHash: string | null;
  ip: string | null;
  userAgent: string | null;
  source: "pilot-self" | "coord-override" | "legacy-migrated";
  overrideReason?: string;
  overrideBy?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  legacyId?: number;
}

export interface BriefVersion {
  version: number;
  hash: string;
  createdAt: string;
  createdBy: string;
  supersededAt?: string;
  supersededBy?: number;
}

export interface SignToFlyWording {
  version: number;
  hash: string;
  markdown: string;
  createdAt: string;
  createdBy: string;
  supersededAt?: string;
  supersededBy?: number;
}

// ─── Round Brief ──────────────────────────────────────────────────────────────

/** A pilot entry in the round brief — snapshot data + name resolved at lock time */
export interface BriefPilotEntry {
  placeInTeam: number;
  pilotId: string;
  name: string;
  bhpaNumber?: number;
  pureTrackId?: number;
  wingManufacturer?: ManufacturerRef;
  isScoring: boolean;
  snapshot: PilotSnapshot; // always set (brief generated at lock time)
}

export interface BriefTeamEntry {
  teamName: string;
  clubName: string;
  pureTrackGroupId?: number;
  pureTrackGroupSlug?: string;
  pilots: BriefPilotEntry[];
}

/** Self-contained brief document stored at round-briefs/{uuid}.json */
export interface RoundBrief {
  roundId: string;
  generatedAt: string; // ISO datetime
  date: string; // yyyy-MM-dd
  siteName: string;
  /** Current frozen material hash set when the brief is finalized. */
  hash?: string;
  guideUrl?: string;
  parkingW3W?: string;
  briefingW3W?: string;
  takeOffW3W?: string;
  briefingTime?: string;
  checkInByTime?: string;
  landByTime?: string;
  organisingClubName?: string;
  pureTrackGroupName?: string;
  pureTrackGroupSlug?: string;
  windSpeedDirection?: string;
  directionOfFlight?: string;
  expectedLandingArea?: string;
  airspaceAndHazards?: string;
  NOTAMs?: string;
  BENO_LineDescription?: string;
  briefersNotes?: string;
  frequencyMhz?: number;
  briefer?: {
    name?: string;
    bhpaCoachLevel?: CoachType;
    bhpaNumber?: string;
    phoneNumber?: string;
    emailAddress?: string;
  };
  imagePaths?: string[];
  version?: number;
  versionHistory?: BriefVersion[];
  teams: BriefTeamEntry[];
}

// ─── PureTrack ───────────────────────────────────────────────────────────────

export interface PureTrackGroup {
  id: string;
  name: string;
  slug: string;
  pilotIds: string[];
  roundId: string;
  teamId?: string;
  createdAt: string;
  createdBy?: string;
  externalId?: string;
  externalUrl?: string;
  legacyId?: number;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface RoundResult {
  roundId: string;
  date: string;
  siteName: string;
  teamResults: Array<{
    rank: number;
    teamName: string;
    clubName: string;
    score: number;
    pilots: Array<{
      pilotId: string | null;
      pilotName: string;
      distance: number;
      score: number;
      wingClass: WingClass;
    }>;
  }>;
}

/** Pre-computed results blob: results/{year}.json */
export type SeasonResults = RoundResult[];
