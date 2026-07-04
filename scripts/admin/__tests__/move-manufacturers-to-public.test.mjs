#!/usr/bin/env node
/**
 * move-manufacturers-to-public.test.mjs — `node --test`, real Azurite.
 *
 * Exercises the FULL conflict/idempotency matrix of the private→public move
 * against a REAL Azurite instance (no write-mocking). Each test provisions its
 * OWN unique container pair (`test-mfr-{pub,priv}-<rand>`) so concurrent sibling
 * tasks in the same worktree never collide; every container created during the
 * run is deleted in a single `after()` sweep.
 *
 * Prereq: Azurite up at 127.0.0.1:10000 (the repo default).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { BlobServiceClient } from "@azure/storage-blob";

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const BLOB_NAME = "manufacturers.json";
const SCRIPT = fileURLToPath(
  new URL("../move-manufacturers-to-public.mjs", import.meta.url)
);
// test file lives at <worktree>/scripts/admin/__tests__/ → up 3 = worktree root
const WORKTREE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const service = BlobServiceClient.fromConnectionString(AZURITE_DEV_CS);
const createdContainers = new Set();

function uid() {
  return randomBytes(6).toString("hex");
}

async function freshContainers() {
  const suffix = uid();
  const pub = `test-mfr-pub-${suffix}`;
  const priv = `test-mfr-priv-${suffix}`;
  await service.getContainerClient(pub).createIfNotExists();
  await service.getContainerClient(priv).createIfNotExists();
  createdContainers.add(pub);
  createdContainers.add(priv);
  return { pub, priv };
}

/** Run the script as a real subprocess so we observe REAL process exit codes. */
function runScript({ pub, priv, force = false }) {
  const args = [SCRIPT];
  if (force) args.push("--force");
  return spawnSync(process.execPath, args, {
    cwd: WORKTREE_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: AZURITE_DEV_CS,
      BLOB_CONTAINER_NAME: pub,
      BLOB_PRIVATE_CONTAINER_NAME: priv,
    },
  });
}

async function seed(containerName, name, text) {
  const client = service.getContainerClient(containerName).getBlockBlobClient(name);
  await client.upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

async function readText(containerName, name) {
  const client = service.getContainerClient(containerName).getBlobClient(name);
  try {
    const response = await client.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === "BlobNotFound") return undefined;
    throw err;
  }
}

function blobExists(containerName, name) {
  return service.getContainerClient(containerName).getBlobClient(name).exists();
}

after(async () => {
  for (const name of createdContainers) {
    await service.getContainerClient(name).deleteIfExists().catch(() => {});
  }
});

// ── (happy + idempotent) ───────────────────────────────────────────────────────
test("happy: private→public write, private deleted; re-run is no-op (idempotent)", async () => {
  const { pub, priv } = await freshContainers();
  const list = [
    { id: "m1", name: "Ozone" },
    { id: "m2", name: "Gin Gliders" },
  ];
  await seed(priv, BLOB_NAME, JSON.stringify(list, null, 2));

  assert.equal(await blobExists(pub, BLOB_NAME), false, "public should start absent");

  const r1 = runScript({ pub, priv });
  assert.equal(r1.status, 0, `run1 should exit 0\nstderr: ${r1.stderr}`);

  const publicAfter = await readText(pub, BLOB_NAME);
  assert.deepEqual(
    JSON.parse(publicAfter),
    list,
    "public should hold the 2 manufacturers"
  );
  assert.equal(
    await blobExists(priv, BLOB_NAME),
    false,
    "private copy should be deleted after verified public write"
  );

  // Re-run: private now absent → no-op success, public unchanged.
  const r2 = runScript({ pub, priv });
  assert.equal(r2.status, 0, `run2 (idempotent) should exit 0\nstderr: ${r2.stderr}`);
  assert.equal(
    await readText(pub, BLOB_NAME),
    publicAfter,
    "public must be unchanged by the idempotent re-run"
  );
});

// ── (conflict) without --force aborts; with --force overwrites ──────────────────
test("conflict: differing non-empty public aborts nonzero (both intact); --force overwrites", async () => {
  const { pub, priv } = await freshContainers();
  const privateList = [
    { id: "m1", name: "Ozone" },
    { id: "m2", name: "Gin Gliders" },
  ];
  const privateContent = JSON.stringify(privateList, null, 2);
  await seed(priv, BLOB_NAME, privateContent);

  const publicContent = JSON.stringify([{ id: "x9", name: "Some Other Maker" }], null, 2);
  await seed(pub, BLOB_NAME, publicContent);

  // WITHOUT --force → nonzero, both untouched.
  const r1 = runScript({ pub, priv, force: false });
  assert.notEqual(r1.status, 0, "conflict without --force must exit nonzero");
  assert.equal(
    await readText(pub, BLOB_NAME),
    publicContent,
    "public must be unchanged on conflict-abort"
  );
  assert.equal(
    await readText(priv, BLOB_NAME),
    privateContent,
    "private must NOT be deleted on conflict-abort"
  );

  // WITH --force → public overwritten with the private list, private deleted.
  const r2 = runScript({ pub, priv, force: true });
  assert.equal(r2.status, 0, `--force run should exit 0\nstderr: ${r2.stderr}`);
  assert.deepEqual(
    JSON.parse(await readText(pub, BLOB_NAME)),
    privateList,
    "public should be overwritten with the private list under --force"
  );
  assert.equal(
    await blobExists(priv, BLOB_NAME),
    false,
    "private should be deleted after forced public write"
  );
});

// ── (empty/absent) absent private → exit 0 no-op ───────────────────────────────
test("absent private → exit 0 no-op, public left untouched", async () => {
  const { pub, priv } = await freshContainers();
  const publicContent = JSON.stringify([{ id: "p1", name: "Pre-existing" }], null, 2);
  await seed(pub, BLOB_NAME, publicContent); // prove it is not touched

  const r = runScript({ pub, priv });
  assert.equal(r.status, 0, `absent-private should exit 0\nstderr: ${r.stderr}`);
  assert.equal(
    await readText(pub, BLOB_NAME),
    publicContent,
    "public must be untouched when there is nothing to move"
  );
});

// ── (byte-identical) public already identical → complete move (delete private) ──
test("byte-identical public → no rewrite, private removed to finish an interrupted move", async () => {
  const { pub, priv } = await freshContainers();
  const content = JSON.stringify([{ id: "m1", name: "Ozone" }], null, 2);
  await seed(priv, BLOB_NAME, content);
  await seed(pub, BLOB_NAME, content); // already equals what the script would write

  const r = runScript({ pub, priv });
  assert.equal(r.status, 0, `byte-identical should exit 0\nstderr: ${r.stderr}`);
  assert.equal(await readText(pub, BLOB_NAME), content, "public must be unchanged");
  assert.equal(
    await blobExists(priv, BLOB_NAME),
    false,
    "private must be removed to complete the move"
  );
});

// ── (public []) treated as absent → write ──────────────────────────────────────
test("public [] → treated as absent, private list written and private deleted", async () => {
  const { pub, priv } = await freshContainers();
  const list = [{ id: "m1", name: "Ozone" }];
  await seed(priv, BLOB_NAME, JSON.stringify(list, null, 2));
  await seed(pub, BLOB_NAME, "[]");

  const r = runScript({ pub, priv });
  assert.equal(r.status, 0, `public [] should exit 0\nstderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(await readText(pub, BLOB_NAME)), list);
  assert.equal(await blobExists(priv, BLOB_NAME), false);
});

// ── (validation) invalid private list → abort nonzero, both untouched ──────────
test("invalid private list → abort nonzero before any write, both blobs untouched", async () => {
  const { pub, priv } = await freshContainers();
  const bad = JSON.stringify([{ id: "", name: "Missing id" }], null, 2); // id min(1) fails
  await seed(priv, BLOB_NAME, bad);

  const r = runScript({ pub, priv });
  assert.notEqual(r.status, 0, "schema-invalid private must exit nonzero");
  assert.equal(await readText(priv, BLOB_NAME), bad, "private must be untouched on validation abort");
  assert.equal(await blobExists(pub, BLOB_NAME), false, "public must NOT be written on validation abort");
});
