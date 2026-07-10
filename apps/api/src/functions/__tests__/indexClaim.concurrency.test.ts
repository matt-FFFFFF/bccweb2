// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Pilot, PilotEmailIndex, User } from "@bccweb/types";
import { describe, expect, test, vi } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  bootstrapAdmin,
  makePilot,
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { getOrCreateUser } from "../../lib/auth.js";
import { lookupUserByEmail } from "../../lib/authHelpers.js";
import "../admin.js";
import "../authFunctions.js";
import "../meProfile.js";

vi.mock("../../lib/authHelpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/authHelpers.js")>();
  return {
    ...actual,
    lookupUserByEmail: vi.fn(actual.lookupUserByEmail),
  };
});

interface HandlerResult {
  readonly status: number;
  readonly jsonBody?: unknown;
}

const REGISTER_ACCEPTED_RESPONSE = {
  status: "accepted",
  message:
    "If this email is not yet registered, you will receive a verification link shortly.",
} as const;

const ctx = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  invocationId: "test-invocation",
} as never;

async function invoke(
  name: string,
  req: ReturnType<typeof makeRequest>,
): Promise<HandlerResult> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req, ctx)) as HandlerResult;
}

async function listPrivateBlobNames(prefix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const blob of getPrivateContainer().listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  return names.sort();
}

async function listAccountBlobNames(prefix: "auth/" | "users/"): Promise<string[]> {
  const names = await listPrivateBlobNames(prefix);
  return names.filter((name) => new RegExp(`^${prefix}[^/]+\\.json$`).test(name));
}

function expectSingleOwner(
  index: Record<string, string> | null,
  email: string,
  ownerId: string,
): void {
  const key = email.toLowerCase();
  expect(index?.[key]).toBe(ownerId);
  expect(Object.keys(index ?? {}).filter((indexKey) => indexKey === key)).toHaveLength(1);
}

async function updateUserEmail(admin: User, target: User, email: string): Promise<HandlerResult> {
  return invoke(
    "updateUserEmail",
    makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { email },
    }),
  );
}

async function createMyPilot(user: User, tokenEmail: string): Promise<HandlerResult> {
  return invoke(
    "createMyPilot",
    makeAuthRequest(user.id, tokenEmail, {
      method: "POST",
      body: {
        firstName: "Race",
        lastName: "Loser",
      },
    }),
  );
}

describe("admin account mutation vs pre-existing index writers", () => {
  test("user-index admin-first: register loser returns fixed 202, GCs orphans, and swallow returns bare identity", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: owner } = await makeUser({ emailVerified: true });
    const email = `user-admin-first-${randomUUID()}@example.com`;

    const adminResult = await updateUserEmail(admin, owner, email);
    expect(adminResult.status).toBe(200);

    const usersBeforeRegister = await listAccountBlobNames("users/");
    const authBeforeRegister = await listAccountBlobNames("auth/");
    vi.mocked(lookupUserByEmail).mockResolvedValueOnce(null);

    const registerResult = await invoke(
      "authRegister",
      makeRequest({
        method: "POST",
        body: {
          email,
          password: "TestPass123!",
          acceptTsCs: true,
          acceptedTsCsVersion: 1,
        },
      }),
    );

    expect(registerResult.status).toBe(202);
    expect(registerResult.jsonBody).toEqual(REGISTER_ACCEPTED_RESPONSE);
    await expect(listAccountBlobNames("users/")).resolves.toEqual(usersBeforeRegister);
    await expect(listAccountBlobNames("auth/")).resolves.toEqual(authBeforeRegister);
    expectSingleOwner(await readPrivateJson<Record<string, string>>("user-index.json"), email, owner.id);

    const bareUserId = randomUUID();
    const foreignPilotId = randomUUID();
    await writePrivateJson<PilotEmailIndex>("pilot-email-index.json", {
      [email.toLowerCase()]: foreignPilotId,
    });
    await writePrivateJson<Partial<Pilot>>(`pilots/${foreignPilotId}.json`, {
      id: foreignPilotId,
      currentClub: { id: "foreign-club", name: "Foreign Club" },
    });

    const bare = await getOrCreateUser(bareUserId, email, { onIndexConflict: "swallow" });

    expect(bare).toMatchObject({
      id: bareUserId,
      roles: [],
      pilotId: null,
      clubId: null,
    });
    expect(await privateBlobExists(`users/${bareUserId}.json`)).toBe(false);
    expectSingleOwner(await readPrivateJson<Record<string, string>>("user-index.json"), email, owner.id);
  });

  test("user-index writer-first: getOrCreateUser claim makes admin updateUserEmail the EMAIL_TAKEN loser", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });
    const writerUserId = randomUUID();
    const email = `user-writer-first-${randomUUID()}@example.com`;

    const writer = await getOrCreateUser(writerUserId, email);
    expect(writer.id).toBe(writerUserId);

    const adminResult = await updateUserEmail(admin, target, email);

    expect(adminResult.status).toBe(409);
    expect((adminResult.jsonBody as { code?: string }).code).toBe("EMAIL_TAKEN");
    expectSingleOwner(await readPrivateJson<Record<string, string>>("user-index.json"), email, writerUserId);
  });

  test("pilot-index admin-first: createMyPilot loses with PILOT_EMAIL_TAKEN and leaves one owner", async () => {
    const { user: admin } = await bootstrapAdmin();
    const oldEmail = `pilot-admin-old-${randomUUID()}@example.com`;
    const email = `pilot-admin-first-${randomUUID()}@example.com`;
    const pilot = await makePilot({ email: oldEmail });
    const { user: owner } = await makeUser({ email: oldEmail, emailVerified: true });
    expect(owner.pilotId).toBe(pilot.id);

    const adminResult = await updateUserEmail(admin, owner, email);
    expect(adminResult.status).toBe(200);

    const { user: writer } = await makeUser({ emailVerified: true, roles: [], pilotId: null });
    const writerResult = await createMyPilot(writer, email);

    expect(writerResult.status).toBe(409);
    expect((writerResult.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
    expectSingleOwner(await readPrivateJson<Record<string, string>>("pilot-email-index.json"), email, pilot.id);
  });

  test("pilot-index writer-first: createMyPilot claim makes admin updateUserEmail the PILOT_EMAIL_TAKEN loser", async () => {
    const { user: admin } = await bootstrapAdmin();
    const oldEmail = `pilot-writer-old-${randomUUID()}@example.com`;
    const email = `pilot-writer-first-${randomUUID()}@example.com`;
    const adminPilot = await makePilot({ email: oldEmail });
    const { user: owner } = await makeUser({ email: oldEmail, emailVerified: true });
    expect(owner.pilotId).toBe(adminPilot.id);

    const { user: writer } = await makeUser({ emailVerified: true, roles: [], pilotId: null });
    const writerResult = await createMyPilot(writer, email);
    expect(writerResult.status).toBe(201);
    const writerPilot = writerResult.jsonBody as Pilot;

    const adminResult = await updateUserEmail(admin, owner, email);

    expect(adminResult.status).toBe(409);
    expect((adminResult.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
    expectSingleOwner(await readPrivateJson<Record<string, string>>("pilot-email-index.json"), email, writerPilot.id);
  });
});
