import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Round, Season } from "@bccweb/types";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { makeClub, makeSite, makeUser, writePublicJson } from "../../__tests__/helpers/seed.js";
import "../roundsMutate.js";

async function seedSiteAndSeason() {
  const year = 4000 + Math.floor(Math.random() * 5000);
  const club = await makeClub({ id: randomUUID(), name: "Guard Club" });
  const site = await makeSite({ id: randomUUID(), name: "Guard Hill", clubId: club.id });
  await writePublicJson(
    `seasons/${year}.json`,
    { id: `season-${year}`, year, active: true, rounds: [], leagueTable: [] } satisfies Season,
  );
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });
  return { year, club, siteId: site.id, admin };
}

describe("createRound organising-club guard", () => {
  it("returns 400 CLUB_NOT_FOUND when a provided organisingClubId does not resolve", async () => {
    const { year, siteId, admin } = await seedSiteAndSeason();

    const res = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { date: `${year}-06-09`, siteId, seasonYear: year, organisingClubId: randomUUID() },
      }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string }).code).toBe("CLUB_NOT_FOUND");
  });

  it("stamps organisingClub when the club resolves", async () => {
    const { year, club, siteId, admin } = await seedSiteAndSeason();

    const res = await invoke(
      "createRound",
      makeAuthRequest(admin.id, admin.email, {
        method: "POST",
        body: { date: `${year}-06-10`, siteId, seasonYear: year, organisingClubId: club.id },
      }),
    );

    expect(res.status).toBe(201);
    expect((res.jsonBody as Round).organisingClub).toEqual({ id: club.id, name: club.name });
  });
});
