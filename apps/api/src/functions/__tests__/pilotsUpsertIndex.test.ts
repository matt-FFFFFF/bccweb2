import { randomUUID } from "crypto";
import type { Pilot, PilotEmailIndex, PilotSummary } from "@bccweb/types";
import { describe, expect, test } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../pilots.js";

const ctx = { log: () => undefined } as never;

async function invokeCreatePilot(
  req: ReturnType<typeof makeAuthRequest>
): Promise<{ status: number; jsonBody?: unknown }> {
  const entry = getRegisteredHandler("createPilot");
  if (!entry) throw new Error("createPilot not registered");
  return (await entry.handler(req, ctx)) as { status: number; jsonBody?: unknown };
}

async function invokeUpdatePilot(
  req: ReturnType<typeof makeAuthRequest>
): Promise<{ status: number; jsonBody?: unknown }> {
  const entry = getRegisteredHandler("updatePilot");
  if (!entry) throw new Error("updatePilot not registered");
  return (await entry.handler(req, ctx)) as { status: number; jsonBody?: unknown };
}

describe("pilot index upsert", () => {
  test("concurrent createPilot calls preserve all entries", async () => {
    await writePublicJson("pilots.json", []);
    const { user } = await makeUser({ roles: ["Admin"] });
    const entry = getRegisteredHandler("createPilot");
    expect(entry).toBeTruthy();

    const responses = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        entry!.handler(
          makeAuthRequest(user.id, user.email, {
            method: "POST",
            body: {
              firstName: `Concurrent${index}`,
              lastName: "Pilot",
              email: `concurrent-${index}@example.com`,
            },
          }) as never,
          { log: () => undefined }
        )
      )
    );

    expect(responses.every((result) => result.status === "fulfilled")).toBe(true);
    const ids = responses.map((result) => {
      expect(result.status).toBe("fulfilled");
      return (result as PromiseFulfilledResult<{ jsonBody: { id: string } }>).value.jsonBody.id;
    });
    const index = await readPublicJson<PilotSummary[]>("pilots.json");
    expect(index?.filter((pilot) => ids.includes(pilot.id))).toHaveLength(10);
  });

  test("createPilot returns 409 PILOT_EMAIL_TAKEN when email belongs to another pilot", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const email = `pilot-${randomUUID()}@example.com`;
    await writePrivateJson<PilotEmailIndex>("pilot-email-index.json", {
      [email.toLowerCase()]: randomUUID(),
    });

    const res = await invokeCreatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { firstName: "Taken", lastName: "Email", email },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
  });

  test("updatePilot permits the same pilot to reclaim its indexed email", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const createRes = await invokeCreatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Same",
          lastName: "Owner",
          email: `same-owner-${randomUUID()}@example.com`,
        },
      })
    );
    expect(createRes.status).toBe(201);
    const pilot = createRes.jsonBody as Pilot;
    const email = `same-owner-update-${randomUUID()}@example.com`;
    await writePrivateJson<PilotEmailIndex>("pilot-email-index.json", {
      [email.toLowerCase()]: pilot.id,
    });

    const res = await invokeUpdatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: pilot.id },
        body: { firstName: "Same", lastName: "Owner", email },
      })
    );

    expect(res.status).toBe(200);
    const emailIndex = await readPrivateJson<PilotEmailIndex>(
      "pilot-email-index.json"
    );
    expect(emailIndex?.[email.toLowerCase()]).toBe(pilot.id);
  });

  test("updatePilot returns 409 PILOT_EMAIL_TAKEN when email belongs to another pilot", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const createRes = await invokeCreatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          firstName: "Update",
          lastName: "Conflict",
          email: `update-conflict-source-${randomUUID()}@example.com`,
        },
      })
    );
    expect(createRes.status).toBe(201);
    const pilot = createRes.jsonBody as Pilot;
    const email = `update-conflict-${randomUUID()}@example.com`;
    await writePrivateJson<PilotEmailIndex>("pilot-email-index.json", {
      [email.toLowerCase()]: randomUUID(),
    });

    const res = await invokeUpdatePilot(
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: pilot.id },
        body: { firstName: "Update", lastName: "Conflict", email },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
  });
});
