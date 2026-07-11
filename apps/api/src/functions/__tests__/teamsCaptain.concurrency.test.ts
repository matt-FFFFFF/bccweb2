// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BlobLeaseClient } from "@azure/storage-blob";
import type { Round } from "@bccweb/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  failCaptainRoundLeaseOnce,
  seedRoundWithTeam,
} from "./teamsCaptain.testHelpers.js";
import "../teamsCaptain.js";

describe("team captain mutation concurrency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Locked round: 409 ROUND_LOCKED, captain unchanged", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "Locked";
      stored.isLocked = true;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });

  it("Complete round: 409 ROUND_LOCKED", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "Complete";
      stored.isLocked = true;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");
  });

  it("BriefComplete round (isLocked false): 409 ROUND_LOCKED, captain unchanged", async () => {
    resetAllBuckets();
    const { round, team, pilot } = await seedRoundWithTeam();
    const stored = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    if (stored) {
      stored.status = "BriefComplete";
      stored.isLocked = false;
      await writePrivateJson(`rounds/${round.id}.json`, stored);
    }
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("ROUND_LOCKED");
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });

  it.each([409, 412])(
    "raw lease acquisition %i is retried server-side",
    async (statusCode) => {
      const { round, team, pilot } = await seedRoundWithTeam();
      const { user } = await makeUser({ roles: ["Admin"] });
      const roundPath = `rounds/${round.id}.json`;
      const leaseFailure = failCaptainRoundLeaseOnce(roundPath, statusCode);
      const res = await invoke(
        "setTeamCaptain",
        makeAuthRequest(user.id, user.email, {
          method: "PUT",
          params: { id: round.id, teamId: team.id },
          body: { pilotId: pilot.id },
        })
      );
      expect(res.status).toBe(200);
      expect(leaseFailure.roundAttempts()).toBe(2);
      const saved = await readPrivateJson<Round>(roundPath);
      expect(saved?.teams[0].captainPilotId).toBe(pilot.id);
    }
  );

  it("TOCTOU inside lease: team club changes between pre-read and lease read -> 403", async () => {
    resetAllBuckets();
    const { round, team, pilot, clubId } = await seedRoundWithTeam();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId });
    const roundPath = `rounds/${round.id}.json`;
    const originalAcquireLease = BlobLeaseClient.prototype.acquireLease;
    let mutated = false;
    vi.spyOn(BlobLeaseClient.prototype, "acquireLease").mockImplementation(
      async function (this: BlobLeaseClient, duration, options) {
        if (!mutated && this.url.includes(roundPath)) {
          mutated = true;
          const stored = await readPrivateJson<Round>(roundPath);
          if (stored) {
            stored.teams[0].club.id = randomUUID();
            await writePrivateJson(roundPath, stored);
          }
        }
        return originalAcquireLease.call(this, duration, options);
      }
    );
    const res = await invoke(
      "setTeamCaptain",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: round.id, teamId: team.id },
        body: { pilotId: pilot.id },
      })
    );
    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");
    const after = await readPrivateJson<Round>(roundPath);
    expect(after?.teams[0].captainPilotId ?? null).toBeNull();
  });
});
