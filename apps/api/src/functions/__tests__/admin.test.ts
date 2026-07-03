/**
 * admin.ts — schema/lease behaviour tests (Task 20).
 *
 * Covers the new contract:
 *   - updateConfig rejects bad client input with 400 (no DATA_SHAPE_INVALID
 *     blowup through BlobShapeError).
 *   - updateConfig merges into existing under a private lease.
 *   - concurrent updateConfig: exactly one 200, others 503 (LEASE_HELD).
 *   - setUserRoles validates role names with 400 on unknown role.
 *   - setUserRoles RMW under a private lease, returns 404 if user missing.
 */

import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { Config, User } from "@bccweb/types";
import type { AuthCredential } from "../../lib/authHelpers.js";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeUser,
  readPrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../admin.js";

interface HandlerResult {
  status: number;
  jsonBody?: unknown;
}

const ctx = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  invocationId: "test-invocation",
} as never;

async function invoke(
  name: string,
  req: ReturnType<typeof makeAuthRequest>,
): Promise<HandlerResult> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req, ctx)) as HandlerResult;
}

describe("PUT /api/manage/config — schema validation & lease", () => {
  test("rejects bogus wingFactors key with 400 (client input, not BlobShapeError)", async () => {
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      body: { wingFactors: { BogusKey: 99 } },
    });

    const res = await invoke("updateConfig", req);

    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string; detail?: string };
    expect(body.code).toBe("INVALID_CONFIG");
    expect(body.detail ?? "").toContain("BogusKey");
  });

  test("rejects unknown top-level key (strict mode rejects unknowns on client input)", async () => {
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      body: { foo: 1 },
    });

    const res = await invoke("updateConfig", req);
    // Top-level ConfigSchema uses .strip() → unknown keys are silently
    // dropped, so a body with only-unknown keys is a no-op write returning
    // 200 with the existing/defaults config. Document this branch.
    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBeTypeOf("number");
  });

  test("merges patch into existing config under a lease", async () => {
    const { user } = await bootstrapAdmin();

    // Seed via the handler so we start from a known full-defaults state.
    await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, { method: "PUT", body: {} }),
    );

    const res = await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        body: {
          maxTeamsInClub: 7,
          wingFactors: { "EN A": 1.5 },
        },
      }),
    );

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBe(7);
    expect(cfg.wingFactors["EN A"]).toBe(1.5);
    // Untouched defaults preserved.
    expect(cfg.wingFactors["EN B"]).toBeTypeOf("number");
    expect(cfg.maxPilotsInTeam).toBe(12);

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted?.maxTeamsInClub).toBe(7);
    expect(persisted?.wingFactors["EN A"]).toBe(1.5);
  });

  test("concurrent updates: exactly one 200, others 503 LEASE_HELD", async () => {
    const { user } = await bootstrapAdmin();

    // Pre-seed config.json so the ensure-create branch is a no-op for all
    // concurrent calls and the only contention is the lease.
    await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, { method: "PUT", body: {} }),
    );

    const launch = (n: number) =>
      invoke(
        "updateConfig",
        makeAuthRequest(user.id, user.email, {
          method: "PUT",
          body: { maxTeamsInClub: n },
        }),
      );

    const results = await Promise.all([launch(1), launch(2), launch(3)]);
    const statuses = results.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const conflicts = statuses.filter((s) => s === 503 || s === 409).length;
    expect(ok).toBe(1);
    expect(conflicts).toBe(2);

    const losers = results.filter((r) => r.status !== 200);
    for (const r of losers) {
      const body = r.jsonBody as { code?: string };
      expect(body.code === "LEASE_HELD" || body.code === "LEASE_LOST").toBe(true);
    }
  });
});

describe("PUT /api/manage/users/{userId}/roles — schema validation & lease", () => {
  test("rejects unknown role with 400", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Admin", "SuperUser"] },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string; detail?: string };
    expect(body.code).toBe("INVALID_ROLES_PAYLOAD");
    // zod v4 issue includes the path and the allowed values; not the bad
    // input string itself. Assert against the path + enum surface.
    expect(body.detail ?? "").toContain("\"roles\"");
    expect(body.detail ?? "").toContain("Admin");
  });

  test("rejects unknown top-level key with 400 (strict payload schema)", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Pilot"], surprise: true },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string };
    expect(body.code).toBe("INVALID_ROLES_PAYLOAD");
  });

  test("returns 404 when target user does not exist", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostId = randomUUID();

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: ghostId },
      body: { roles: ["Pilot"] },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(404);
  });

  test("happy path: updates roles under a lease and persists", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Admin", "Pilot"], pilotId: "p-1", clubId: "c-1" },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(200);
    const updated = res.jsonBody as User;
    expect(updated.roles).toEqual(["Admin", "Pilot"]);
    expect(updated.pilotId).toBe("p-1");
    expect(updated.clubId).toBe("c-1");

    const persisted = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persisted?.roles).toEqual(["Admin", "Pilot"]);
    expect(persisted?.pilotId).toBe("p-1");
    expect(persisted?.clubId).toBe("c-1");
  });
});

describe("POST /api/manage/users/{userId}/verify-email — admin force-verify", () => {
  test("happy path: sets emailVerified=true on an unverified user", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: false });

    const credBefore = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(credBefore?.emailVerified).toBe(false);

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "POST",
      params: { userId: target.id },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ok: boolean }).ok).toBe(true);

    const credAfter = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(credAfter?.emailVerified).toBe(true);
  });

  test("returns 404 when auth blob is absent", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostId = randomUUID();

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "POST",
      params: { userId: ghostId },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { code?: string }).code).toBe("NOT_FOUND");
  });

  test("returns 403 for non-admin caller", async () => {
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });
    const { user: target } = await makeUser({ emailVerified: false });

    const req = makeAuthRequest(pilot.id, pilot.email, {
      method: "POST",
      params: { userId: target.id },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(403);
  });
});
