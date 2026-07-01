import { createHash } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";

const WORDING_PATH = "sign-to-fly/wording/1.json";
const ACTIVE_PATH = "sign-to-fly/wording/active.json";

// Sign-to-Fly wording is markdown-only end to end: the SPA renders it via
// MarkdownView, and the API/PDF never render it (they only hash + reference it).
// This is the canonical v1 wording carried over from the legacy .NET app,
// transcribed from HTML into equivalent markdown.
const MARKDOWN = `By clicking **Sign to Fly**, you are confirming that you have received and understood a full brief for this round, which incorporated:

The day's expected meteorological conditions, including anticipated convection activity, convergence lines, cloud cover, and any frontal effects (including sea breeze fronts).

An understanding of any conditions which would require terminating the flight for safety reasons, made with reference to a current aeronautical chart, details of all controlled airspace or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAMs), up to a clearly defined "May not exceed" limit.

That you have received and understood a suitable briefing, made with reference to a current aeronautical chart, which addresses all controlled airspace or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAM's), up to the "Do not exceed" limit detailed in this briefing document.

> **Club Pilots**
>
> You are confirming that you are aware of the geographical limits and altitude, height or flight level limits of the airspace or hazards and that you are confident of your ability to navigate and safely avoid any such areas or hazards.
>
> In addition you are confirming that you understand that if the flight should stray outside the anticipated "cone" of the briefed track, or reach the "May not exceed" limit, your flight must be discontinued.

Are you sure you want to **Sign to Fly** in this round?
`;

const hash = createHash("sha256").update(MARKDOWN, "utf8").digest("hex");

const connectionString = process.env["BLOB_CONNECTION_STRING"];
if (!connectionString) {
  throw new Error("BLOB_CONNECTION_STRING environment variable is not set");
}

const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
const container = BlobServiceClient.fromConnectionString(connectionString)
  .getContainerClient(containerName);
await container.createIfNotExists();

const wordingClient = container.getBlockBlobClient(WORDING_PATH);
const existing = await readJsonIfExists(wordingClient);
if (existing && existing.hash === hash) {
  console.log(`skip ${WORDING_PATH}: existing hash matches ${hash}`);
} else if (existing) {
  throw new Error(`${WORDING_PATH} already exists with different hash ${existing.hash}`);
} else {
  const createdAt = new Date().toISOString();
  await uploadJson(wordingClient, {
    version: 1,
    hash,
    markdown: MARKDOWN,
    createdAt,
    createdBy: "seed-script",
  });
  console.log(`wrote ${WORDING_PATH}: ${hash}`);
}

await uploadJson(container.getBlockBlobClient(ACTIVE_PATH), { activeVersion: 1 });
console.log(`wrote ${ACTIVE_PATH}: activeVersion=1`);

async function readJsonIfExists(client) {
  try {
    const response = await client.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function uploadJson(client, data) {
  const content = JSON.stringify(data, null, 2);
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}
