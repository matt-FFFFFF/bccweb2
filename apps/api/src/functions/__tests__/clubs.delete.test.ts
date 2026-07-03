import { randomUUID } from "crypto";
import { describe, expect, test } from "vitest";
import type { ClubSummary, SeasonClub, SeasonSummary } from "@bccweb/types";

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeClub,
  makeClubTeam,
  makeSite,
  makeUser,
  privateBlobExists,
  readPublicJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../clubs.js";

async function adminDeleteClub(clubId: string) {
  const { user } = await bootstrapAdmin();
  return invoke(
    "deleteClub",
    makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { id: clubId },
      headers: { "x-forwarded-for": `${randomUUID()}.clubs-delete` },
    }),
  );
}

describe("DELETE /api/clubs/{id}", () => {
  test("deletes an unreferenced club from the public index and private blob", async () => {
    // Given
    const club = await makeClub({ name: `Delete Me ${randomUUID()}` });

    // When
    const res = await adminDeleteClub(club.id);

    // Then
    expect(res.status).toBe(204);
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(false);
    const clubs = await readPublicJson<ClubSummary[]>("clubs.json");
    expect(clubs?.some((item) => item.id === club.id)).toBe(false);
  });

  test("returns 409 when a club-team summary references the club", async () => {
    // Given
    const club = await makeClub({ name: `Team Ref ${randomUUID()}` });
    await makeClubTeam({ clubId: club.id, clubName: club.name, teamName: `Team ${randomUUID()}` });

    // When
    const res = await adminDeleteClub(club.id);

    // Then
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "CLUB_IN_USE", detail: "Club team references this club" });
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(true);
  });

  test("returns 409 when a site summary references the club", async () => {
    // Given
    const club = await makeClub({ name: `Site Ref ${randomUUID()}` });
    await makeSite({ clubId: club.id, name: `Site ${randomUUID()}` });

    // When
    const res = await adminDeleteClub(club.id);

    // Then
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "CLUB_IN_USE", detail: "Site references this club" });
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(true);
  });

  test("returns 409 when a season-club index entry references the club", async () => {
    // Given
    const club = await makeClub({ name: `Season Ref ${randomUUID()}` });
    const seasonYear = 3300 + Math.floor(Math.random() * 500);
    const seasons: SeasonSummary[] = [{ id: `season-${seasonYear}`, year: seasonYear, active: true }];
    const seasonClub: SeasonClub = {
      id: randomUUID(),
      seasonYear,
      clubId: club.id,
      numTeams: 1,
      acceptedTsCs: true,
      acceptedTsCsAt: new Date().toISOString(),
    };
    await writePublicJson("seasons.json", seasons);
    await writePublicJson(`season-clubs/${seasonYear}/index.json`, [
      { ...seasonClub, clubName: club.name },
    ]);

    // When
    const res = await adminDeleteClub(club.id);

    // Then
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "CLUB_IN_USE", detail: "Season-club registration references this club" });
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(true);
  });

  test("returns 5xx and preserves the club when a reference source is unreadable", async () => {
    // Given
    const club = await makeClub({ name: `Guard Fail ${randomUUID()}` });
    await writePublicJson("seasons.json", [{ id: "season-bad", year: "bad-year", active: true }]);

    // When
    const res = await adminDeleteClub(club.id);

    // Then
    expect(res.status).toBe(500);
    expect(res.jsonBody).toMatchObject({ code: "CLUB_GUARD_UNVERIFIABLE" });
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(true);
    const clubs = await readPublicJson<ClubSummary[]>("clubs.json");
    expect(clubs?.some((item) => item.id === club.id)).toBe(true);
  });

  test("returns 404 for an unknown club", async () => {
    // Given
    const missingClubId = randomUUID();

    // When
    const res = await adminDeleteClub(missingClubId);

    // Then
    expect(res.status).toBe(404);
    expect(res.jsonBody).toMatchObject({ code: "NOT_FOUND" });
  });

  test("returns 403 for a non-admin caller", async () => {
    // Given
    const club = await makeClub({ name: `Forbidden ${randomUUID()}` });
    const { user } = await makeUser({ roles: ["Pilot"], emailVerified: true });

    // When
    const res = await invoke(
      "deleteClub",
      makeAuthRequest(user.id, user.email, {
        method: "DELETE",
        params: { id: club.id },
        headers: { "x-forwarded-for": `${randomUUID()}.clubs-delete` },
      }),
    );

    // Then
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "FORBIDDEN" });
    await expect(privateBlobExists(`clubs/${club.id}.json`)).resolves.toBe(true);
  });
});
