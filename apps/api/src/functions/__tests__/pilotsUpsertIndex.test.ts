import type { PilotSummary } from "@bccweb/types";
import { describe, expect, test } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeUser, readPublicJson, writePublicJson } from "../../__tests__/helpers/seed.js";
import "../pilots.js";

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
});
