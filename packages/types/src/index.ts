// ─── Primitives & Enums ──────────────────────────────────────────────────────

export type UserRole = "Admin" | "RoundsCoord" | "Pilot";

export type CoachType =
  | "None"
  | "ClubCoach"
  | "SeniorCoach"
  | "Instructor"
  | "SeniorInstructor";

export type PilotRatingValue =
  | "Club Pilot"
  | "Pilot"
  | "Advanced Pilot";

export type WingClass =
  | "EN A"
  | "EN B"
  | "EN C"
  | "EN C 2-liner"
  | "EN D"
  | "EN D 2-liner";

export type RoundStatus =
  | "Proposed"
  | "Confirmed"
  | "BriefComplete"
  | "Locked"
  | "Complete"
  | "Cancelled";

export type PilotSlotStatus = "Empty" | "Filled";

export type ScoringType = "XC" | "Manual";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface Config {
  maxTeamsInClub: number;
  maxPilotsInTeam: number;
  maxScoringPilotsInTeam: number;
  flightDateValidationEnabled: boolean;
  wingFactors: Record<WingClass, number>;
}

// ─── Users / Auth ─────────────────────────────────────────────────────────────

export interface User {
  id: string; // UUID generated at registration
  email: string;
  roles: UserRole[];
  pilotId: string | null;
  clubId: string | null;
  createdAt: string; // ISO date string
}

/** email → user UUID */
export type UserIndex = Record<string, string>;

export interface CallerIdentity {
  userId: string;
  email: string;
  roles: UserRole[];
  pilotId: string | null;
  clubId: string | null;
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
}

// ─── Manufacturer ─────────────────────────────────────────────────────────────

export interface Manufacturer {
  id: string;
  legacyId?: number;
  name: string;
}

// ─── Pilot Rating ─────────────────────────────────────────────────────────────

export interface PilotRating {
  id: string;
  description: PilotRatingValue;
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

export interface PilotSummary {
  id: string;
  legacyId?: number;
  bhpaNumber?: number;
  name: string; // fullName for index lookups
  email?: string;
  clubId?: string;
  rating?: PilotRatingValue;
  userId?: string | null; // B2C oid once linked
}

export interface Pilot {
  id: string;
  legacyId?: number;
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
  seasonClubs: PilotSeasonClub[];
  userId: string | null; // B2C oid, null until linked
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
  distance: number; // km
  duration?: number; // minutes
  url?: string;
  dateTime?: string; // ISO datetime
  scoringType: ScoringType;
  score: number;
  wingFactor: number;
  isManualLog: boolean;
  manualLogJustification?: string;
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
  pilotPoints: number;
  pilotId: string | null;
  snapshot: PilotSnapshot | null; // null until locked
  flight: Flight | null;
}

export interface Team {
  id: string;
  teamName: string;
  club: ClubRef;
  score: number;
  pureTrackGroupId?: number;
  pureTrackGroupSlug?: string;
  pilots: PilotSlot[];
}

export interface Round {
  id: string;
  legacyId?: number;
  date: string; // ISO date yyyy-MM-dd
  status: RoundStatus;
  isLocked: boolean;
  maxTeams: number;
  minimumScore: number;
  briefingTime?: string; // HH:mm
  landByTime?: string;
  checkInByTime?: string;
  narrative?: string;
  pureTrackGroupId?: number;
  pureTrackGroupName?: string;
  pureTrackGroupSlug?: string;
  site: SiteRef;
  organisingClub?: ClubRef;
  season: { year: number };
  teams: Team[];
}

// ─── Round Brief ──────────────────────────────────────────────────────────────

/** A pilot entry in the round brief — snapshot data + name resolved at lock time */
export interface BriefPilotEntry {
  placeInTeam: number;
  pilotId: string;
  name: string;
  bhpaNumber?: number;
  pureTrackId?: number;
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
  teams: BriefTeamEntry[];
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
      pilotName: string;
      distance: number;
      score: number;
      wingClass: WingClass;
    }>;
  }>;
}

/** Pre-computed results blob: results/{year}.json */
export type SeasonResults = RoundResult[];
