import { describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import type { Site, SiteSummary } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeSite,
  makeUser,
  privateBlobExists,
  readPublicJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import "../sites.js";

const ctx = { log: () => undefined } as never;

async function invoke(
  name: string,
  req: ReturnType<typeof makeAuthRequest>
) {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req as never, ctx)) as {
    status: number;
    jsonBody?: unknown;
    headers?: Record<string, string>;
  };
}

// Random source IP per request so any IP-keyed limiter never binds; the
// mutation limiter is userId-keyed, which is the bucket we exercise here.
function randIp(): string {
  return `10.42.${Math.floor(Math.random() * 250) + 1}.${
    Math.floor(Math.random() * 250) + 1
  }`;
}

describe("sites endpoints — RoundsCoord scoping", () => {
  test("coord can GET a site that belongs to their club", async () => {
    const clubId = randomUUID();
    const site = await makeSite({ clubId });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId,
      emailVerified: true,
    });

    const res = await invoke(
      "getSiteById",
      makeAuthRequest(user.id, user.email, {
        method: "GET",
        params: { id: site.id },
      })
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Site).id).toBe(site.id);
  });

  test("coord 403 on GET of a site from another club", async () => {
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    const res = await invoke(
      "getSiteById",
      makeAuthRequest(user.id, user.email, {
        method: "GET",
        params: { id: site.id },
      })
    );

    expect(res.status).toBe(403);
  });

  test("coord can POST a site for their own club", async () => {
    const clubId = randomUUID();
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId,
      emailVerified: true,
    });

    const res = await invoke(
      "createSite",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: {
          name: `Coord Site ${randomUUID().slice(0, 8)}`,
          clubId,
          parkingW3W: "///foo.bar.baz",
        },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Site;
    expect(created.clubId).toBe(clubId);
    expect(created.parkingW3W).toBe("///foo.bar.baz");
  });

  test("coord 403 when POSTing a site for another club", async () => {
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    const res = await invoke(
      "createSite",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { name: "Other", clubId: randomUUID() },
      })
    );

    expect(res.status).toBe(403);
  });

  test("coord can PUT their own-club site (W3W persists)", async () => {
    const clubId = randomUUID();
    const site = await makeSite({ clubId });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId,
      emailVerified: true,
    });

    const res = await invoke(
      "updateSite",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: site.id },
        body: { parkingW3W: "///alpha.bravo.charlie" },
      })
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Site).parkingW3W).toBe("///alpha.bravo.charlie");
  });

  test("coord 403 on PUT of a site from another club", async () => {
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    const res = await invoke(
      "updateSite",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: site.id },
        body: { parkingW3W: "///nope" },
      })
    );

    expect(res.status).toBe(403);
  });

  test("coord cannot reassign their site to a different club", async () => {
    const clubId = randomUUID();
    const site = await makeSite({ clubId });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId,
      emailVerified: true,
    });

    const res = await invoke(
      "updateSite",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: site.id },
        body: { clubId: randomUUID() },
      })
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code?: string }).code).toBe(
      "CLUB_CHANGE_FORBIDDEN"
    );
  });

  test("admin CAN reassign a site's club", async () => {
    const site = await makeSite({ clubId: randomUUID() });
    const newClub = randomUUID();
    const { user: admin } = await makeUser({
      roles: ["Admin"],
      emailVerified: true,
    });

    const res = await invoke(
      "updateSite",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { id: site.id },
        body: { clubId: newClub },
      })
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Site).clubId).toBe(newClub);
  });

  test("coord can DELETE their own-club site (blob + index purged)", async () => {
    const clubId = randomUUID();
    const site = await makeSite({ clubId });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId,
      emailVerified: true,
    });

    const res = await invoke(
      "deleteSite",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: site.id },
      })
    );

    expect(res.status).toBe(204);
    expect(await privateBlobExists(`sites/${site.id}.json`)).toBe(false);
    const index = await readPublicJson<SiteSummary[]>("sites.json");
    expect(index?.some((s) => s.id === site.id)).toBe(false);
  });

  test("coord 403 on DELETE of a site from another club", async () => {
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    const res = await invoke(
      "deleteSite",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: site.id },
      })
    );

    expect(res.status).toBe(403);
    expect(await privateBlobExists(`sites/${site.id}.json`)).toBe(true);
  });

  test("plain Pilot user 403 on any site mutation", async () => {
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["Pilot"],
      emailVerified: true,
    });

    const create = await invoke(
      "createSite",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { name: "x", clubId: randomUUID() },
      })
    );
    expect(create.status).toBe(403);

    const update = await invoke(
      "updateSite",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: site.id },
        body: { parkingW3W: "///x" },
      })
    );
    expect(update.status).toBe(403);

    const del = await invoke(
      "deleteSite",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: site.id },
      })
    );
    expect(del.status).toBe(403);
  });

  test("forbidden cross-club coord PUT returns 403 not 429 even with drained bucket", async () => {
    resetAllBuckets();
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    // Drain coord's userId bucket on the updateSite endpoint (standard tier = 30).
    let last = await invoke(
      "updateSite",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { id: site.id },
        body: { parkingW3W: "///nope" },
        headers: { "x-forwarded-for": randIp() },
      })
    );
    for (let i = 0; i < 31; i += 1) {
      last = await invoke(
        "updateSite",
        makeAuthRequest(user.id, user.email, {
          method: "PUT",
          params: { id: site.id },
          body: { parkingW3W: "///nope" },
          headers: { "x-forwarded-for": randIp() },
        })
      );
    }

    expect(last.status).toBe(403);
    expect((last.jsonBody as { code?: string }).code).toBe("FORBIDDEN");
    expect(last.headers?.["Retry-After"]).toBeUndefined();
  });

  test("forbidden cross-club coord DELETE returns 403 not 429 even with drained bucket", async () => {
    resetAllBuckets();
    const site = await makeSite({ clubId: randomUUID() });
    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
      emailVerified: true,
    });

    let last = await invoke(
      "deleteSite",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: site.id },
        headers: { "x-forwarded-for": randIp() },
      })
    );
    for (let i = 0; i < 31; i += 1) {
      last = await invoke(
        "deleteSite",
        makeAuthRequest(user.id, user.email, {
          method: "DELETE",
          params: { id: site.id },
          headers: { "x-forwarded-for": randIp() },
        })
      );
    }

    expect(last.status).toBe(403);
    expect((last.jsonBody as { code?: string }).code).toBe("FORBIDDEN");
    expect(last.headers?.["Retry-After"]).toBeUndefined();
    expect(await privateBlobExists(`sites/${site.id}.json`)).toBe(true);
  });

  test("deleteSite on an absent site is idempotent (204, not 404)", async () => {
    resetAllBuckets();
    const { user: admin } = await makeUser({
      roles: ["Admin"],
      emailVerified: true,
    });

    const res = await invoke(
      "deleteSite",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { id: randomUUID() },
        headers: { "x-forwarded-for": randIp() },
      })
    );

    expect(res.status).toBe(204);
  });
});
