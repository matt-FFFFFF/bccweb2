#!/usr/bin/env node
/**
 * init-storage.mjs
 *
 * Creates required blob containers in Azurite using only Node.js built-ins.
 * Implements Azure Storage Shared Key auth (Blob service REST API).
 *
 * Usage:
 *   node scripts/init-storage.mjs
 *   BLOB_HOST=host.containers.internal node scripts/init-storage.mjs
 */

import { createHmac } from "node:crypto";
import { request } from "node:http";

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const HOST = process.env.BLOB_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.BLOB_PORT ?? "10000", 10);
// Azurite exposes the Queue service on a separate port (10001 by default).
const QUEUE_PORT = parseInt(process.env.QUEUE_PORT ?? "10001", 10);
const VERSION = "2020-10-02";

/**
 * Container definitions.
 * publicAccess: "blob" → anonymous blob reads (required for direct SPA reads)
 *               undefined → private (Functions-only access)
 */
const CONTAINERS = [
  { name: "data",         publicAccess: "blob" },
  { name: "data-private", publicAccess: undefined },  // private
];

/**
 * Storage queue definitions (Queue service, port 10001).
 * The async brief-PDF pipeline enqueues jobs onto `round-brief-pdf`; the
 * Functions host auto-parks poison messages onto `round-brief-pdf-poison`.
 * The sign-to-fly reflect pipeline enqueues reflection jobs onto
 * `signtofly-reflect`; dead-letter messages are parked onto
 * `signtofly-reflect-poison` (after maxDequeueCount=5 per host.json).
 * The async rescore pipeline enqueues jobs onto `rescore-jobs`; dead-letter
 * messages are parked onto `rescore-jobs-poison` by the Functions host.
 * Names MUST match the Terraform-provisioned queues + the API producer/consumer.
 */
const QUEUES = [
  "round-brief-pdf",
  "round-brief-pdf-poison",
  "signtofly-reflect",
  "signtofly-reflect-poison",
  "rescore-jobs",
  "rescore-jobs-poison",
];

/**
 * Queues that are created non-fatally — if the Queue service is unavailable,
 * log a warning and continue (blob containers remain the hard requirement).
 * The `rescore-jobs` pair lives here because it is a newer addition and its
 * absence during a cold Azurite start should not block blob container creation.
 */
const NON_FATAL_QUEUES = new Set(["rescore-jobs", "rescore-jobs-poison"]);

/**
 * Build a Shared Key Authorization header for an Azure Blob Storage PUT
 * that creates a container (PUT /account/container?restype=container).
 *
 * Spec: https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
 */
function sharedKeyAuth(containerName, dateUtc, publicAccess) {
  // CanonicalizedHeaders — x-ms-* headers, lowercase, sorted alphabetically.
  // x-ms-blob-public-access sorts before x-ms-date, so it must come first.
  const canonHeaders = publicAccess
    ? `x-ms-blob-public-access:${publicAccess}\nx-ms-date:${dateUtc}\nx-ms-version:${VERSION}\n`
    : `x-ms-date:${dateUtc}\nx-ms-version:${VERSION}\n`;

  // CanonicalizedResource — for path-style (Azurite), the URL path is
  // /devstoreaccount1/<container>, so the absolute path already includes the
  // account segment. The spec says: /<account-name><absolute-path-of-request-URI>
  // → /<account-name>/<account-name>/<container>
  const canonResource = `/${ACCOUNT}/${ACCOUNT}/${containerName}\nrestype:container`;

  // Full Shared Key string-to-sign (13 named headers + canonHeaders + canonResource)
  const toSign = [
    "PUT",   // VERB
    "",      // Content-Encoding
    "",      // Content-Language
    "",      // Content-Length (empty string when 0)
    "",      // Content-MD5
    "",      // Content-Type
    "",      // Date (omit — x-ms-date is used instead)
    "",      // If-Modified-Since
    "",      // If-Match
    "",      // If-None-Match
    "",      // If-Unmodified-Since
    "",      // Range
    canonHeaders + canonResource,
  ].join("\n");

  const sig = createHmac("sha256", Buffer.from(KEY, "base64"))
    .update(toSign, "utf8")
    .digest("base64");

  return `SharedKey ${ACCOUNT}:${sig}`;
}

function setContainerAcl(name, publicAccess) {
  return new Promise((resolve, reject) => {
    const dateUtc = new Date().toUTCString();
    const canonHeaders = `x-ms-blob-public-access:${publicAccess}\nx-ms-date:${dateUtc}\nx-ms-version:${VERSION}\n`;
    const canonResource = `/${ACCOUNT}/${ACCOUNT}/${name}\ncomp:acl\nrestype:container`;
    const toSign = ["PUT","","","","","","","","","","","",canonHeaders + canonResource].join("\n");
    const sig = createHmac("sha256", Buffer.from(KEY, "base64")).update(toSign, "utf8").digest("base64");
    const auth = `SharedKey ${ACCOUNT}:${sig}`;
    const opts = {
      hostname: HOST, port: PORT,
      path: `/${ACCOUNT}/${name}?restype=container&comp=acl`,
      method: "PUT",
      headers: {
        Authorization: auth,
        "x-ms-date": dateUtc,
        "x-ms-version": VERSION,
        "x-ms-blob-public-access": publicAccess,
        "Content-Length": "0",
      },
    };
    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log(`  updated: ${name} (public=${publicAccess})`);
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode} setting ACL on '${name}': ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function createContainer(name, publicAccess) {
  return new Promise((resolve, reject) => {
    const dateUtc = new Date().toUTCString();
    const auth = sharedKeyAuth(name, dateUtc, publicAccess);

    const headers = {
      Authorization: auth,
      "x-ms-date": dateUtc,
      "x-ms-version": VERSION,
      "Content-Length": "0",
    };
    if (publicAccess) {
      headers["x-ms-blob-public-access"] = publicAccess;
    }

    const opts = {
      hostname: HOST,
      port: PORT,
      path: `/${ACCOUNT}/${name}?restype=container`,
      method: "PUT",
      headers,
    };

    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 201) {
          console.log(`  created: ${name}${publicAccess ? ` (public=${publicAccess})` : ""}`);
          resolve();
        } else if (res.statusCode === 409) {
          // Container already exists — still apply public access if needed
          if (publicAccess) {
            setContainerAcl(name, publicAccess).then(resolve).catch(reject);
          } else {
            console.log(`  exists:  ${name}`);
            resolve();
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} creating '${name}': ${body}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Create a Queue in Azurite's Queue service (port 10001) using only Node
 * built-ins — mirrors createContainer but targets the Queue REST API.
 *
 * Key differences from a blob container create:
 *   - PUT /<account>/<queue> has NO `?restype=container` query param.
 *   - The Shared-Key CanonicalizedResource is therefore just
 *     /<account>/<account>/<queue> (the signing-account name PLUS the
 *     path-style account segment — the account name appears twice — and NO
 *     trailing `\nrestype:...` line).
 *   - No x-ms-blob-public-access header (queues have no anonymous-access ACL).
 *
 * Idempotent: 201 = created, 204/409 = already exists. Any other status throws.
 * Spec: https://learn.microsoft.com/en-us/rest/api/storageservices/create-queue4
 */
function createQueue(name) {
  return new Promise((resolve, reject) => {
    const dateUtc = new Date().toUTCString();

    // CanonicalizedHeaders — x-ms-* headers, lowercase, sorted alphabetically.
    const canonHeaders = `x-ms-date:${dateUtc}\nx-ms-version:${VERSION}\n`;
    // CanonicalizedResource — path-style, NO restype for queue create.
    const canonResource = `/${ACCOUNT}/${ACCOUNT}/${name}`;
    const toSign = ["PUT","","","","","","","","","","","",canonHeaders + canonResource].join("\n");
    const sig = createHmac("sha256", Buffer.from(KEY, "base64")).update(toSign, "utf8").digest("base64");
    const auth = `SharedKey ${ACCOUNT}:${sig}`;

    const opts = {
      hostname: HOST,
      port: QUEUE_PORT,
      path: `/${ACCOUNT}/${name}`,
      method: "PUT",
      headers: {
        Authorization: auth,
        "x-ms-date": dateUtc,
        "x-ms-version": VERSION,
        "Content-Length": "0",
      },
    };

    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 201) {
          console.log(`  created: ${name} (queue)`);
          resolve();
        } else if (res.statusCode === 204 || res.statusCode === 409) {
          console.log(`  exists:  ${name} (queue)`);
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode} creating queue '${name}': ${body}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Set CORS rules on the Blob service via Set Blob Service Properties.
 * This replaces the removed --blobCors CLI flag.
 * Spec: https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-service-properties
 */
function setBlobServiceCors() {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<StorageServiceProperties>
  <Cors>
    <CorsRule>
      <AllowedOrigins>http://localhost:5173</AllowedOrigins>
      <AllowedMethods>GET,HEAD,OPTIONS</AllowedMethods>
      <AllowedHeaders>*</AllowedHeaders>
      <ExposedHeaders>*</ExposedHeaders>
      <MaxAgeInSeconds>86400</MaxAgeInSeconds>
    </CorsRule>
  </Cors>
</StorageServiceProperties>`;

    const bodyBytes = Buffer.from(body, "utf8");
    const dateUtc = new Date().toUTCString();
    const contentLength = bodyBytes.length.toString();
    const contentType = "application/xml; charset=UTF-8";

    // CanonicalizedHeaders (sorted alphabetically by header name)
    const canonHeaders =
      `x-ms-date:${dateUtc}\nx-ms-version:${VERSION}\n`;

    // For path-style (Azurite): resource is /<account>/<account>/ with query params
    const canonResource =
      `/${ACCOUNT}/${ACCOUNT}/\ncomp:properties\nrestype:service`;

    const toSign = [
      "PUT",          // VERB
      "",             // Content-Encoding
      "",             // Content-Language
      contentLength,  // Content-Length
      "",             // Content-MD5
      contentType,    // Content-Type
      "",             // Date (empty — using x-ms-date)
      "",             // If-Modified-Since
      "",             // If-Match
      "",             // If-None-Match
      "",             // If-Unmodified-Since
      "",             // Range
      canonHeaders + canonResource,
    ].join("\n");

    const sig = createHmac("sha256", Buffer.from(KEY, "base64"))
      .update(toSign, "utf8")
      .digest("base64");
    const auth = `SharedKey ${ACCOUNT}:${sig}`;

    const opts = {
      hostname: HOST,
      port: PORT,
      path: `/${ACCOUNT}/?restype=service&comp=properties`,
      method: "PUT",
      headers: {
        Authorization: auth,
        "x-ms-date": dateUtc,
        "x-ms-version": VERSION,
        "Content-Type": contentType,
        "Content-Length": contentLength,
      },
    };

    const req = request(opts, (res) => {
      let resBody = "";
      res.on("data", (c) => (resBody += c));
      res.on("end", () => {
        if (res.statusCode === 202) {
          console.log("  CORS rules set on Blob service.");
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode} setting CORS: ${resBody}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyBytes);
    req.end();
  });
}

async function main() {
  console.log(`Azurite init → blob ${HOST}:${PORT}, queue ${HOST}:${QUEUE_PORT}`);
  for (const { name, publicAccess } of CONTAINERS) {
    await createContainer(name, publicAccess);
  }
  await setBlobServiceCors();
  for (const name of QUEUES) {
    if (NON_FATAL_QUEUES.has(name)) {
      try {
        await createQueue(name);
      } catch (err) {
        console.warn(`  warning: could not create queue '${name}' (non-fatal): ${err.message}`);
      }
    } else {
      await createQueue(name);
    }
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
