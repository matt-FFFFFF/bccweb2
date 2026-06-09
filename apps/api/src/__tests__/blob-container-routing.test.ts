/**
 * Blob container routing tests — Phase 2, Step 5
 *
 * Verify that write operations route data to the correct containers:
 * - Detail records go to private container only
 * - Index records go to public container
 * - Detail records do NOT leak to public container
 */

import { describe, test, expect } from "vitest";
import {
  publicBlobExists,
  privateBlobExists,
  readPublicJson,
  readPrivateJson,
  makeUser,
  makeClub,
} from "./helpers/seed.js";
import { makeAuthRequest, invoke } from "./helpers/api.js";
import type {
  Pilot,
  PilotSummary,
  Club,
  ClubSummary,
  Site,
  SiteSummary,
} from "@bccweb/types";

// Import function modules to trigger handler registration
import "../functions/pilots.js";
import "../functions/clubs.js";
import "../functions/sites.js";

describe("Blob container routing — pilots", () => {
  test("POST /api/pilots stores detail in private, index in public, detail NOT in public", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        wingClass: "EN B",
      },
    });

    const res = await invoke("createPilot", req);
    expect(res.status).toBe(201);

    const pilot = res.jsonBody as Pilot;
    const pilotId = pilot.id;

    // Detail record should be in PRIVATE container only
    expect(await privateBlobExists(`pilots/${pilotId}.json`)).toBe(true);
    expect(await publicBlobExists(`pilots/${pilotId}.json`)).toBe(false);

    // Index should be in PUBLIC container
    const index = await readPublicJson<PilotSummary[]>("pilots.json");
    expect(index).toBeTruthy();
    expect(index!.some((p) => p.id === pilotId)).toBe(true);

    // Verify the detail record content
    const detail = await readPrivateJson<Pilot>(`pilots/${pilotId}.json`);
    expect(detail!.person.fullName).toBe("Jane Doe");
  });
});

describe("Blob container routing — clubs", () => {
  test("POST /api/clubs stores detail in private, index in public, detail NOT in public", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { name: "Skyward Club" },
    });

    const res = await invoke("createClub", req);
    expect(res.status).toBe(201);

    const club = res.jsonBody as Club;
    const clubId = club.id;

    // Detail in private only
    expect(await privateBlobExists(`clubs/${clubId}.json`)).toBe(true);
    expect(await publicBlobExists(`clubs/${clubId}.json`)).toBe(false);

    // Index in public
    const index = await readPublicJson<ClubSummary[]>("clubs.json");
    expect(index).toBeTruthy();
    expect(index!.some((c) => c.id === clubId)).toBe(true);
  });
});

describe("Blob container routing — sites", () => {
  test("POST /api/sites stores detail in private, index in public, detail NOT in public", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const club = await makeClub({ name: "Host Club" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { name: "Hilltop Launch", clubId: club.id },
    });

    const res = await invoke("createSite", req);
    expect(res.status).toBe(201);

    const site = res.jsonBody as Site;
    const siteId = site.id;

    // Detail in private only
    expect(await privateBlobExists(`sites/${siteId}.json`)).toBe(true);
    expect(await publicBlobExists(`sites/${siteId}.json`)).toBe(false);

    // Index in public
    const index = await readPublicJson<SiteSummary[]>("sites.json");
    expect(index).toBeTruthy();
    expect(index!.some((s) => s.id === siteId)).toBe(true);
  });
});
