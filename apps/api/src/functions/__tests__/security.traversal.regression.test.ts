import { describe, expect, test } from "vitest";
import type { Pilot } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, makePilot, writePrivateJson, readPrivateJson } from "../../__tests__/helpers/seed.js";
import { assertSafeBlobPath, getPrivateBlobClient } from "../../lib/blob.js";
import "../pilotSeasonClubs.js";

describe("blob path traversal (finding G)", () => {
  describe("assertSafeBlobPath central guard", () => {
    test.each([
      "season-clubs/2025/../../auth/oracle-known/club.json",
      "pilots/x/../../pilots/foreign.json",
      "../config.json",
      "auth/../users/admin.json",
      "a/./b.json",
      "/leading-slash.json",
      "double//slash.json",
      "back\\slash.json",
      "null\u0000byte.json",
      "del\u007fchar.json",
      "",
    ])("rejects unsafe path %j", (path) => {
      expect(() => assertSafeBlobPath(path)).toThrow();
    });

    test.each([
      "rounds.json",
      "seasons/2026.json",
      "season-clubs/2026/club-a.json",
      "pilots/3f9a-uuid_id.json",
      "round-briefs/uuid/image-1.png",
      "auth/tokens/deadbeef.json",
    ])("accepts legitimate path %j", (path) => {
      expect(() => assertSafeBlobPath(path)).not.toThrow();
    });

    test("getPrivateBlobClient throws before reaching storage on traversal", () => {
      expect(() => getPrivateBlobClient("season-clubs/2025/../../auth/secret.json")).toThrow();
    });
  });

  describe("assignPilotSeasonClub", () => {
    test("seasonYear traversal yields no private-blob existence oracle", async () => {
      const { user } = await makeUser({ roles: ["Admin"] });
      await makePilot({ id: "g-oracle-pilot" });
      await writePrivateJson("auth/g-known/club.json", { marker: "secret" });

      const targetingKnownBlob = await invoke("assignPilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { pilotId: "g-oracle-pilot", clubId: "club", seasonYear: "2025/../../auth/g-known" },
      }));
      const targetingMissingBlob = await invoke("assignPilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { pilotId: "g-oracle-pilot", clubId: "club", seasonYear: "2025/../../auth/g-missing" },
      }));

      expect(targetingKnownBlob.status).toBe(400);
      expect(targetingMissingBlob.status).toBe(400);
      expect((targetingKnownBlob.jsonBody as { code?: string }).code)
        .toBe((targetingMissingBlob.jsonBody as { code?: string }).code);
    });

    test("pilotId traversal cannot mutate a foreign pilot blob", async () => {
      const { user } = await makeUser({ roles: ["Admin"] });
      const foreign = await makePilot({ id: "g-foreign-pilot", clubId: "foreign-club" });
      foreign.seasonClubs = [];
      await writePrivateJson("pilots/g-foreign-pilot.json", foreign);
      await writePrivateJson("clubs/g-attacker-club.json", { id: "g-attacker-club", name: "Attacker" });
      await writePrivateJson("season-clubs/2026/g-attacker-club.json", { id: "sc-g", seasonYear: 2026, clubId: "g-attacker-club" });

      const res = await invoke("assignPilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { pilotId: "x/../../pilots/g-foreign-pilot", clubId: "g-attacker-club", seasonYear: 2026 },
      }));

      expect(res.status).toBe(400);
      const unchanged = await readPrivateJson<Pilot>("pilots/g-foreign-pilot.json");
      expect(unchanged!.seasonClubs).toEqual([]);
    });

    test("clubId traversal is rejected", async () => {
      const { user } = await makeUser({ roles: ["Admin"] });
      await makePilot({ id: "g-clubid-pilot" });

      const res = await invoke("assignPilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { pilotId: "g-clubid-pilot", clubId: "x/../../clubs/victim", seasonYear: 2026 },
      }));

      expect(res.status).toBe(400);
    });
  });

  describe("deletePilotSeasonClub", () => {
    test("pilotId route traversal is rejected", async () => {
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await invoke("deletePilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { pilotId: "x/../../pilots/victim", seasonYear: "2026" },
      }));

      expect(res.status).toBe(400);
    });

    test.each(["2026abc", "26", "0", "abcd"])("rejects non-4-digit-year route param %j", async (seasonYear) => {
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await invoke("deletePilotSeasonClub", makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { pilotId: "g-year-pilot", seasonYear },
      }));

      expect(res.status).toBe(400);
    });
  });
});
