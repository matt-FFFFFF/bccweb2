import { describe, expect, it } from "vitest";
import type { Frequency, SeasonClub } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, writePrivateJson, writePublicJson } from "../../__tests__/helpers/seed.js";
import "../frequencies.js";

describe("frequency admin endpoints", () => {
  it("admin CRUD happy paths", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const created = await invoke("createFrequency", makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { label: "North", position: 2 },
    }));
    expect(created.status).toBe(201);
    const frequency = created.jsonBody as Frequency;
    expect(frequency).toMatchObject({ label: "North", position: 2 });

    const listed = await invoke("getFrequencies", makeAuthRequest(user.id, user.email));
    expect(listed.status).toBe(200);
    expect(listed.jsonBody).toEqual(expect.arrayContaining([frequency]));

    const updated = await invoke("updateFrequency", makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: frequency.id },
      body: { label: "South", position: 1 },
    }));
    expect(updated.status).toBe(200);
    expect(updated.jsonBody).toMatchObject({ id: frequency.id, label: "South", position: 1 });

    const deleted = await invoke("deleteFrequency", makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { id: frequency.id },
    }));
    expect(deleted.status).toBe(200);
  });

  it("delete when in use by SeasonClub -> 409 IN_USE", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const frequency: Frequency = { id: "freq-in-use", label: "Ops", position: 1 };
    await writePrivateJson("frequencies.json", [frequency]);
    const seasonClub: SeasonClub = {
      id: "season-club-1",
      seasonYear: 2026,
      clubId: "club-1",
      numTeams: 1,
      acceptedTsCs: true,
      frequency,
    };
    await writePrivateJson("season-clubs/2026/club-1.json", seasonClub);
    await writePublicJson("season-clubs/2026/index.json", [{
      id: seasonClub.id,
      seasonYear: 2026,
      clubId: seasonClub.clubId,
      clubName: "Club One",
      numTeams: 1,
      frequencyId: frequency.id,
      frequencyLabel: frequency.label,
      acceptedTsCs: true,
    }]);

    const res = await invoke("deleteFrequency", makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { id: frequency.id },
    }));

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("IN_USE");
  });
});
