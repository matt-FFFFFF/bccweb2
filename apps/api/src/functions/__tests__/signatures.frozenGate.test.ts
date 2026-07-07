import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Round, RoundBrief, Signature, SignToFlyWording } from "@bccweb/types";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeUser, privateBlobExists, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import { reflectRoundSignToFly } from "../../lib/signTofly/reflect.js";
import "../signatures.js";

interface SignContext {
  roundId: string;
  teamId: string;
  pilotId: string;
  userId: string;
  email: string;
}

describe("G2 — signing requires a frozen, untampered brief", () => {
  it("signing an UNFROZEN brief (no hash) -> 409 BRIEF_REQUIRED and the brief is NOT lazy-frozen", async () => {
    const ctx = await seedSignableRound();
    await seedBrief(ctx.roundId, 1, { frozen: false });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_REQUIRED");
    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(brief?.hash).toBeUndefined();
  });

  it("signing when NO brief exists -> 409 BRIEF_REQUIRED and no brief is created", async () => {
    const ctx = await seedSignableRound();

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_REQUIRED");
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(false);
  });

  it("signing a TAMPERED brief (hash !== computeBriefHash) -> 409 BRIEF_HASH_MISMATCH", async () => {
    const ctx = await seedSignableRound();
    await seedBrief(ctx.roundId, 1, { frozen: true, tamper: true });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_HASH_MISMATCH");
  });

  it("signing a correctly FROZEN brief -> 201 and stamps signature.briefHash === brief.hash", async () => {
    const ctx = await seedSignableRound();
    const brief = await seedBrief(ctx.roundId, 1, { frozen: true });

    const res = await sign(ctx);

    expect(res.status).toBe(201);
    expect((res.jsonBody as Signature).briefHash).toBe(brief.hash);
    expect((res.jsonBody as Signature).briefHash).toBe(computeBriefHash(brief));
  });

  it("override path also requires a frozen brief -> 409 BRIEF_REQUIRED on an unfrozen brief", async () => {
    const ctx = await seedSignableRound();
    await seedBrief(ctx.roundId, 1, { frozen: false });
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "overrideSlotSignature",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
        body: { reason: "Pilot signed the paper form at the field", onBehalfOfPilotId: ctx.pilotId },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_REQUIRED");
  });
});

describe("R6 — reflectRoundSignToFly re-checks status + frozen version under the round lease", () => {
  it("sets signToFly when status is BriefComplete AND latest signature matches the current frozen brief version", async () => {
    const ctx = await seedSignableRound({ status: "BriefComplete" });
    await seedBrief(ctx.roundId, 1, { frozen: true });
    await writeSignature(makeSig(ctx, 1));

    await reflectRoundSignToFly(ctx.roundId);

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(true);
  });

  it("status guard: a reflect that runs AFTER lock (status !== BriefComplete) does NOT set signToFly", async () => {
    const ctx = await seedSignableRound({ status: "Locked" });
    await seedBrief(ctx.roundId, 1, { frozen: true });
    await writeSignature(makeSig(ctx, 1));

    await reflectRoundSignToFly(ctx.roundId);

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(false);
  });

  it("version guard: a v1-pinned signature is NOT reflected after a v2 re-complete", async () => {
    const ctx = await seedSignableRound({ status: "BriefComplete" });
    await seedBrief(ctx.roundId, 2, { frozen: true }); // current frozen brief is v2
    await writeSignature(makeSig(ctx, 1)); // latest signature is pinned to v1

    await reflectRoundSignToFly(ctx.roundId);

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(false);
  });
});

async function seedSignableRound(
  overrides: { status?: Round["status"] } = {},
): Promise<SignContext> {
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
        status: "Filled",
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
  return { roundId, teamId, pilotId, userId: user.id, email: user.email };
}

async function sign(ctx: SignContext, userId = ctx.userId, email = ctx.email) {
  return invoke(
    "signOwnSlot",
    makeAuthRequest(userId, email, {
      method: "POST",
      params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
      headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.10", "user-agent": "vitest-agent" },
    }),
  );
}

async function seedWording(): Promise<void> {
  const markdown = "Sign to fly wording";
  const wording: SignToFlyWording = {
    version: 1,
    hash: createHash("sha256").update(markdown, "utf8").digest("hex"),
    markdown,
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  };
  await writePrivateJson("sign-to-fly/wording/1.json", wording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

async function seedBrief(
  roundId: string,
  version: number,
  opts: { frozen?: boolean; tamper?: boolean } = {},
): Promise<RoundBrief & { version: number }> {
  const brief: RoundBrief & { version: number } = {
    roundId,
    version,
    generatedAt: new Date().toISOString(),
    date: "2026-06-09",
    siteName: "Milk Hill",
    windSpeedDirection: `W ${version}`,
    imagePaths: [],
    teams: [],
  };
  if (opts.frozen) brief.hash = opts.tamper ? "tampered-hash-deadbeef" : computeBriefHash(brief);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
  return brief;
}

function makeSig(ctx: SignContext, briefVersion: number): Signature {
  return {
    id: randomUUID(),
    roundId: ctx.roundId,
    teamId: ctx.teamId,
    place: 1,
    pilotId: ctx.pilotId,
    userId: randomUUID(),
    signedAt: new Date().toISOString(),
    briefVersion,
    briefHash: "seed-hash",
    wordingVersion: 1,
    wordingHash: "seed-wording-hash",
    ip: "203.0.113.10",
    userAgent: "seed-agent",
    source: "pilot-self",
  };
}
