// SPDX-License-Identifier: MPL-2.0
import type { IGCFile } from "igc-parser";

const SANITY_THRESHOLDS = {
  maxGroundSpeedKmh: 400,
  maxAltitudeMeters: 9_000,
  maxVerticalSpeedMetersPerSecond: 30,
  maxMedianFixIntervalSeconds: 10,
  dateToleranceDays: 1,
  earthRadiusKilometers: 6_371,
  millisecondsPerHour: 3_600_000,
  millisecondsPerSecond: 1_000,
  millisecondsPerDay: 86_400_000,
} as const;

export type SanityFlag =
  | "GPS_SPIKE"
  | "ALTITUDE_ANOMALY"
  | "NON_MONOTONIC_TIMESTAMPS"
  | "LOW_FIX_RATE"
  | "IGC_DATE_MISMATCH"
  | "IGC_PILOT_MISMATCH"
  | "NO_SCORING_SOLUTION"
  | "SOLVER_TIMEOUT";

export interface SanityCheckInput {
  flight: IGCFile;
  expectedDate: string;
  expectedPilotName?: string;
}

type Fix = IGCFile["fixes"][number];

const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;

function haversineKilometers(left: Fix, right: Fix): number {
  const deltaLatitude = degreesToRadians(right.latitude - left.latitude);
  const deltaLongitude = degreesToRadians(right.longitude - left.longitude);
  const leftLatitude = degreesToRadians(left.latitude);
  const rightLatitude = degreesToRadians(right.latitude);

  const chord =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(deltaLongitude / 2) ** 2;

  return (
    SANITY_THRESHOLDS.earthRadiusKilometers *
    2 *
    Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord))
  );
}

function hasGpsSpike(fixes: readonly Fix[]): boolean {
  for (let index = 1; index < fixes.length; index += 1) {
    const previous = fixes[index - 1];
    const current = fixes[index];

    if (!previous || !current) {
      continue;
    }

    const elapsedMilliseconds = current.timestamp - previous.timestamp;
    if (elapsedMilliseconds <= 0) {
      continue;
    }

    const groundSpeedKmh =
      haversineKilometers(previous, current) /
      (elapsedMilliseconds / SANITY_THRESHOLDS.millisecondsPerHour);

    if (groundSpeedKmh > SANITY_THRESHOLDS.maxGroundSpeedKmh) {
      return true;
    }
  }

  return false;
}

function hasAltitudeAnomaly(fixes: readonly Fix[]): boolean {
  for (const fix of fixes) {
    const { gpsAltitude, pressureAltitude } = fix;
    if (
      (gpsAltitude !== null && gpsAltitude > SANITY_THRESHOLDS.maxAltitudeMeters) ||
      (pressureAltitude !== null && pressureAltitude > SANITY_THRESHOLDS.maxAltitudeMeters)
    ) {
      return true;
    }
  }

  for (let index = 1; index < fixes.length; index += 1) {
    const previous = fixes[index - 1];
    const current = fixes[index];

    if (!previous || !current) {
      continue;
    }

    const elapsedSeconds =
      (current.timestamp - previous.timestamp) / SANITY_THRESHOLDS.millisecondsPerSecond;
    if (elapsedSeconds <= 0) {
      continue;
    }

    if (
      previous.gpsAltitude !== null &&
      current.gpsAltitude !== null &&
      Math.abs(current.gpsAltitude - previous.gpsAltitude) / elapsedSeconds >
        SANITY_THRESHOLDS.maxVerticalSpeedMetersPerSecond
    ) {
      return true;
    }

    if (
      previous.pressureAltitude !== null &&
      current.pressureAltitude !== null &&
      Math.abs(current.pressureAltitude - previous.pressureAltitude) / elapsedSeconds >
        SANITY_THRESHOLDS.maxVerticalSpeedMetersPerSecond
    ) {
      return true;
    }
  }

  return false;
}

function hasNonMonotonicTimestamps(fixes: readonly Fix[]): boolean {
  for (let index = 1; index < fixes.length; index += 1) {
    const previous = fixes[index - 1];
    const current = fixes[index];

    if (previous && current && current.timestamp <= previous.timestamp) {
      return true;
    }
  }

  return false;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const midpointValue = sorted[midpoint];

  if (midpointValue === undefined) {
    return null;
  }

  if (sorted.length % 2 === 1) {
    return midpointValue;
  }

  const beforeMidpointValue = sorted[midpoint - 1];
  return beforeMidpointValue === undefined ? null : (beforeMidpointValue + midpointValue) / 2;
}

function hasLowFixRate(fixes: readonly Fix[]): boolean {
  const intervalsSeconds: number[] = [];

  for (let index = 1; index < fixes.length; index += 1) {
    const previous = fixes[index - 1];
    const current = fixes[index];

    if (!previous || !current) {
      continue;
    }

    intervalsSeconds.push(
      (current.timestamp - previous.timestamp) / SANITY_THRESHOLDS.millisecondsPerSecond
    );
  }

  const medianInterval = median(intervalsSeconds);
  return (
    medianInterval !== null && medianInterval > SANITY_THRESHOLDS.maxMedianFixIntervalSeconds
  );
}

function parseUtcDateMilliseconds(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function hasDateMismatch(flightDate: string, expectedDate: string): boolean {
  const flightTime = parseUtcDateMilliseconds(flightDate);
  const expectedTime = parseUtcDateMilliseconds(expectedDate);

  if (!Number.isFinite(flightTime) || !Number.isFinite(expectedTime)) {
    return flightDate !== expectedDate;
  }

  const deltaDays = Math.abs(flightTime - expectedTime) / SANITY_THRESHOLDS.millisecondsPerDay;
  return deltaDays > SANITY_THRESHOLDS.dateToleranceDays;
}

function normalizePilotName(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLocaleLowerCase();
}

function hasPilotMismatch(flightPilot: string | null, expectedPilotName: string | undefined): boolean {
  if (flightPilot === null || expectedPilotName === undefined) {
    return false;
  }

  return normalizePilotName(flightPilot) !== normalizePilotName(expectedPilotName);
}

export function runSanityChecks(input: SanityCheckInput): SanityFlag[] {
  const flags = new Set<SanityFlag>();
  const { flight, expectedDate, expectedPilotName } = input;

  if (hasGpsSpike(flight.fixes)) {
    flags.add("GPS_SPIKE");
  }

  if (hasAltitudeAnomaly(flight.fixes)) {
    flags.add("ALTITUDE_ANOMALY");
  }

  if (hasNonMonotonicTimestamps(flight.fixes)) {
    flags.add("NON_MONOTONIC_TIMESTAMPS");
  }

  if (hasLowFixRate(flight.fixes)) {
    flags.add("LOW_FIX_RATE");
  }

  if (hasDateMismatch(flight.date, expectedDate)) {
    flags.add("IGC_DATE_MISMATCH");
  }

  if (hasPilotMismatch(flight.pilot, expectedPilotName)) {
    flags.add("IGC_PILOT_MISMATCH");
  }

  return [...flags];
}
