// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeUser, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { TS_CS_VERSION } from "../../lib/termsConstants.js";
import "../me.js";

describe("me TsCs", () => {
  test("user with acceptedTsCsVersion === TS_CS_VERSION -> /me returns tsCsAcceptanceRequired: false", async () => {
    const { user } = await makeUser();
    await writePrivateJson(`users/${user.id}.json`, { ...user, acceptedTsCsVersion: TS_CS_VERSION });
    const entry = getRegisteredHandler("me");
    const res = await entry!.handler(makeAuthRequest(user.id, user.email), { log: () => undefined, invocationId: "req-1" });
    expect(res.status).toBe(200);
    expect((res.jsonBody as { tsCsAcceptanceRequired?: boolean }).tsCsAcceptanceRequired).toBe(false);
  });

  test("user with acceptedTsCsVersion < TS_CS_VERSION -> tsCsAcceptanceRequired: true", async () => {
    const { user } = await makeUser();
    await writePrivateJson(`users/${user.id}.json`, { ...user, acceptedTsCsVersion: TS_CS_VERSION - 1 });
    const entry = getRegisteredHandler("me");
    const res = await entry!.handler(makeAuthRequest(user.id, user.email), { log: () => undefined, invocationId: "req-2" });
    expect((res.jsonBody as { tsCsAcceptanceRequired?: boolean }).tsCsAcceptanceRequired).toBe(true);
  });

  test("user with no acceptedTsCsVersion (legacy pre-T25) -> tsCsAcceptanceRequired: true", async () => {
    const { user } = await makeUser();
    const entry = getRegisteredHandler("me");
    const res = await entry!.handler(makeAuthRequest(user.id, user.email), { log: () => undefined, invocationId: "req-3" });
    expect((res.jsonBody as { tsCsAcceptanceRequired?: boolean }).tsCsAcceptanceRequired).toBe(true);
  });
});
