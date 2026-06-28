import type { BlobClient } from "@azure/storage-blob";
import { jsonDeepEqual } from "@bccweb/schemas";
import type * as z from "zod/v4";

import { readBlob, writeBlob, writePrivateBlob } from "./blob.js";
import { BlobShapeError } from "./http.js";

type CreateOnlyOptions = { ifNoneMatch?: "*" };
type BlobSchemaMode = "observe" | "enforce";

interface ShapeDiff {
  healedKeys: string[];
  droppedKeys: string[];
}

interface ValidationIssueSummary {
  code?: string;
  path: PropertyKey[];
}

function schemaNameFor(schema: z.ZodType<unknown>): string {
  // Prefer schema description (set via .describe('...')) for actionable telemetry;
  // constructor.name fallback produces generic names like 'ZodObject' / 'ZodPipe'.
  const description = (schema as { description?: string }).description;
  if (description && description.trim() !== "") return description;
  return schema.constructor.name;
}

function currentSchemaMode(): BlobSchemaMode {
  return process.env["BLOB_SCHEMA_MODE"] === "enforce" ? "enforce" : "observe";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonDeepEqual(a: unknown, b: unknown): boolean {
  return jsonDeepEqual(a, b);
}

function topLevelShapeDiff(raw: unknown, parsed: unknown): ShapeDiff {
  if (!isRecord(raw) || !isRecord(parsed)) {
    return { healedKeys: [], droppedKeys: [] };
  }

  const healedKeys = new Set<string>();
  const droppedKeys: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      droppedKeys.push(key);
      continue;
    }

    if (!isJsonDeepEqual(raw[key], parsed[key])) {
      healedKeys.add(key);
    }
  }

  for (const key of Object.keys(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      healedKeys.add(key);
    }
  }

  return { healedKeys: [...healedKeys], droppedKeys };
}

function logObserveValidationIssues<T>(
  path: string,
  schema: z.ZodType<T>,
  issues: ValidationIssueSummary[],
): void {
  console.warn("[blobJson] observe-mode validation issues", {
    path,
    schema: schemaNameFor(schema),
    issues: issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    })),
  });
}

function parseForWrite<T>(path: string, schema: z.ZodType<T>, data: T): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  throw new BlobShapeError(path, schemaNameFor(schema), result.error.issues);
}

function observeBeforeWrite<T>(path: string, schema: z.ZodType<T>, data: T): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    logObserveValidationIssues(path, schema, result.error.issues);
  }
}

export async function readJson<T>(
  client: BlobClient,
  schema: z.ZodType<T>,
  path: string,
): Promise<T> {
  const raw = await readBlob(client);
  const schemaName = schemaNameFor(schema);
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new BlobShapeError(path, schemaName, result.error.issues);
  }

  if (!isJsonDeepEqual(raw, result.data)) {
    const { healedKeys, droppedKeys } = topLevelShapeDiff(raw, result.data);
    const { getTelemetryClient } = await import("./telemetry.js");
    getTelemetryClient()?.trackEvent({
      name: "blob.healed",
      properties: { path, schema: schemaName, healedKeys, droppedKeys },
    });
  }

  return result.data;
}

export async function writeJson<T>(
  path: string,
  schema: z.ZodType<T>,
  data: T,
  leaseId?: string,
): Promise<void> {
  const output = currentSchemaMode() === "enforce"
    ? parseForWrite(path, schema, data)
    : data;

  if (currentSchemaMode() === "observe") {
    observeBeforeWrite(path, schema, data);
  }

  await writeBlob(path, output, leaseId);
}

export async function writePrivateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  data: T,
  leaseId?: string,
  opts?: CreateOnlyOptions,
): Promise<void> {
  const output = currentSchemaMode() === "enforce"
    ? parseForWrite(path, schema, data)
    : data;

  if (currentSchemaMode() === "observe") {
    observeBeforeWrite(path, schema, data);
  }

  await writePrivateBlob(path, output, leaseId, opts);
}
