import { createHash } from "node:crypto";
import type { RoundBrief } from "@bccweb/types";
import { MATERIAL_BRIEF_FIELDS } from "@bccweb/schemas";

// Canonical material-field list now lives in @bccweb/schemas (single source, B5);
// re-exported here so existing consumers (roundsMutate, lockRoundPreservesMaterial
// test, brief-version tests) keep importing it from this module unchanged.
export { MATERIAL_BRIEF_FIELDS };

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
    return Object.keys(value)
      .sort()
      .reduce<Record<string, JsonValue>>((acc, key) => {
        acc[key] = sortJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return value.toString();
  }
  return "";
}
