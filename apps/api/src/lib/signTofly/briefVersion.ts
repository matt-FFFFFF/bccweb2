import { createHash } from "node:crypto";
import type { RoundBrief } from "@bccweb/types";

export const MATERIAL_BRIEF_FIELDS = [
  "briefingTime",
  "landByTime",
  "checkInByTime",
  "narrative",
  "windSpeedDirection",
  "directionOfFlight",
  "expectedLandingArea",
  "airspaceAndHazards",
  "NOTAMs",
  "BENO_LineDescription",
  "briefersNotes",
  "frequencyMhz",
  "site.parkingW3W",
  "site.briefingW3W",
  "site.takeOffW3W",
] as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function computeBriefHash(brief: RoundBrief): string {
  const material = Object.fromEntries(
    MATERIAL_BRIEF_FIELDS.map((path) => [path, getByPath(brief, path) ?? null]),
  );
  return createHash("sha256")
    .update(sortedJSONStringify(material), "utf8")
    .digest("hex");
}

export function diffMaterialFields(prev: RoundBrief, next: RoundBrief): string[] {
  return MATERIAL_BRIEF_FIELDS.filter((path) => {
    const prevValue = getByPath(prev, path) ?? null;
    const nextValue = getByPath(next, path) ?? null;
    return sortedJSONStringify(prevValue) !== sortedJSONStringify(nextValue);
  });
}

function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function sortedJSONStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, JsonValue>>((acc, key) => {
        acc[key] = sortJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return String(value);
}
