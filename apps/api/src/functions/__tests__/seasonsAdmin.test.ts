import { describe, expect, test } from "vitest";
import type { Season, SeasonSummary } from "@bccweb/types";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  publicBlobExists,
  readPublicJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../seasons.js";

const ctx = { log: () => undefined } as never;

async function call(
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

function randomYear() {
  return 3000 + Math.floor(Math.random() * 6_000);
}

describe("admin season endpoints", () => {
  test("POST creates a season with rounds=[], leagueTable=[] and writes index", async () => {
    const year = randomYear();
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "createSeason",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { year },
      })
    );

    expect(res.status).toBe(201);
    const created = res.jsonBody as Season;
    expect(created.year).toBe(year);
    expect(created.active).toBe(false);
    expect(created.rounds).toEqual([]);
    expect(created.leagueTable).toEqual([]);

    const stored = await readPublicJson<Season>(`seasons/${year}.json`);
    expect(stored?.year).toBe(year);

    const index = await readPublicJson<SeasonSummary[]>("seasons.json");
    expect(index?.some((s) => s.year === year && !s.active)).toBe(true);
  });

  test("POST with active=true deactivates all other seasons", async () => {
    const existing = randomYear();
    const fresh = existing + 1;

    await writePublicJson(`seasons/${existing}.json`, {
      id: `season-${existing}`,
      year: existing,
      active: true,
      rounds: [],
      leagueTable: [],
    });
    await writePublicJson("seasons.json", [
      { id: `season-${existing}`, year: existing, active: true },
    ]);

    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "createSeason",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { year: fresh, active: true },
      })
    );

    expect(res.status).toBe(201);
    const index = await readPublicJson<SeasonSummary[]>("seasons.json");
    const oldEntry = index?.find((s) => s.year === existing);
    const newEntry = index?.find((s) => s.year === fresh);
    expect(oldEntry?.active).toBe(false);
    expect(newEntry?.active).toBe(true);

    const oldFull = await readPublicJson<Season>(`seasons/${existing}.json`);
    expect(oldFull?.active).toBe(false);
  });

  test("POST rejects duplicate year with 409 SEASON_EXISTS", async () => {
    const year = randomYear();
    await writePublicJson(`seasons/${year}.json`, {
      id: `season-${year}`,
      year,
      active: false,
      rounds: [],
      leagueTable: [],
    });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "createSeason",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { year },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("SEASON_EXISTS");
  });

  test("POST rejects invalid year (NaN / out of range)", async () => {
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const bad = await call(
      "createSeason",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { year: 1900 },
      })
    );
    expect(bad.status).toBe(400);

    const nope = await call(
      "createSeason",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { year: "not-a-year" },
      })
    );
    expect(nope.status).toBe(400);
  });

  test("PUT active=true makes exactly one season active across the system", async () => {
    const a = randomYear();
    const b = a + 1;

    await writePublicJson(`seasons/${a}.json`, {
      id: `season-${a}`,
      year: a,
      active: true,
      rounds: [],
      leagueTable: [],
    });
    await writePublicJson(`seasons/${b}.json`, {
      id: `season-${b}`,
      year: b,
      active: false,
      rounds: [],
      leagueTable: [],
    });
    await writePublicJson("seasons.json", [
      { id: `season-${b}`, year: b, active: false },
      { id: `season-${a}`, year: a, active: true },
    ]);

    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "updateSeason",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { year: String(b) },
        body: { active: true },
      })
    );

    expect(res.status).toBe(200);
    const index = await readPublicJson<SeasonSummary[]>("seasons.json");
    const actives = (index ?? []).filter((s) => s.active);
    expect(actives).toHaveLength(1);
    expect(actives[0]?.year).toBe(b);

    const aFull = await readPublicJson<Season>(`seasons/${a}.json`);
    expect(aFull?.active).toBe(false);
  });

  test("PUT active=false can clear the active flag", async () => {
    const year = randomYear();
    await writePublicJson(`seasons/${year}.json`, {
      id: `season-${year}`,
      year,
      active: true,
      rounds: [],
      leagueTable: [],
    });
    await writePublicJson("seasons.json", [
      { id: `season-${year}`, year, active: true },
    ]);
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "updateSeason",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        params: { year: String(year) },
        body: { active: false },
      })
    );

    expect(res.status).toBe(200);
    const stored = await readPublicJson<Season>(`seasons/${year}.json`);
    expect(stored?.active).toBe(false);
  });

  test("DELETE removes blob + index entry + results when no rounds attached", async () => {
    const year = randomYear();
    await writePublicJson(`seasons/${year}.json`, {
      id: `season-${year}`,
      year,
      active: false,
      rounds: [],
      leagueTable: [],
    });
    await writePublicJson(`results/${year}.json`, []);
    await writePublicJson("seasons.json", [
      { id: `season-${year}`, year, active: false },
    ]);
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "deleteSeason",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { year: String(year) },
      })
    );

    expect(res.status).toBe(204);
    expect(await publicBlobExists(`seasons/${year}.json`)).toBe(false);
    expect(await publicBlobExists(`results/${year}.json`)).toBe(false);
    const index = await readPublicJson<SeasonSummary[]>("seasons.json");
    expect(index?.some((s) => s.year === year)).toBe(false);
  });

  test("DELETE blocked with 409 SEASON_HAS_ROUNDS when rounds attached", async () => {
    const year = randomYear();
    await writePublicJson(`seasons/${year}.json`, {
      id: `season-${year}`,
      year,
      active: false,
      rounds: ["round-1"],
      leagueTable: [],
    });
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "deleteSeason",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { year: String(year) },
      })
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("SEASON_HAS_ROUNDS");
    expect(await publicBlobExists(`seasons/${year}.json`)).toBe(true);
  });

  test("DELETE on missing season returns 204 (idempotent) and cleans index", async () => {
    const year = randomYear();
    await writePublicJson("seasons.json", [
      { id: `season-${year}`, year, active: false },
    ]);
    const { user } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await call(
      "deleteSeason",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { year: String(year) },
      })
    );

    expect(res.status).toBe(204);
    const index = await readPublicJson<SeasonSummary[]>("seasons.json");
    expect(index?.some((s) => s.year === year)).toBe(false);
  });

  test("non-admin (Pilot/RoundsCoord/anon) cannot mutate seasons", async () => {
    const year = randomYear();
    await writePublicJson(`seasons/${year}.json`, {
      id: `season-${year}`,
      year,
      active: false,
      rounds: [],
      leagueTable: [],
    });
    const { user: pilot } = await makeUser({
      roles: ["Pilot"],
      emailVerified: true,
    });
    const { user: coord } = await makeUser({
      roles: ["RoundsCoord"],
      emailVerified: true,
    });

    const c1 = await call(
      "createSeason",
      makeAuthRequest(pilot.id, pilot.email, {
        method: "POST",
        body: { year: year + 100 },
      })
    );
    expect(c1.status).toBe(403);

    const c2 = await call(
      "createSeason",
      makeAuthRequest(coord.id, coord.email, {
        method: "POST",
        body: { year: year + 101 },
      })
    );
    expect(c2.status).toBe(403);

    const u = await call(
      "updateSeason",
      makeAuthRequest(coord.id, coord.email, {
        method: "PUT",
        params: { year: String(year) },
        body: { active: true },
      })
    );
    expect(u.status).toBe(403);

    const d = await call(
      "deleteSeason",
      makeAuthRequest(pilot.id, pilot.email, {
        method: "DELETE",
        params: { year: String(year) },
      })
    );
    expect(d.status).toBe(403);
  });
});
