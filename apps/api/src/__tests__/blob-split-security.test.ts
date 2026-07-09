// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Blob split security tests — Phase 2, Step 4
 *
 * These are the highest-value tests in the plan. They prove:
 * 1. Public blobs in the "data" container are anonymously readable via HTTP
 * 2. Private blobs in "data-private" are NOT anonymously readable
 * 3. API endpoints serve private data to authenticated users
 * 4. API endpoints reject unauthenticated access to private data
 */

import { describe, test, expect } from "vitest";
import {
  CONNECTION_STRING,
  PUBLIC_CONTAINER,
  PRIVATE_CONTAINER,
} from "./helpers/azurite.js";
import {
  writePublicJson,
  writePrivateJson,
  makeUser,
  makeRound,
} from "./helpers/seed.js";
import { makeRequest, makeAuthRequest, invoke } from "./helpers/api.js";

// Import function modules to trigger handler registration via mocked app.http()
import "../functions/rounds.js";

// ─── Azurite blob base URL ────────────────────────────────────────────────────

// Extract blob endpoint from connection string
function getBlobEndpoint(): string {
  const match = CONNECTION_STRING.match(/BlobEndpoint=([^;]+)/);
  if (match) return match[1].replace(/\/$/, "");
  return "http://127.0.0.1:10000/devstoreaccount1";
}

const BLOB_BASE = getBlobEndpoint();
const publicBlobUrl = (path: string) =>
  `${BLOB_BASE}/${PUBLIC_CONTAINER}/${path}`;
const privateBlobUrl = (path: string) =>
  `${BLOB_BASE}/${PRIVATE_CONTAINER}/${path}`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Blob split security — public blobs are anonymously readable", () => {
  const publicFixtures: Record<string, unknown> = {
    "rounds.json": [{ id: "test", name: "Test" }],
    "pilots.json": [{ id: "test", name: "Test" }],
    "clubs.json": [{ id: "test", name: "Test" }],
    "sites.json": [{ id: "test", name: "Test" }],
    "seasons.json": [{ id: "season-2024", year: 2024, active: true }],
    "club-teams.json": [{ id: "test", name: "Test" }],
  };

  for (const [path, fixture] of Object.entries(publicFixtures)) {
    test(`GET ${path} returns 200 anonymously`, async () => {
      // Seed data in public container
      await writePublicJson(path, fixture);

      const response = await fetch(publicBlobUrl(path));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual(fixture);
    });
  }
});

describe("Blob split security — private blobs are NOT anonymously readable", () => {
  const privatePaths = [
    "rounds/test-uuid.json",
    "pilots/test-uuid.json",
    "clubs/test-uuid.json",
    "sites/test-uuid.json",
    "config.json",
    "users/test-uuid.json",
    "user-index.json",
    "auth/test-uuid.json",
    "auth/tokens/test-hash.json",
    "round-briefs/test-uuid.json",
  ];

  for (const path of privatePaths) {
    test(`GET ${path} is blocked anonymously`, async () => {
      // Seed data in private container
      await writePrivateJson(path, { id: "test", secret: "should-not-leak" });

      const response = await fetch(privateBlobUrl(path));

      // Azurite returns 404 for anonymous reads on private containers
      // (real Azure returns 404 or 409 depending on configuration)
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  }
});

describe("Blob split security — API serves private data to authenticated users", () => {
  test("GET /api/rounds/{id} with valid token returns 200", async () => {
    const { user } = await makeUser({ roles: ["Pilot"] });
    const round = await makeRound();

    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      params: { id: round.id },
    });

    const res = await invoke("getRoundById", req);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { id: string }).id).toBe(round.id);
  });

  test("GET /api/rounds/{id} for non-existent round returns 404", async () => {
    const { user } = await makeUser({ roles: ["Pilot"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      params: { id: "non-existent-uuid" },
    });

    const res = await invoke("getRoundById", req);
    expect(res.status).toBe(404);
  });
});

describe("Blob split security — API rejects unauthenticated access to private data", () => {
  test("GET /api/rounds/{id} without token returns 401", async () => {
    const round = await makeRound();

    const req = makeRequest({
      method: "GET",
      params: { id: round.id },
    });

    const res = await invoke("getRoundById", req);
    expect(res.status).toBe(401);
  });
});
