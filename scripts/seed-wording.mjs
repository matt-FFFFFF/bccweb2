import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BlobServiceClient } from "@azure/storage-blob";

const LEGACY_SOURCE = "/Volumes/code/BCCWEB/BCCWeb/Views/RoundTeamPilots/SignToFly.cshtml";
const WORDING_PATH = "sign-to-fly/wording/1.json";
const ACTIVE_PATH = "sign-to-fly/wording/active.json";
const FALLBACK_HTML = `<div class="alert alert-warning">
    By clicking <strong>Sign to Fly</strong>, you are confirming that you have received and understood a full brief for this round, which incorporated:
    <br /><br />
    The day's expected meteorological conditions, including anticipated convection activity, convergence lines, cloud cover, and any frontal effects (including sea breeze fronts).
    <br /><br />
    An understanding of any conditions which would require terminating the flight for safety reasons, made with reference to a current aeronautical chart, details of all controlled airspace
    or hazards to aviation that may be encountered along the anticipated route of the flight (including NOTAMs), up to a clearly defined “May not exceed” limit.
    <br /><br />
    That you have received and understood a suitable briefing, made with reference to a current aeronautical chart, which addresses all controlled airspace or hazards to aviation that may be encountered along the anticipated
    route of the flight (including NOTAM’s), up to the “Do not exceed” limit detailed in this briefing document.
    <br /><br />
          <div class="alert alert-danger">
              <b>Club Pilots</b><br />
              You are confirming that you are aware of the geographical limits and altitude, height or flight level limits of the airspace or hazards and that you are confident of your ability to navigate and safely avoid any such areas or hazards.
              <br /><br />
              In addition you are confirming that you understand that if the flight should stray outside the anticipated “cone" of the briefed track, or reach the “May not exceed” limit, your flight must be discontinued.
          </div>
    Are you sure you want to <strong>Sign to Fly</strong> in this round?
</div>`;

const html = await readLegacyHtml();
const hash = createHash("sha256").update(html, "utf8").digest("hex");
const plainText = htmlToPlainText(html);

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
    html,
    plainText,
    createdAt,
    createdBy: "seed-script",
  });
  console.log(`wrote ${WORDING_PATH}: ${hash}`);
}

await uploadJson(container.getBlockBlobClient(ACTIVE_PATH), { activeVersion: 1 });
console.log(`wrote ${ACTIVE_PATH}: activeVersion=1`);

async function readLegacyHtml() {
  try {
    const source = await readFile(LEGACY_SOURCE, "utf8");
    return source.split(/\r?\n/).slice(7, 26).join("\n");
  } catch {
    return FALLBACK_HTML;
  }
}

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

const HTML_ENTITIES = Object.freeze({
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
});

function htmlToPlainText(input) {
  let text = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p)>/gi, "\n");

  // Strip tags repeatedly until the string stops changing. A single pass can
  // leave a residual `<tag` behind when markup is nested/crafted (e.g.
  // `<scr<script>ipt>`), so loop until stable.
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);

  // Decode entities in ONE pass via a lookup map. Doing this sequentially
  // (e.g. `&amp;` → `&` then `&lt;` → `<`) would double-unescape `&amp;lt;`
  // into `<`; a single combined pass leaves it as the literal `&lt;`.
  text = text.replace(/&(?:nbsp|amp|lt|gt);/g, (entity) => HTML_ENTITIES[entity]);

  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
