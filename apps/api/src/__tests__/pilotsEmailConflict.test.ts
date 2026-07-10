// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Pilot, PilotSummary } from "@bccweb/types";

const blobJsonControl = vi.hoisted(() => ({ failPilotWrite: false }));

vi.mock("../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(
      (...args: Parameters<typeof actual.writePrivateJson>) => {
        const [path] = args;
        if (blobJsonControl.failPilotWrite && path.startsWith("pilots/")) {
          return Promise.reject(new Error("simulated pilot write failure"));
        }
        return actual.writePrivateJson(...args);
      },
    ),
  };
});

import { makeAuthRequest, invoke } from "./helpers/api.js";
import { getPrivateContainer } from "./helpers/azurite.js";
import {
  bootstrapAdmin,
  makePilot,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
} from "./helpers/seed.js";

import "../functions/pilots.js";

async function listPrivatePilotBlobNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const blob of getPrivateContainer().listBlobsFlat({ prefix: "pilots/" })) {
    names.push(blob.name);
  }
  return names;
}

describe("pilot email conflict handling", () => {
  afterEach(() => {
    blobJsonControl.failPilotWrite = false;
  });

  test("createPilot conflict leaves no orphan when email is already claimed", async () => {
    // Given: a foreign pilot owns the lower-cased email claim, with no pilot blobs yet.
    const { user: admin } = await bootstrapAdmin();
    const email = `taken-${randomUUID()}@example.com`;
    const ownerId = randomUUID();
    await writePrivateJson("pilot-email-index.json", { [email.toLowerCase()]: ownerId });

    // When: an admin attempts to create a new pilot with that claimed email.
    const res = await invoke(
      "createPilot",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { firstName: "Conflict", lastName: "Create", email },
      }),
    );

    // Then: the conflict is reported and no private/public pilot side effects were written.
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "PILOT_EMAIL_TAKEN" });
    expect(await listPrivatePilotBlobNames()).toHaveLength(0);
    expect(await readPublicJson<PilotSummary[]>("pilots.json")).toBeNull();
    expect(await readPrivateJson<Record<string, string>>("pilot-email-index.json")).toEqual({
      [email.toLowerCase()]: ownerId,
    });
  });

  test("updatePilot conflict leaves existing private and public pilot records unchanged", async () => {
    // Given: a target pilot exists without an email claim, and a foreign owner claims the email.
    const { user: admin } = await bootstrapAdmin();
    const target = await makePilot({ firstName: "P", lastName: "Two" });
    const beforePrivate = await readPrivateJson<Pilot>(`pilots/${target.id}.json`);
    const beforePublic = await readPublicJson<PilotSummary[]>("pilots.json");
    const email = `foreign-${randomUUID()}@example.com`;
    const ownerId = randomUUID();
    await writePrivateJson("pilot-email-index.json", { [email.toLowerCase()]: ownerId });

    // When: an admin attempts to update the target with the foreign-owned email.
    const res = await invoke(
      "updatePilot",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { id: target.id },
        body: { email, firstName: "Changed" },
      }),
    );

    // Then: the conflict is reported and neither the private blob nor public index changed.
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "PILOT_EMAIL_TAKEN" });
    expect(await readPrivateJson<Pilot>(`pilots/${target.id}.json`)).toEqual(beforePrivate);
    expect((await readPrivateJson<Pilot>(`pilots/${target.id}.json`))?.person.firstName).toBe("P");
    expect(await readPublicJson<PilotSummary[]>("pilots.json")).toEqual(beforePublic);
    expect(await readPrivateJson<Record<string, string>>("pilot-email-index.json")).toEqual({
      [email.toLowerCase()]: ownerId,
    });
  });

  test("createPilot happy path writes private blob, public summary, and email claim", async () => {
    // Given: an admin and an unused email address.
    const { user: admin } = await bootstrapAdmin();
    const email = `fresh-${randomUUID()}@example.com`;

    // When: the admin creates a pilot with that email.
    const res = await invoke(
      "createPilot",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { firstName: "Happy", lastName: "Pilot", email },
      }),
    );

    // Then: all expected records are durable and linked to the new pilot id.
    expect(res.status).toBe(201);
    const pilot = res.jsonBody as Pilot;
    expect(await readPrivateJson<Pilot>(`pilots/${pilot.id}.json`)).toMatchObject({
      id: pilot.id,
      person: { fullName: "Happy Pilot" },
    });
    expect(await readPublicJson<PilotSummary[]>("pilots.json")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pilot.id, name: "Happy Pilot" })]),
    );
    expect(await readPrivateJson<Record<string, string>>("pilot-email-index.json")).toMatchObject({
      [email.toLowerCase()]: pilot.id,
    });
  });

  test("updatePilot releases a newly acquired email claim when the pilot write fails", async () => {
    // Given: an existing pilot and an admin updating it with a fresh unused email.
    const { user: admin } = await bootstrapAdmin();
    const target = await makePilot({ firstName: "New", lastName: "Claim" });
    const email = `new-claim-${randomUUID()}@example.com`;

    // When: the post-claim private pilot write fails.
    blobJsonControl.failPilotWrite = true;
    const res = await invoke(
      "updatePilot",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { id: target.id },
        body: { email, firstName: "Changed" },
      }),
    );

    // Then: the request fails and the newly acquired claim is rolled back.
    expect(res.status).toBe(500);
    const emailIndex = await readPrivateJson<Record<string, string>>("pilot-email-index.json");
    expect(emailIndex?.[email.toLowerCase()]).toBeUndefined();
  });

  test("updatePilot keeps a pilot's existing email claim when a re-claim write fails", async () => {
    // Given: a pilot already owns its email claim.
    const { user: admin } = await bootstrapAdmin();
    const email = `existing-claim-${randomUUID()}@example.com`;
    const target = await makePilot({ firstName: "Existing", lastName: "Claim", email });

    // When: the admin re-submits that same email and the post-claim pilot write fails.
    blobJsonControl.failPilotWrite = true;
    const res = await invoke(
      "updatePilot",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { id: target.id },
        body: { email, firstName: "Changed" },
      }),
    );

    // Then: the request fails but the pre-existing legitimate claim remains.
    expect(res.status).toBe(500);
    const emailIndex = await readPrivateJson<Record<string, string>>("pilot-email-index.json");
    expect(emailIndex?.[email.toLowerCase()]).toBe(target.id);
  });
});
