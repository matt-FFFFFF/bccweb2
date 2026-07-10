// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "@azure/functions";
import { getCallerIdentity } from "../../lib/auth.js";
import { readJson } from "../../lib/blobJson.js";

vi.mock("@azure/functions", () => ({
  app: { http: vi.fn() },
  HttpRequest: class {},
  InvocationContext: class {},
}));

vi.mock("../../lib/auth.js", () => ({
  getCallerIdentity: vi.fn(),
  unauthorizedResponse: vi.fn(() => ({ status: 401 })),
}));

vi.mock("../../lib/blob.js", () => ({
  getBlobClient: vi.fn((path) => ({ name: path })),
  getPrivateBlobClient: vi.fn((path) => ({ name: path })),
  readBlob: vi.fn(),
}));

vi.mock("../../lib/blobJson.js", () => ({
  readJson: vi.fn(),
  writeJson: vi.fn(),
  writePrivateJson: vi.fn(),
}));

vi.mock("../../lib/http.js", () => ({
  withErrorHandler: (fn: any) => fn,
}));

describe("GET /me - First Login of Season logic", () => {
  let meHandler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // We need to re-import the module to capture the handler
    (app as any).http = vi.fn((name, config) => {
      if (name === "me") meHandler = config.handler;
    });
    
    // Dynamically import to let the vi.mock take effect
    await import("../me.js");
  });

  it("non-Pilot caller -> firstLoginOfSeason: false", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ roles: ["Admin"], userId: "u1" } as any);
    
    vi.mocked(readJson).mockImplementation(async (client: any) => {
      if (client?.name === "users/u1.json") return { acceptedTsCsVersion: 999 };
      return {};
    });
    
    const req = { method: "GET", url: "http://localhost/me" };
    const ctx = {};
    const res = await meHandler(req as any, ctx as any);
    
    expect(res.status).toBe(200);
    expect(res.jsonBody.firstLoginOfSeason).toBe(false);
  });

  it("pilot with no seasonClubs for active year -> firstLoginOfSeason: true", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ roles: ["Pilot"], pilotId: "p1", userId: "u1" } as any);
    
    vi.mocked(readJson).mockImplementation(async (client: any) => {
      if (client?.name === "users/u1.json") return { acceptedTsCsVersion: 999 };
      if (client?.name === "seasons.json") return [{ id: "season-2026", year: 2026, active: true }];
      if (client?.name === "pilots/p1.json") return {
        id: "p1",
        coachType: "None",
        pilotRating: "Pilot",
        person: { id: "person-1", firstName: "Test", lastName: "Pilot", fullName: "Test Pilot" },
        profileUpdatedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
        seasonClubs: [{ seasonYear: 2025, clubId: "c1", clubName: "C1" }]
      };
      return {};
    });

    const req = { method: "GET", url: "http://localhost/me" };
    const ctx = {};
    const res = await meHandler(req as any, ctx as any);
    
    expect(res.status).toBe(200);
    expect(res.jsonBody.firstLoginOfSeason).toBe(true);
    expect(res.jsonBody.activeSeasonYear).toBe(2026);
  });

  it("pilot with profileUpdatedAt < season start -> firstLoginOfSeason: true", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ roles: ["Pilot"], pilotId: "p1", userId: "u1" } as any);
    
    vi.mocked(readJson).mockImplementation(async (client: any) => {
      if (client?.name === "users/u1.json") return { acceptedTsCsVersion: 999 };
      if (client?.name === "seasons.json") return [{ id: "season-2026", year: 2026, active: true }];
      if (client?.name === "pilots/p1.json") return {
        id: "p1",
        coachType: "None",
        pilotRating: "Pilot",
        person: { id: "person-1", firstName: "Test", lastName: "Pilot", fullName: "Test Pilot" },
        profileUpdatedAt: new Date("2025-12-01T00:00:00Z").toISOString(),
        seasonClubs: [{ seasonYear: 2026, clubId: "c1", clubName: "C1" }]
      };
      return {};
    });

    const req = { method: "GET", url: "http://localhost/me" };
    const ctx = {};
    const res = await meHandler(req as any, ctx as any);
    
    expect(res.status).toBe(200);
    expect(res.jsonBody.firstLoginOfSeason).toBe(true);
  });

  it("pilot with profileUpdatedAt in current year AND has seasonClub -> firstLoginOfSeason: false", async () => {
    vi.mocked(getCallerIdentity).mockResolvedValue({ roles: ["Pilot"], pilotId: "p1", userId: "u1" } as any);
    
    vi.mocked(readJson).mockImplementation(async (client: any) => {
      if (client?.name === "users/u1.json") return { acceptedTsCsVersion: 999 };
      if (client?.name === "seasons.json") return [{ id: "season-2026", year: 2026, active: true }];
      if (client?.name === "pilots/p1.json") return {
        id: "p1",
        coachType: "None",
        pilotRating: "Pilot",
        person: { id: "person-1", firstName: "Test", lastName: "Pilot", fullName: "Test Pilot" },
        profileUpdatedAt: new Date("2026-06-01T00:00:00Z").toISOString(),
        seasonClubs: [{ seasonYear: 2026, clubId: "c1", clubName: "C1" }]
      };
      return {};
    });

    const req = { method: "GET", url: "http://localhost/me" };
    const ctx = {};
    const res = await meHandler(req as any, ctx as any);
    
    expect(res.status).toBe(200);
    expect(res.jsonBody.firstLoginOfSeason).toBe(false);
  });
});
