import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import type { Frequency, SeasonClub } from "@bccweb/types";
import { getBlobClient, getPrivateBlobClient, readBlob, writePrivateBlob } from "../lib/blob.js";
import { forbiddenResponse, getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";

interface FrequencyBody {
  label?: string;
  position?: number;
}

let publicContainer: ContainerClient | null = null;
let privateContainer: ContainerClient | null = null;

function getPublicContainer(): ContainerClient {
  if (publicContainer) return publicContainer;
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  const containerName = process.env["BLOB_CONTAINER_NAME"] ?? "data";
  publicContainer = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  return publicContainer;
}

function getPrivateContainer(): ContainerClient {
  if (privateContainer) return privateContainer;
  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (!connectionString) throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  privateContainer = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  return privateContainer;
}

async function requireAdmin(req: HttpRequest) {
  const caller = await getCallerIdentity(req);
  if (!caller) return { response: unauthorizedResponse() };
  if (!caller.roles.includes("Admin")) return { response: forbiddenResponse() };
  return { caller };
}

async function readFrequencies(): Promise<Frequency[]> {
  try {
    return await readBlob<Frequency[]>(getPrivateBlobClient("frequencies.json"));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return [];
    throw err;
  }
}

async function writeFrequencies(frequencies: Frequency[]): Promise<void> {
  frequencies.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  await writePrivateBlob("frequencies.json", frequencies);
}

async function parseBody(req: HttpRequest): Promise<FrequencyBody> {
  try {
    return (await req.json()) as FrequencyBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }
}

function validateBody(body: FrequencyBody, existingPosition = 0): { label: string; position: number } {
  const label = body.label?.trim();
  if (!label) throw new HttpError(400, "INVALID_BODY", "label is required");
  const position = body.position ?? existingPosition;
  if (!Number.isInteger(position)) throw new HttpError(400, "INVALID_BODY", "position must be an integer");
  return { label, position };
}

async function frequencyInUse(frequencyId: string): Promise<boolean> {
  let yearIndexes: Array<{ id: string; frequencyId?: string }> = [];
  const prefix = "season-clubs/";
  for await (const item of getPublicContainer().listBlobsFlat({ prefix })) {
    if (!item.name.endsWith("/index.json")) continue;
    try {
      yearIndexes = await readBlob<Array<{ id: string; frequencyId?: string }>>(getBlobClient(item.name));
      if (yearIndexes.some((entry) => entry.frequencyId === frequencyId)) return true;
    } catch {
    }
  }

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    if (!item.name.endsWith(".json") || item.name.endsWith("index.json")) continue;
    try {
      const seasonClub = await readBlob<SeasonClub>(getPrivateBlobClient(item.name));
      if (seasonClub.frequency?.id === frequencyId) return true;
    } catch {
    }
  }
  return false;
}

async function getFrequencies(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response!;
  return { status: 200, jsonBody: await readFrequencies() };
}

async function createFrequency(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response!;
  const body = validateBody(await parseBody(req));
  const frequencies = await readFrequencies();
  const frequency: Frequency = { id: randomUUID(), ...body };
  frequencies.push(frequency);
  await writeFrequencies(frequencies);
  return { status: 201, jsonBody: frequency };
}

async function updateFrequency(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response!;
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_FREQUENCY_ID", "Missing frequency id");
  const frequencies = await readFrequencies();
  const idx = frequencies.findIndex((frequency) => frequency.id === id);
  if (idx < 0) throw new HttpError(404, "NOT_FOUND", "Frequency not found");
  const body = validateBody(await parseBody(req), frequencies[idx].position);
  const updated: Frequency = { ...frequencies[idx], ...body, id };
  frequencies[idx] = updated;
  await writeFrequencies(frequencies);
  return { status: 200, jsonBody: updated };
}

async function deleteFrequency(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response!;
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_FREQUENCY_ID", "Missing frequency id");
  if (await frequencyInUse(id)) throw new HttpError(409, "IN_USE", "Frequency is used by a season club");
  const frequencies = await readFrequencies();
  if (!frequencies.some((frequency) => frequency.id === id)) throw new HttpError(404, "NOT_FOUND", "Frequency not found");
  await writeFrequencies(frequencies.filter((frequency) => frequency.id !== id));
  return { status: 200, jsonBody: { id } };
}

app.http("getFrequencies", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/frequencies",
  handler: withErrorHandler(getFrequencies),
});

app.http("createFrequency", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/frequencies",
  handler: withErrorHandler(createFrequency),
});

app.http("updateFrequency", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/frequencies/{id}",
  handler: withErrorHandler(updateFrequency),
});

app.http("deleteFrequency", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "manage/frequencies/{id}",
  handler: withErrorHandler(deleteFrequency),
});
