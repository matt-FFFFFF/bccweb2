// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { scoreRound } from "@bccweb/scoring";
import type { Config, Flight, PilotSlot, Round, RoundScoringDerivation } from "@bccweb/types";

type StashedFlight = {
  readonly slot: PilotSlot;
  readonly flight: Flight;
};

export function isFlightDisqualified(flight: Flight, config: Config): boolean {
  return (
    flight.isManualLog !== true &&
    flight.validation !== undefined &&
    flight.validation.overridden !== true &&
    ((config.flightSignatureValidationEnabled && flight.validation.signature === "invalid") ||
      (config.flightDateValidationEnabled && flight.validation.date === "invalid"))
  );
}

export function scoreRoundEnforcingValidation(
  round: Round,
  config: Config,
): { round: Round; derivation: RoundScoringDerivation } {
  const stashedFlights: StashedFlight[] = [];

  for (const team of round.teams) {
    for (const slot of team.pilots) {
      const flight = slot.flight;
      if (flight !== null && isFlightDisqualified(flight, config)) {
        stashedFlights.push({ slot, flight });
        slot.flight = null;
      }
    }
  }

  try {
    return scoreRound(round, config);
  } finally {
    for (const { slot, flight } of stashedFlights) {
      flight.score = 0;
      flight.wingFactor = 0;
      slot.flight = flight;
      slot.pilotPoints = 0;
    }
  }
}
