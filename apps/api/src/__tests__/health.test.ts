import { describe, expect, test } from "vitest";
import { getRegisteredHandler } from "./helpers/setup.js";
import { makeRequest } from "./helpers/api.js";

import "../functions/health.js";

describe("health smoke test", () => {
  test("GET /api/health returns ok", async () => {
    const entry = getRegisteredHandler("health");

    expect(entry).toBeTruthy();

    const req = makeRequest({ method: "GET" });
    const ctx = { log: () => undefined, functionName: "health" };

    const res = await entry!.handler(req as never, ctx as never);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
  });
});
