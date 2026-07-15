#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * reconcile-orphan-igcs.test.mjs — `node --test`, real Azurite.
 *
 * Each test provisions its own private container so destructive cases remain
 * isolated. Blob metadata is adapted only where Azurite cannot create the
 * production edge being exercised (a missing or deliberately old timestamp).
 *
 * Prereq: Azurite up at 127.0.0.1:10000 (the repo default).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { BlobServiceClient } from "@azure/storage-blob";

import {
  parseArgs,
  reconcileOrphanIgcs,
} from "../reconcile-orphan-igcs.mjs";

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const SCRIPT = fileURLToPath(new URL("../reconcile-orphan-igcs.mjs", import.meta.url));
const WORKTREE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const service = BlobServiceClient.fromConnectionString(AZURITE_DEV_CS);
const createdContainers = new Set();

function uid() {
  return randomBytes(6).toString("hex");
}

async function freshContainer() {
  const name = `test-orphan-igc-${uid()}`;
  const container = service.getContainerClient(name);
  await container.createIfNotExists();
  createdContainers.add(name);
  return { container, name };
}

async function seedBlob(container, name, body = "IGC fixture") {
  const bytes = Buffer.from(body, "utf8");
  await container.getBlockBlobClient(name).upload(bytes, bytes.length);
}

async function seedRound(container, id, igcPaths) {
  const round = {
    teams: [
      {
        pilots: igcPaths.map((igcPath) => ({ flight: { igcPath } })),
      },
    ],
  };
  await seedBlob(container, `rounds/${id}.json`, JSON.stringify(round));
}

function blobExists(container, name) {
  return container.getBlobClient(name).exists();
}

function runScript(containerName, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: WORKTREE_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: AZURITE_DEV_CS,
      BLOB_PRIVATE_CONTAINER_NAME: containerName,
    },
  });
}

function adaptContainer(container, { adaptIgc = (blob) => blob, beforeRoundScan } = {}) {
  let roundScans = 0;
  return new Proxy(container, {
    get(target, property) {
      if (property === "listBlobsFlat") {
        return (options) => {
          const listed = target.listBlobsFlat(options);
          return (async function* listAdapted() {
            if (options?.prefix === "rounds/") {
              roundScans += 1;
              await beforeRoundScan?.(roundScans);
            }
            for await (const blob of listed) {
              yield options?.prefix === "flight-igcs/" ? adaptIgc(blob) : blob;
            }
          })();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

after(async () => {
  for (const name of createdContainers) {
    await service.getContainerClient(name).deleteIfExists().catch(() => {});
  }
});

test("dry-run is the default and lists an eligible orphan without deleting it", async () => {
  const { container, name } = await freshContainer();
  const orphanPath = "flight-igcs/dry-run.igc";
  await seedBlob(container, orphanPath);

  const result = runScript(name, ["--older-than-hours", "0.000000001"]);

  assert.equal(result.status, 0, `dry-run should exit 0\nstderr: ${result.stderr}`);
  assert.match(result.stdout, new RegExp(`\\[DRY-RUN\\] ${orphanPath}`));
  assert.equal(await blobExists(container, orphanPath), true);
});

test("the age cutoff protects a newer orphan and defaults to 24 hours", async () => {
  const { container } = await freshContainer();
  const oldPath = "flight-igcs/old.igc";
  const recentPath = "flight-igcs/recent.igc";
  await seedBlob(container, oldPath);
  await seedBlob(container, recentPath);
  const now = Date.now();
  const adapted = adaptContainer(container, {
    adaptIgc: (blob) => ({
      ...blob,
      properties: {
        ...blob.properties,
        lastModified: new Date(now - (blob.name === oldPath ? 49 : 47) * 60 * 60 * 1000),
      },
    }),
  });

  assert.equal(parseArgs([]).olderThanHours, 24);
  await reconcileOrphanIgcs(
    adapted,
    parseArgs(["--delete", "--older-than-hours", "48"]),
    now,
  );

  assert.equal(await blobExists(container, oldPath), false);
  assert.equal(await blobExists(container, recentPath), true);
});

test("a blob referenced by a round during the scan is protected", async () => {
  const { container } = await freshContainer();
  const path = "flight-igcs/newly-referenced.igc";
  await seedBlob(container, path);
  const now = Date.now();
  const adapted = adaptContainer(container, {
    adaptIgc: (blob) => ({
      ...blob,
      properties: { ...blob.properties, lastModified: new Date(now - 25 * 60 * 60 * 1000) },
    }),
    beforeRoundScan: async (scanNumber) => {
      if (scanNumber === 2) await seedRound(container, "race", [path]);
    },
  });

  await reconcileOrphanIgcs(adapted, parseArgs(["--delete"]), now);

  assert.equal(await blobExists(container, path), true);
});

test("a blob without lastModified metadata is protected", async () => {
  const { container } = await freshContainer();
  const path = "flight-igcs/no-last-modified.igc";
  await seedBlob(container, path);
  const adapted = adaptContainer(container, {
    adaptIgc: (blob) => ({ ...blob, properties: { ...blob.properties, lastModified: undefined } }),
  });

  await reconcileOrphanIgcs(adapted, parseArgs(["--delete"]));

  assert.equal(await blobExists(container, path), true);
});

test("delete mode removes an eligible orphan but never a referenced blob", async () => {
  const { container } = await freshContainer();
  const orphanPath = "flight-igcs/delete-me.igc";
  const referencedPath = "flight-igcs/keep-me.igc";
  await seedBlob(container, orphanPath);
  await seedBlob(container, referencedPath);
  await seedRound(container, "authoritative", [referencedPath]);
  const now = Date.now();
  const adapted = adaptContainer(container, {
    adaptIgc: (blob) => ({
      ...blob,
      properties: { ...blob.properties, lastModified: new Date(now - 25 * 60 * 60 * 1000) },
    }),
  });

  await reconcileOrphanIgcs(adapted, parseArgs(["--delete"]), now);

  assert.equal(await blobExists(container, orphanPath), false);
  assert.equal(await blobExists(container, referencedPath), true);
});

test("older-than-hours rejects non-positive and NaN values", () => {
  for (const value of ["0", "-1", "NaN"]) {
    assert.throws(
      () => parseArgs(["--older-than-hours", value]),
      /--older-than-hours must be a positive number/,
    );
  }
});
