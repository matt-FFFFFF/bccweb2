// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
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
  // No-score is handled by the flight-removal invariant (noScore ⇒ flight === null,
  // matching legacy FlightsController.SetNoScore), NOT an explicit skip — so exclusion is
  // exactly a missing flight or wing class, matching the C# oracle (which has no noScore check).
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (!slot.flight || !slot.snapshot?.wingClass) {
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
        if (!slot.flight || !slot.snapshot?.wingClass) {
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
 * D12 DIVERGENCE: legacy (`ResultsController.cs:198-204`) also lists season-roster teams
 * with zero completed rounds; `computeLeague` intentionally lists only teams appearing in
 * ≥1 completed round. Score fidelity — not zero-round membership — is the parity claim.
 */
export function computeLeague(rounds: Round[], config: Config): LeagueEntry[] {
  const completeRounds = rounds.filter((r) => r.status === "Complete");
  const scoresByTeam = new Map<
    string,
    {
      readonly clubId: string;
      readonly clubName: string;
      readonly teamName: string;
      readonly scores: { readonly roundId: string; readonly score: number }[];
    }
  >();

  for (const round of completeRounds) {
    for (const team of round.teams) {
      const key = `${team.club.id}|${team.teamName}`;

      if (!scoresByTeam.has(key)) {
        scoresByTeam.set(key, {
          clubId: team.club.id,
          clubName: team.club.name,
          teamName: team.teamName,
          scores: [],
        });
      }

      scoresByTeam.get(key)?.scores.push({ roundId: round.id, score: team.score });
    }
  }

  const sorted = Array.from(scoresByTeam.values())
    .map((team): LeagueEntry => {
      const countedScores = team.scores
        .sort((left, right) => right.score - left.score)
        .slice(0, config.leagueRoundScoresCounted);

      return {
        rank: 0,
        clubId: team.clubId,
        clubName: team.clubName,
        teamName: team.teamName,
        totalScore: truncInt(countedScores.reduce((sum, score) => sum + score.score, 0)),
        roundScores: Object.fromEntries(
          countedScores.map((score) => [score.roundId, score.score])
        ),
        countedRounds: countedScores.length,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  sorted.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return sorted;
}
