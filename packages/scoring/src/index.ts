import type {
  Config,
  LeagueEntry,
  PilotRatingValue,
  Round,
  RoundScoringDerivation,
  WingClass,
} from "@bccweb/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const f32 = Math.fround;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundHalfToEven0dp(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;

  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;

  return floor % 2 === 0 ? floor : floor + 1;
}

const truncInt = Math.trunc;

function pilotFactorFor(rating: PilotRatingValue, config: Config): number {
  return f32(config.pilotFactors[rating] ?? 0);
}

function wingFactorFor(wingClass: WingClass, config: Config): number {
  // D8 heal-divergence: schema healing maps malformed stored wing classes to EN A;
  // if an unknown key still reaches scoring, legacy's factor fallback is zero.
  return f32(config.wingFactors[wingClass] ?? 0);
}

// ─── scoreRound ───────────────────────────────────────────────────────────────

/**
 * Compute pilot scores and team scores for a round, mutating the round in-place
 * and returning it. Intended to be called just before a round transitions to
 * Complete status.
 *
 * Rules:
 * - A pilot slot contributes iff it has a flight, noScore is false, and the
 *   round snapshot contains a wingClass.
 * - pilotPoints = distance × wingFactor (1 d.p.)
 * - Top `maxScoringPilotsInTeam` scoring pilots' points sum to team score.
 */
export function scoreRound(round: Round, config: Config): Round {
  for (const team of round.teams) {
    const scoringSlots: PilotSlot[] = [];

    for (const slot of team.pilots) {
      if (!slot.flight || slot.noScore || !slot.snapshot?.wingClass) {
        slot.pilotPoints = 0;
        continue;
      }

      const factor = getWingFactor(slot.snapshot.wingClass, config);
      const score = round1dp(slot.flight.distance * factor);

      slot.flight.wingFactor = factor;
      slot.flight.score = score;
      slot.pilotPoints = score;

      if (slot.isScoring) {
        scoringSlots.push(slot);
      }
    }

    // Best N scoring pilots count toward team score
    const counted = scoringSlots
      .sort((a, b) => b.pilotPoints - a.pilotPoints)
      .slice(0, config.maxScoringPilotsInTeam);

    team.score = round1dp(counted.reduce((sum, s) => sum + s.pilotPoints, 0));
  }

  return round;
}

// ─── computeLeague ────────────────────────────────────────────────────────────

/**
 * Aggregate team scores across all Complete rounds in a season and produce a
 * ranked league table. Each team's contribution is the sum of their scores
 * across all counted rounds (no "drop worst" rule is currently specified).
 */
export function computeLeague(rounds: Round[]): LeagueEntry[] {
  const completeRounds = rounds.filter((r) => r.status === "Complete");

  // Map: "clubId|teamName" → entry
  const entryMap = new Map<string, LeagueEntry>();

  for (const round of completeRounds) {
    for (const team of round.teams) {
      const key = `${team.club.id}|${team.teamName}`;

      if (!entryMap.has(key)) {
        entryMap.set(key, {
          rank: 0,
          clubId: team.club.id,
          clubName: team.club.name,
          teamName: team.teamName,
          totalScore: 0,
          roundScores: {},
          countedRounds: 0,
        });
      }

      const entry = entryMap.get(key)!;
      if (team.score > 0) {
        entry.roundScores[round.id] = team.score;
        entry.totalScore = round1dp(entry.totalScore + team.score);
        entry.countedRounds += 1;
      }
    }
  }

  // Sort descending by totalScore, then assign ranks
  const sorted = Array.from(entryMap.values()).sort(
    (a, b) => b.totalScore - a.totalScore
  );

  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].totalScore < sorted[i - 1].totalScore) {
      rank = i + 1;
    }
    sorted[i].rank = rank;
  }

  return sorted;
}
