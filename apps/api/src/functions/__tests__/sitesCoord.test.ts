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
  };
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
});
