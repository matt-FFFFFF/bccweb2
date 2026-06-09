import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Round, RoundBrief, Signature, SignToFlyWording } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { signaturePath } from "../../lib/signTofly/ledger.js";
import "../signatures.js";

describe("signature endpoints", () => {
  it("pilot signs own slot -> 201 + signature blob exists at correct path; slot.signToFly = true", async () => {
    const ctx = await seedSignableRound();

    const res = await sign(ctx);

    expect(res.status).toBe(201);
    const sig = res.jsonBody as Signature;
    expect(sig.pilotId).toBe(ctx.pilotId);
    expect(sig.ip).toBe("203.0.113.10");
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1))).toEqual(sig);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(true);
  });

  it("pilot tries to sign another pilot's slot -> 403 NOT_YOUR_SLOT", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: randomUUID() });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT");
  });

  it("admin/coord tries to sign -> 403 NOT_YOUR_SLOT_USE_OVERRIDE", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Admin"], pilotId: ctx.pilotId });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT_USE_OVERRIDE");
  });

  it("same pilot signs same brief version twice -> 200/201 idempotent (same signature returned)", async () => {
    const ctx = await seedSignableRound();

    const first = await sign(ctx);
    const second = await sign(ctx);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.jsonBody).toEqual(first.jsonBody);
  });

  it("brief version bumps after first sign -> second sign creates NEW record; old record preserved on disk", async () => {
    const ctx = await seedSignableRound();

    const first = await sign(ctx);
    await seedBrief(ctx.roundId, 2);
    const second = await sign(ctx);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.jsonBody as Signature).briefVersion).toBe(2);
    expect((second.jsonBody as Signature).id).not.toBe((first.jsonBody as Signature).id);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 1))).toEqual(first.jsonBody);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, 2))).toEqual(second.jsonBody);
  });

  it("round status not BriefComplete -> 409 INVALID_STATE", async () => {
    const ctx = await seedSignableRound({ status: "Confirmed" });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("INVALID_STATE");
    expect((res.jsonBody as { detail: string }).detail).toContain("Confirmed");
  });

  it("slot empty -> 409 SLOT_EMPTY", async () => {
    const ctx = await seedSignableRound({ slotStatus: "Empty" });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("SLOT_EMPTY");
  });

  it("GET /signatures returns all versions ordered", async () => {
    const ctx = await seedSignableRound();
    await sign(ctx);
    await seedBrief(ctx.roundId, 2);
    await sign(ctx);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "getRoundSignatures",
      makeAuthRequest(user.id, user.email, {
        method: "GET",
        params: { roundId: ctx.roundId },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Signature[]).map((sig) => sig.briefVersion)).toEqual([1, 2]);
  });
});

interface SignContext {
  roundId: string;
  teamId: string;
  pilotId: string;
  userId: string;
  email: string;
}

async function seedSignableRound(overrides: {
  status?: Round["status"];
  slotStatus?: "Empty" | "Filled";
} = {}): Promise<SignContext> {
  await seedWording();
  const pilotId = randomUUID();
  const { user } = await makeUser({ roles: ["Pilot"], pilotId });
  const roundId = randomUUID();
  const teamId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: overrides.status ?? "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: randomUUID(), name: "Test Club" },
    season: { year: 2026 },
    teams: [{
      id: teamId,
      teamName: "A",
      club: { id: randomUUID(), name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: overrides.slotStatus ?? "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId,
        snapshot: null,
        flight: null,
      }],
    }],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await seedBrief(roundId, 1);
  return { roundId, teamId, pilotId, userId: user.id, email: user.email };
}

async function sign(ctx: SignContext, userId = ctx.userId, email = ctx.email) {
  return invoke(
    "signOwnSlot",
    makeAuthRequest(userId, email, {
      method: "POST",
      params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
      headers: {
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        "user-agent": "vitest-agent",
      },
    }),
  );
}

async function seedWording(): Promise<void> {
  const html = "<p>Sign to fly wording</p>";
  const wording: SignToFlyWording = {
    version: 1,
    hash: createHash("sha256").update(html, "utf8").digest("hex"),
    html,
    plainText: "Sign to fly wording",
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  };
  await writePrivateJson("sign-to-fly/wording/1.json", wording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

async function seedBrief(roundId: string, version: number): Promise<void> {
  const brief: RoundBrief & { version: number } = {
    roundId,
    version,
    generatedAt: new Date().toISOString(),
    date: "2026-06-09",
    siteName: "Milk Hill",
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    windSpeedDirection: `W ${version}`,
    teams: [],
  };
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
}
