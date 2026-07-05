import { randomUUID } from "crypto";
import { describe, expect, test } from "vitest";
import type { HttpResponseInit } from "@azure/functions";
import type { Manufacturer } from "@bccweb/types";

import { invoke, makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin, makeUser, readPublicJson } from "../../__tests__/helpers/seed.js";
import "../manufacturers.js";

const uniqueHeaders = () => ({ "x-forwarded-for": `${randomUUID()}.manufacturers` });

async function adminCreate(body: unknown): Promise<HttpResponseInit> {
  const { user } = await bootstrapAdmin();
  return invoke(
    "createManufacturer",
    makeAuthRequest(user.id, user.email, { method: "POST", body, headers: uniqueHeaders() }),
  );
}

async function adminUpdate(id: string, body: unknown): Promise<HttpResponseInit> {
  const { user } = await bootstrapAdmin();
  return invoke(
    "updateManufacturer",
    makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id },
      body,
      headers: uniqueHeaders(),
    }),
  );
}

async function adminDelete(id: string): Promise<HttpResponseInit> {
  const { user } = await bootstrapAdmin();
  return invoke(
    "deleteManufacturer",
    makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { id },
      headers: uniqueHeaders(),
    }),
  );
}

async function anonGet(): Promise<HttpResponseInit> {
  return invoke("getManufacturers", makeRequest({ method: "GET" }));
}

describe("manufacturers CRUD API", () => {
  // MUST run first: asserts the fresh per-file container yields an empty list.
  test("GET returns 200 [] on an empty/fresh container", async () => {
    // Given a fresh container with no manufacturers.json
    // When an anonymous caller lists manufacturers
    const res = await anonGet();

    // Then the response is an empty array
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual([]);
  });

  test("full lifecycle: create → list → update → delete → idempotent delete", async () => {
    // Given an Admin creates a manufacturer with a website
    const createRes = await adminCreate({ name: "Ozone", websiteUrl: "https://ozone.com" });

    // Then it is created (201) with a generated id and the supplied fields
    expect(createRes.status).toBe(201);
    const created = createRes.jsonBody as Manufacturer;
    expect(created.id).toEqual(expect.any(String));
    expect(created.name).toBe("Ozone");
    expect(created.websiteUrl).toBe("https://ozone.com");

    // And a public GET lists it
    const listRes = await anonGet();
    expect(listRes.status).toBe(200);
    const list = listRes.jsonBody as Manufacturer[];
    expect(list.some((m) => m.id === created.id && m.name === "Ozone")).toBe(true);

    // When the Admin edits the name (id immutable)
    const updateRes = await adminUpdate(created.id, { name: "Ozone Paragliders" });

    // Then the name changes but the id stays the same
    expect(updateRes.status).toBe(200);
    const updated = updateRes.jsonBody as Manufacturer;
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("Ozone Paragliders");
    expect(updated.websiteUrl).toBe("https://ozone.com"); // preserved on partial update

    // When the Admin deletes it
    const deleteRes = await adminDelete(created.id);

    // Then it is removed (204) and absent from the public list
    expect(deleteRes.status).toBe(204);
    const afterDelete = (await readPublicJson<Manufacturer[]>("manufacturers.json")) ?? [];
    expect(afterDelete.some((m) => m.id === created.id)).toBe(false);

    // When the SAME id is deleted again
    const deleteAgainRes = await adminDelete(created.id);

    // Then it is idempotent (still 204)
    expect(deleteAgainRes.status).toBe(204);
  });

  test("GET returns manufacturers sorted by name", async () => {
    // Given manufacturers created out of alphabetical order
    await adminCreate({ name: `Zeta Wings ${randomUUID()}` });
    await adminCreate({ name: `Alpha Gliders ${randomUUID()}` });
    await adminCreate({ name: `Mango Sails ${randomUUID()}` });

    // When an anonymous caller lists them
    const res = await anonGet();

    // Then the whole list is ordered by name.localeCompare
    expect(res.status).toBe(200);
    const names = (res.jsonBody as Manufacturer[]).map((m) => m.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test("POST by a RoundsCoord is forbidden (403)", async () => {
    // Given a verified RoundsCoord user
    const { user } = await makeUser({ roles: ["RoundsCoord"], emailVerified: true });

    // When they attempt to create a manufacturer
    const res = await invoke(
      "createManufacturer",
      makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: { name: "Should Fail" },
        headers: uniqueHeaders(),
      }),
    );

    // Then the request is forbidden
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "FORBIDDEN" });
  });

  test("POST without a token is unauthorized (401)", async () => {
    // Given no auth token
    // When an anonymous caller attempts to create a manufacturer
    const res = await invoke(
      "createManufacturer",
      makeRequest({ method: "POST", body: { name: "Anon Co" }, headers: uniqueHeaders() }),
    );

    // Then the request is unauthorized
    expect(res.status).toBe(401);
    expect(res.jsonBody).toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("PUT on an unknown id returns 404 and leaves the list UNCHANGED", async () => {
    // Given an existing manufacturer and a snapshot of the list
    const createRes = await adminCreate({ name: `Snapshot ${randomUUID()}` });
    expect(createRes.status).toBe(201);
    const before = (await readPublicJson<Manufacturer[]>("manufacturers.json")) ?? [];

    // When updating a non-existent id
    const res = await adminUpdate(`unknown-${randomUUID()}`, { name: "Ghost" });

    // Then it is 404 NOT_FOUND and the list is unchanged (PUT never inserts)
    expect(res.status).toBe(404);
    expect(res.jsonBody).toMatchObject({ code: "NOT_FOUND" });
    const after = (await readPublicJson<Manufacturer[]>("manufacturers.json")) ?? [];
    expect(after).toEqual(before);
  });
});
