import { randomUUID } from "node:crypto";
import type { Config } from "@bccweb/types";
import { ConfigSchema } from "../../../../../packages/schemas/src/config.js";
import type * as z from "zod/v4";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getPrivateContainer,
  getPublicContainer,
} from "../../__tests__/helpers/azurite.js";
import { BlobShapeError, withErrorHandler } from "../http.js";
import {
  getPrivateBlobClient,
  getBlobClient,
  readBlob,
  writePrivateBlob,
} from "../blob.js";
import { readJson, writeJson, writePrivateJson } from "../blobJson.js";

const telemetry = vi.hoisted(() => {
  const events: unknown[] = [];
  return {
    events,
    client: {
      trackEvent: vi.fn((event: unknown) => events.push(event)),
    },
  };
});

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => telemetry.client),
}));

const defaultWingFactors = {
  "EN A": 1.0,
  "EN B": 0.9,
  "EN C": 0.8,
  "EN C 2-liner": 0.7,
  "EN D": 0.6,
  "EN D 2-liner": 0.5,
} satisfies Config["wingFactors"];

function validConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxTeamsInClub: 2,
    maxPilotsInTeam: 12,
    maxScoringPilotsInTeam: 6,
    flightDateValidationEnabled: true,
    wingFactors: defaultWingFactors,
    ...overrides,
  };
}

function withExtraKey<T extends object>(value: T, key: string, extra: unknown): T {
  return { ...value, [key]: extra } as T;
}

async function rawBlobText(path: string): Promise<string> {
  const response = await getPrivateContainer().getBlobClient(path).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("blobJson", () => {
  const originalMode = process.env["BLOB_SCHEMA_MODE"];

  beforeEach(() => {
    telemetry.events.length = 0;
    telemetry.client.trackEvent.mockClear();
    delete process.env["BLOB_SCHEMA_MODE"];
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env["BLOB_SCHEMA_MODE"];
    } else {
      process.env["BLOB_SCHEMA_MODE"] = originalMode;
    }
    vi.restoreAllMocks();
  });

  test("observe mode is default and writes caller data unchanged", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = withExtraKey(validConfig(), "junkKey", "kept");

    await writePrivateJson(path, ConfigSchema, input);

    expect(await rawBlobText(path)).toBe(JSON.stringify(input, null, 2));
    await expect(readBlob(getPrivateBlobClient(path))).resolves.toMatchObject({
      junkKey: "kept",
    });
  });

  test("observe mode logs invalid write issues but still writes caller data", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = { ...validConfig(), wingFactors: null } as unknown as Config;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await writePrivateJson(path, ConfigSchema, input);

    expect(warn).toHaveBeenCalledWith(
      "[blobJson] observe-mode validation issues",
      expect.objectContaining({ path, schema: ConfigSchema.constructor.name }),
    );
    expect(await rawBlobText(path)).toBe(JSON.stringify(input, null, 2));
  });

  test("observe mode read heals in memory and emits key-only telemetry", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = withExtraKey(validConfig(), "junkKey", "kept");
    await writePrivateBlob(path, input);

    const parsed = await readJson(getPrivateBlobClient(path), ConfigSchema, path);

    expect(parsed).toEqual(validConfig());
    expect(parsed).not.toHaveProperty("junkKey");
    expect(telemetry.client.trackEvent).toHaveBeenCalledOnce();
    expect(telemetry.events).toEqual([
      {
        name: "blob.healed",
        properties: {
          path,
          schema: ConfigSchema.constructor.name,
          healedKeys: [],
          droppedKeys: ["junkKey"],
        },
      },
    ]);
  });

  test("enforce mode strips unknown keys and persists clean shape", async () => {
    process.env["BLOB_SCHEMA_MODE"] = "enforce";
    const path = `blob-json/${randomUUID()}.json`;
    const input = withExtraKey(validConfig(), "junkKey", "stripped");

    await writePrivateJson(path, ConfigSchema, input);

    await expect(readBlob(getPrivateBlobClient(path))).resolves.toEqual(validConfig());
    expect(await rawBlobText(path)).toBe(JSON.stringify(validConfig(), null, 2));
  });

  test("enforce mode applies schema defaults before writing", async () => {
    process.env["BLOB_SCHEMA_MODE"] = "enforce";
    const path = `blob-json/${randomUUID()}.json`;

    await writePrivateJson(path, ConfigSchema, {} as Config);

    await expect(readBlob(getPrivateBlobClient(path))).resolves.toEqual(validConfig());
  });

  test("readJson throws BlobShapeError with path schemaName and issues", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    await writePrivateBlob(path, { ...validConfig(), wingFactors: null });

    await expect(readJson(getPrivateBlobClient(path), ConfigSchema, path)).rejects.toMatchObject({
      name: "BlobShapeError",
      path,
      schemaName: ConfigSchema.constructor.name,
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_type" })]),
    });
  });

  test("BlobShapeError issues stay out of user-facing error response", async () => {
    const issue: z.ZodIssue = {
      code: "custom",
      path: ["secretField"],
      message: "contains sensitive value",
    };
    const handler = withErrorHandler(async () => {
      throw new BlobShapeError("private/config.json", "ZodObject", [issue]);
    });

    const response = await handler({} as never, {
      invocationId: "invocation-1",
      error: vi.fn(),
    } as never);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: "DATA_SHAPE_INVALID",
      path: "private/config.json",
      schema: "ZodObject",
    });
  });

  test("readJson never writes healed data back to storage", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = withExtraKey(validConfig(), "junkKey", "kept");
    await writePrivateBlob(path, input);
    const client = getPrivateBlobClient(path);
    const before = await client.getProperties();

    await readJson(client, ConfigSchema, path);

    const after = await client.getProperties();
    expect(after.etag).toBe(before.etag);
    expect(await readBlob(client)).toEqual(input);
  });

  test("readJson leaves invalid blob unchanged when parsing fails", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = { ...validConfig(), wingFactors: null };
    await writePrivateBlob(path, input);
    const client = getPrivateBlobClient(path);
    const before = await client.getProperties();

    await expect(readJson(client, ConfigSchema, path)).rejects.toBeInstanceOf(BlobShapeError);

    const after = await client.getProperties();
    expect(after.etag).toBe(before.etag);
    expect(await readBlob(client)).toEqual(input);
  });

  test("readJson emits no telemetry when parsed output is structurally equal", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = validConfig();
    await writePrivateBlob(path, input);

    await expect(readJson(getPrivateBlobClient(path), ConfigSchema, path)).resolves.toEqual(input);

    expect(telemetry.client.trackEvent).not.toHaveBeenCalled();
    expect(telemetry.events).toEqual([]);
  });

  test("writeJson observe mode accepts public-container writes", async () => {
    const path = `blob-json/${randomUUID()}.json`;
    const input = withExtraKey(validConfig(), "junkKey", "kept");

    await writeJson(path, ConfigSchema, input);

    await expect(readBlob(getBlobClient(path))).resolves.toEqual(input);
    expect(await getPublicContainer().getBlobClient(path).exists()).toBe(true);
  });
});
