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

export function scoreRound(
  round: Round,
  config: Config
): { round: Round; derivation: RoundScoringDerivation } {
  // BaseController.cs:2254-2275 — GetClubsAttendingFactor.
  const clubsAttendingCount = new Set(round.teams.map((team) => team.club.id)).size;
  const clubsAttendingFactor = f32(
    clubsAttendingCount < 3
      ? config.clubsAttendingFactors.fewerThanThreeClubs
      : clubsAttendingCount === 3
        ? config.clubsAttendingFactors.exactlyThreeClubs
        : config.clubsAttendingFactors.moreThanThreeClubs
  );

  // BaseController.cs:2277-2309 — GetMinDistanceFactor.
  const minDistanceFlightCount = round.teams.reduce(
    (count, team) =>
      count +
      team.pilots.filter((slot) => slot.flight && slot.flight.distance >= round.minimumScore)
        .length,
    0
  );
  const minDistanceFactor = f32(
    minDistanceFlightCount === 1
      ? config.minDistanceFactors.oneFlight
      : minDistanceFlightCount === 2
        ? config.minDistanceFactors.twoFlights
        : minDistanceFlightCount === 3
          ? config.minDistanceFactors.threeFlights
          : minDistanceFlightCount === 4
            ? config.minDistanceFactors.fourFlights
            : minDistanceFlightCount > 4
              ? config.minDistanceFactors.fiveOrMoreFlights
              : 0
  );

  // BaseController.cs:2461-2465 — ScoreRound taskMaxPoints and maxPointsForRound.
  const maxPointsForRound = f32(
    f32(config.taskMaxPoints * clubsAttendingFactor) * minDistanceFactor
  );

  const rawScores: number[] = [];

  // BaseController.cs:1619-1680 and :2311-2350 — GetPilotScore/GetPilotPoints.
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (!slot.flight || !slot.snapshot?.wingClass || slot.noScore) {
        slot.pilotPoints = 0;
        continue;
      }

      const wingFactor = wingFactorFor(slot.snapshot.wingClass, config);
      const rawScore = f32(
        f32(f32(slot.flight.distance) * pilotFactorFor(slot.snapshot.pilotRating, config)) *
          wingFactor
      );

      slot.flight.wingFactor = wingFactor;
      slot.flight.score = rawScore;
      rawScores.push(rawScore);
    }
  }

  const maxPilotScoreInRound = rawScores.reduce(
    (highest, rawScore) => Math.max(highest, rawScore),
    0
  );

  if (maxPilotScoreInRound > 0) {
    for (const team of round.teams) {
      for (const slot of team.pilots) {
        if (!slot.flight || !slot.snapshot?.wingClass || slot.noScore) {
          slot.pilotPoints = 0;
          continue;
        }

        slot.pilotPoints = f32(
          f32(maxPointsForRound * slot.flight.score) / maxPilotScoreInRound
        );
      }
    }
  } else {
    // D9 divergence: legacy divides by zero when all raw scores are zero; we keep zeros.
    for (const team of round.teams) {
      for (const slot of team.pilots) {
        slot.pilotPoints = 0;
      }
    }
  }

  const teamDerivations: RoundScoringDerivation["teams"] = [];

  // BaseController.cs:2357-2385 — GetWorkingTeamScore and GetMaxTeamScore.
  for (const team of round.teams) {
    const workingTeamScore = truncInt(
      team.pilots
        .filter(
          (slot) =>
            slot.isScoring && slot.status === "Filled" && slot.pilotPoints > 0
        )
        .sort((left, right) => right.pilotPoints - left.pilotPoints)
        .slice(0, config.maxPilotScoresCountedPerTeam)
        .reduce((sum, slot) => f32(sum + f32(slot.pilotPoints)), 0)
    );

    teamDerivations.push({ teamId: team.id, workingTeamScore });
  }

  const maxTeamScore = teamDerivations.reduce(
    (highest, team) => Math.max(highest, team.workingTeamScore),
    0
  );

  // BaseController.cs:2390-2433 — GetTeamScores.
  for (const team of round.teams) {
    const workingTeamScore =
      teamDerivations.find((teamDerivation) => teamDerivation.teamId === team.id)
        ?.workingTeamScore ?? 0;

    team.score =
      maxTeamScore > 0
        ? roundHalfToEven0dp(
            f32(f32(maxPointsForRound * workingTeamScore) / maxTeamScore)
          )
        : 0;
  }

  return {
    round,
    derivation: {
      taskMaxPoints: config.taskMaxPoints,
      clubsAttendingCount,
      clubsAttendingFactor,
      minDistanceFlightCount,
      minDistanceFactor,
      maxPointsForRound,
      maxPilotScoreInRound,
      maxTeamScore,
      maxPilotScoresCountedPerTeam: config.maxPilotScoresCountedPerTeam,
      leagueRoundScoresCounted: config.leagueRoundScoresCounted,
      pilotFactors: config.pilotFactors,
      wingFactors: config.wingFactors,
      teams: teamDerivations,
    },
  };
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
